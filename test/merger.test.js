import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkeleton } from '../src/merger.js';
import { remapAnimationTracks } from '../src/animation.js';
import { evaluateWorldMatrices, skinVertices } from '../src/skeleton.js';
import {
  buildHandCharacter,
  buildHandWeights,
  buildHandPose,
  buildChain,
  boneIndexByName,
  normalizeWeights,
  poseError,
} from './helpers.js';

const PROTECTED = ['hips', 'foot.L', 'foot.R', 'weapon.R'];

function isAncestor(bones, ancestor, descendant) {
  let p = bones[descendant].parent;
  while (p !== -1) {
    if (p === ancestor) return true;
    p = bones[p].parent;
  }
  return false;
}

test('multi-finger character merges down to budget and keeps protected bones', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const result = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });

  assert.equal(result.budgetMet, true);
  assert.ok(result.boneCount <= 24, `expected <= 24 bones, got ${result.boneCount}`);
  assert.ok(result.boneCount < bones.length);
  for (const name of PROTECTED) {
    assert.ok(result.keptBones.includes(name), `protected bone ${name} must survive`);
  }
});

test('removed bones only ever merge into their own ancestors', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const result = mergeSkeleton({ bones, weights, budget: 20, protectedBones: PROTECTED });

  for (let i = 0; i < bones.length; i++) {
    const target = result.remapTarget[i];
    if (target === i) continue;
    assert.ok(
      isAncestor(bones, target, i),
      `${bones[i].name} merged into non-ancestor ${bones[target].name}`,
    );
  }
  // Specifically: nothing from the left side may map to the right side or vice versa.
  for (const [from, to] of Object.entries(result.boneMap)) {
    const fromSide = from.endsWith('.L') ? 'L' : from.endsWith('.R') ? 'R' : null;
    const toSide = to.endsWith('.L') ? 'L' : to.endsWith('.R') ? 'R' : null;
    if (fromSide && toSide) assert.equal(fromSide, toSide, `${from} -> ${to} crosses sides`);
  }
});

test('weights are renormalized, zero weights dropped, influence counts reported', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const result = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });

  assert.equal(result.weights.length, weights.length);
  assert.equal(result.influenceCounts.length, weights.length);
  result.weights.forEach((vertexWeights, v) => {
    assert.ok(vertexWeights.length >= 1, `vertex ${v} has no influences`);
    const sum = vertexWeights.reduce((acc, { weight }) => acc + weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `vertex ${v} weights sum to ${sum}`);
    for (const { bone, weight } of vertexWeights) {
      assert.ok(weight > 0, `vertex ${v} still has a zero weight`);
      assert.ok(bone >= 0 && bone < result.boneCount);
    }
    assert.equal(result.influenceCounts[v], vertexWeights.length);
  });

  // The all-zero vertex (last one) is anchored to the root with weight 1.
  const last = result.weights[result.weights.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].weight, 1);
  assert.equal(result.bones[last[0].bone].parent, -1);
});

test('maxInfluences caps per-vertex influences and renormalizes', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const result = mergeSkeleton({
    bones,
    weights,
    budget: 24,
    protectedBones: PROTECTED,
    maxInfluences: 2,
  });
  for (const count of result.influenceCounts) assert.ok(count <= 2);
  for (const vertexWeights of result.weights) {
    const sum = vertexWeights.reduce((acc, { weight }) => acc + weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test('merging is deterministic across runs', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const a = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });
  const b = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });
  assert.deepEqual(a, b);
});

