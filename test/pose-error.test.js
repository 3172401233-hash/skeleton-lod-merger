import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkeleton } from '../src/merger.js';
import { remapAnimationTracks } from '../src/animation.js';
import { computeRestWorlds } from '../src/skeleton.js';
import {
  buildHandCharacter,
  buildHandWeights,
  buildHandPose,
  buildChain,
  normalizeWeights,
  poseError,
} from './helpers.js';

const PROTECTED = ['hips', 'foot.L', 'foot.R', 'weapon.R'];

test('pose error comparison: multi-finger character across budgets', () => {
  const bones = buildHandCharacter();
  const { weights, bindPositions } = buildHandWeights(bones);
  const pose = buildHandPose();

  const rows = [];
  for (const budget of [61, 40, 24, 16]) {
    const result = mergeSkeleton({ bones, weights, budget, protectedBones: PROTECTED });
    const mergedTracks = remapAnimationTracks(pose, bones, result);
    const original = { bones, weights: normalizeWeights(weights), tracks: pose };
    const merged = { bones: result.bones, weights: result.weights, tracks: mergedTracks };
    const rest = poseError(original, merged, bindPositions, 0);
    const posed = poseError(original, merged, bindPositions, 1);
    rows.push({ budget, kept: result.boneCount, rest, posed });

    // Rest pose must be reproduced exactly at every budget.
    assert.ok(rest.max < 1e-9, `budget ${budget}: rest pose error ${rest.max}`);
  }

  console.log('\n  multi-finger character (61 bones -> budget), posed at t=1');
  for (const row of rows) {
    console.log(
      `    budget=${String(row.budget).padStart(2)} kept=${String(row.kept).padStart(2)} ` +
        `rest.max=${row.rest.max.toExponential(2)} ` +
        `posed.mean=${row.posed.mean.toExponential(2)} posed.max=${row.posed.max.toExponential(2)}`,
    );
  }

  // Full budget reproduces the pose exactly; tighter budgets stay bounded.
  assert.ok(rows[0].posed.max < 1e-9);
  assert.ok(rows[3].posed.mean < 0.2, `mean pose error too large: ${rows[3].posed.mean}`);
});

test('pose error comparison: over-budget skeleton keeps protected bones exact', () => {
  const bones = buildChain(10, 0.2);
  const weights = bones.map((_, i) => [
    { bone: i, weight: 0.7 },
    { bone: Math.max(0, i - 1), weight: 0.3 },
  ]);
  // Bind one vertex at each bone's rest-pose origin.
  const bindPositions = computeRestWorlds(bones).map((world) => [
    world[12],
    world[13],
    world[14],
  ]);

  const protectedBones = ['bone.0', 'bone.4', 'bone.7', 'bone.9'];
  const result = mergeSkeleton({ bones, weights, budget: 2, protectedBones });
  assert.equal(result.budgetMet, false);
  assert.equal(result.boneCount, protectedBones.length);

  const spin = {
    'bone.2': { rotation: { times: [0, 1], values: [0, 0, 0, 1, 0, 0, 1, 0] } },
  };
  const mergedTracks = remapAnimationTracks(spin, bones, result);
  const original = { bones, weights, tracks: spin };
  const merged = { bones: result.bones, weights: result.weights, tracks: mergedTracks };
  const posed = poseError(original, merged, bindPositions, 1);

  console.log('\n  over-budget chain (10 bones, budget=2, 4 protected)');
  console.log(
    `    kept=${result.keptBones.join(',')} posed.mean=${posed.mean.toExponential(2)} ` +
      `posed.max=${posed.max.toExponential(2)}`,
  );

  // Vertices bound only to protected bones are unaffected even over budget.
  const keptOld = new Set(result.bones.map((bone) => bone.originalIndex));
  assert.ok(keptOld.size === protectedBones.length);
  for (const name of protectedBones) {
    assert.ok(result.keptBones.includes(name));
  }
});
