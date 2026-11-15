import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkeleton } from '../src/merger.js';
import { remapAnimationTracks } from '../src/animation.js';
import { evaluateWorldMatrices } from '../src/skeleton.js';
import * as math from '../src/math.js';
import { buildChain, boneIndexByName } from './helpers.js';

test('removed parent motion is baked into kept child tracks', () => {
  const bones = buildChain(4); // bone.0 .. bone.3
  const weights = bones.map((_, i) => [{ bone: i, weight: 1 }]);
  // Protect the tip so bone.1/bone.2 collapse between root and tip.
  const result = mergeSkeleton({ bones, weights, budget: 2, protectedBones: ['bone.3'] });
  assert.deepEqual(result.removedBones.sort(), ['bone.1', 'bone.2']);

  const spin = math.axisAngleToQuat([0, 0, 1], Math.PI / 2);
  const tracks = {
    'bone.1': { rotation: { times: [0, 1], values: [0, 0, 0, 1, ...spin] } },
    'bone.3': { position: { times: [0.5], values: [0.1, 0, 0] } },
  };
  const remapped = remapAnimationTracks(tracks, bones, result);

  // bone.3 inherited a baked track combining bone.1's rotation and its own motion.
  assert.ok(remapped['bone.3'], 'expected a baked track for bone.3');
  for (const keyTime of [0, 0.5, 1]) {
    assert.ok(
      remapped['bone.3'].rotation.times.some((t) => Math.abs(t - keyTime) < 1e-9),
      `baked track must include key time ${keyTime}`,
    );
  }

  // World transform of the kept tip matches the original animation: exact at
  // baked sample times, bounded interpolation error between them.
  const indexOf = boneIndexByName(bones);
  const cases = [
    [0, 1e-9],
    [0.25, 1e-3],
    [0.5, 1e-9],
    [0.75, 1e-3],
    [1, 1e-9],
  ];
  for (const [time, tolerance] of cases) {
    const originalWorlds = evaluateWorldMatrices(bones, tracks, time);
    const mergedWorlds = evaluateWorldMatrices(result.bones, remapped, time);
    const a = originalWorlds[indexOf.get('bone.3')];
    const b = mergedWorlds[result.keptBones.indexOf('bone.3')];
    for (let k = 0; k < 16; k++) assert.ok(Math.abs(a[k] - b[k]) < tolerance);
  }
});

test('kept bones without removed ancestors keep their original tracks untouched', () => {
  const bones = buildChain(5);
  const weights = bones.map((_, i) => [{ bone: i, weight: 1 }]);
  const result = mergeSkeleton({ bones, weights, budget: 4, protectedBones: ['bone.4'] });
  assert.deepEqual(result.removedBones, ['bone.1']);

  const track = { rotation: { times: [0, 2], values: [0, 0, 0, 1, 0, 0, 1, 0] } };
  const remapped = remapAnimationTracks({ 'bone.4': track }, bones, result);
  assert.deepEqual(remapped['bone.4'], track);
});

test('animationMap covers every original bone', () => {
  const bones = buildChain(6);
  const weights = bones.map((_, i) => [{ bone: i, weight: 1 }]);
  const result = mergeSkeleton({ bones, weights, budget: 3, protectedBones: [] });
  for (const bone of bones) {
    const target = result.animationMap[bone.name];
    assert.ok(result.keptBones.includes(target), `${bone.name} maps to kept bone ${target}`);
  }
});