test('chain skeleton: end bones collapse first, weights move to kept ancestors', () => {
  const bones = buildChain(12);
  const weights = bones.map((_, i) => [
    { bone: i, weight: 0.6 },
    { bone: Math.max(0, i - 1), weight: 0.4 },
  ]);
  const result = mergeSkeleton({ bones, weights, budget: 4, protectedBones: [] });

  assert.equal(result.boneCount, 4);
  assert.equal(result.keptBones[0], 'bone.0'); // root always survives
  const indexOf = boneIndexByName(bones);
  // Every removed bone remaps to a kept ancestor on the same chain.
  for (const name of result.removedBones) {
    const target = result.boneMap[name];
    assert.ok(result.keptBones.includes(target));
    assert.ok(indexOf.get(target) < indexOf.get(name));
  }
  for (const vertexWeights of result.weights) {
    const sum = vertexWeights.reduce((acc, { weight }) => acc + weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test('over-budget: protected set larger than budget is kept, budgetMet is false', () => {
  const bones = buildChain(10);
  const weights = bones.map((_, i) => [{ bone: i, weight: 1 }]);
  const protectedBones = ['bone.0', 'bone.3', 'bone.6', 'bone.9'];
  const result = mergeSkeleton({ bones, weights, budget: 2, protectedBones });

  assert.equal(result.budgetMet, false);
  for (const name of protectedBones) {
    assert.ok(result.keptBones.includes(name), `protected ${name} must survive over-budget`);
  }
  // Only the protected bones survive: the budget cannot be met.
  assert.equal(result.boneCount, protectedBones.length);
  assert.deepEqual([...result.keptBones].sort(), [...protectedBones].sort());
});

test('rest pose is preserved exactly after merging', () => {
  const bones = buildHandCharacter();
  const { weights, bindPositions } = buildHandWeights(bones);
  const result = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });
  const mergedTracks = remapAnimationTracks({}, bones, result);

  const { max } = poseError(
    { bones, weights: normalizeWeights(weights), tracks: {} },
    { bones: result.bones, weights: result.weights, tracks: mergedTracks },
    bindPositions,
    0,
  );
  assert.ok(max < 1e-9, `rest pose error ${max}`);
});

test('baked animation preserves world transforms of kept bones', () => {
  const bones = buildHandCharacter();
  const { weights } = buildHandWeights(bones);
  const pose = buildHandPose();
  const result = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });
  const mergedTracks = remapAnimationTracks(pose, bones, result);

  const indexOf = boneIndexByName(bones);
  // Exact at baked sample times; bounded interpolation error between them.
  const cases = [
    [0, 1e-9],
    [0.25, 1e-3],
    [0.5, 1e-9],
    [0.75, 1e-3],
    [1, 1e-9],
  ];
  for (const [time, tolerance] of cases) {
    const originalWorlds = evaluateWorldMatrices(bones, pose, time);
    const mergedWorlds = evaluateWorldMatrices(result.bones, mergedTracks, time);
    for (const newBone of result.bones) {
      const original = originalWorlds[indexOf.get(newBone.name)];
      const merged = mergedWorlds[result.bones.indexOf(newBone)];
      for (let k = 0; k < 16; k++) {
        assert.ok(
          Math.abs(original[k] - merged[k]) < tolerance,
          `${newBone.name} world matrix diverges at t=${time}`,
        );
      }
    }
  }
});

test('vertices fully bound to kept bones have zero pose error', () => {
  const bones = buildHandCharacter();
  const { weights, bindPositions } = buildHandWeights(bones);
  const pose = buildHandPose();
  const result = mergeSkeleton({ bones, weights, budget: 24, protectedBones: PROTECTED });
  const mergedTracks = remapAnimationTracks(pose, bones, result);

  const keptOld = new Set(result.bones.map((bone) => bone.originalIndex));
  const fullyKept = [];
  weights.forEach((vertexWeights, v) => {
    if (vertexWeights.every(({ bone, weight }) => weight === 0 || keptOld.has(bone))) {
      fullyKept.push(v);
    }
  });
  assert.ok(fullyKept.length > 0);

  const originalWorlds = evaluateWorldMatrices(bones, pose, 1);
  const mergedWorlds = evaluateWorldMatrices(result.bones, mergedTracks, 1);
  const originalIbms = bones.map((bone) => bone.inverseBindMatrix);
  const mergedIbms = result.bones.map((bone) => bone.inverseBindMatrix);

  const originalPositions = skinVertices(
    bindPositions,
    normalizeWeights(weights),
    originalWorlds,
    originalIbms,
  );
  const mergedPositions = skinVertices(
    bindPositions,
    result.weights,
    mergedWorlds,
    mergedIbms,
  );
  for (const v of fullyKept) {
    const dist = Math.hypot(
      originalPositions[v][0] - mergedPositions[v][0],
      originalPositions[v][1] - mergedPositions[v][1],
      originalPositions[v][2] - mergedPositions[v][2],
    );
    assert.ok(dist < 1e-9, `vertex ${v} on kept bones moved by ${dist}`);
  }
});
