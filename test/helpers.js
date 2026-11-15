import * as math from '../src/math.js';
import { evaluateWorldMatrices, skinVertices } from '../src/skeleton.js';

// Deterministic PRNG (LCG) so tests are reproducible.
export function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeBone(name, parentName, parentIndex, local, worlds) {
  const parentWorld = parentName === null ? math.identity() : worlds[parentName];
  const world = math.multiply(parentWorld, local);
  worlds[name] = world;
  return { name, parent: parentIndex, inverseBindMatrix: math.invert(world) };
}

function translation(x, y, z) {
  return math.compose([x, y, z], [0, 0, 0, 1], [1, 1, 1]);
}

// Multi-finger humanoid: 61 bones (spine chain, 9 face bones, two arms with
// five 3-joint fingers each, weapon socket on the right hand, two legs).
export function buildHandCharacter() {
  const locals = new Map();
  const add = (name, parent, offset) => locals.set(name, { parent, offset });

  add('hips', -1, [0, 1.0, 0]);
  add('spine', 'hips', [0, 0.15, 0]);
  add('chest', 'spine', [0, 0.15, 0]);
  add('neck', 'chest', [0, 0.12, 0]);
  add('head', 'neck', [0, 0.1, 0]);
  const face = ['jaw', 'eye.L', 'eye.R', 'brow.L', 'brow.R', 'cheek.L', 'cheek.R', 'lip.T', 'lip.B'];
  face.forEach((name, i) => add(name, 'head', [0.02 * (i - 4), 0.05, 0.08]));

  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    add(`shoulder.${side}`, 'chest', [0.08 * sign, 0.1, 0]);
    add(`arm.${side}`, `shoulder.${side}`, [0.12 * sign, 0, 0]);
    add(`forearm.${side}`, `arm.${side}`, [0.14 * sign, 0, 0]);
    add(`hand.${side}`, `forearm.${side}`, [0.12 * sign, 0, 0]);
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const spread = ['thumb', 'index', 'middle', 'ring', 'pinky'].indexOf(finger) - 2;
      add(`${finger}.01.${side}`, `hand.${side}`, [0.05 * sign, 0.01 * spread, 0.01 * spread]);
      add(`${finger}.02.${side}`, `${finger}.01.${side}`, [0.03 * sign, 0, 0]);
      add(`${finger}.03.${side}`, `${finger}.02.${side}`, [0.025 * sign, 0, 0]);
    }
  }
  add('weapon.R', 'hand.R', [-0.06, -0.02, 0.03]);

  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    add(`thigh.${side}`, 'hips', [0.09 * sign, -0.05, 0]);
    add(`shin.${side}`, `thigh.${side}`, [0, -0.4, 0]);
    add(`foot.${side}`, `shin.${side}`, [0, -0.4, 0]);
    add(`toe.${side}`, `foot.${side}`, [0, -0.05, 0.12]);
  }

  const bones = [];
  const worlds = {};
  const indexOf = new Map();
  for (const [name, { parent, offset }] of locals) {
    const parentIndex = parent === -1 ? -1 : indexOf.get(parent);
    indexOf.set(name, bones.length);
    bones.push(
      makeBone(name, parent === -1 ? null : parent, parentIndex, translation(...offset), worlds),
    );
  }
  return bones;
}

// Simple linear chain of `count` bones (bone.0 -> bone.1 -> ...).
export function buildChain(count, segmentLength = 0.1) {
  const bones = [];
  let world = math.identity();
  for (let i = 0; i < count; i++) {
    world = i === 0 ? math.identity() : math.multiply(world, translation(segmentLength, 0, 0));
    bones.push({ name: `bone.${i}`, parent: i - 1, inverseBindMatrix: math.invert(world) });
  }
  return bones;
}

export function boneIndexByName(bones) {
  return new Map(bones.map((bone, i) => [bone.name, i]));
}

// Deterministic skin weights for the hand character with a mix of influence
// counts, zero-weight entries, one unnormalized vertex and one all-zero vertex.
export function buildHandWeights(bones) {
  const rng = makeRng(1234);
  const indexOf = boneIndexByName(bones);
  const weights = [];
  const bindPositions = [];
  const restWorlds = bones.map((bone) => math.invert([...bone.inverseBindMatrix]));

  for (let i = 0; i < bones.length; i++) {
    const origin = [restWorlds[i][12], restWorlds[i][13], restWorlds[i][14]];
    for (let k = 0; k < 3; k++) {
      bindPositions.push([
        origin[0] + (rng() - 0.5) * 0.04,
        origin[1] + (rng() - 0.5) * 0.04,
        origin[2] + (rng() - 0.5) * 0.04,
      ]);
      const pattern = (i + k) % 4;
      const parent = bones[i].parent;
      const grandparent = parent === -1 ? -1 : bones[parent].parent;
      if (pattern === 0 || parent === -1) {
        weights.push([{ bone: i, weight: 1 }]);
      } else if (pattern === 1) {
        weights.push([
          { bone: i, weight: 0.7 },
          { bone: parent, weight: 0.3 },
        ]);
      } else if (pattern === 2) {
        weights.push([
          { bone: i, weight: 0.6 },
          { bone: parent, weight: 0.4 },
          { bone: i, weight: 0 }, // zero-weight duplicate entry
        ]);
      } else {
        const entries = [
          { bone: i, weight: 0.5 },
          { bone: parent, weight: 0.3 },
        ];
        if (grandparent !== -1) entries.push({ bone: grandparent, weight: 0.15 });
        const great = grandparent === -1 ? -1 : bones[grandparent].parent;
        if (great !== -1) entries.push({ bone: great, weight: 0.05 });
        const total = entries.reduce((sum, { weight }) => sum + weight, 0);
        weights.push(entries.map(({ bone, weight }) => ({ bone, weight: weight / total })));
      }
    }
  }

  // Unnormalized vertex (sums to 2.5) bound to the left hand.
  const handL = indexOf.get('hand.L');
  bindPositions.push([restWorlds[handL][12], restWorlds[handL][13], restWorlds[handL][14]]);
  weights.push([
    { bone: handL, weight: 1.5 },
    { bone: bones[handL].parent, weight: 1.0 },
  ]);

  // All-zero vertex.
  bindPositions.push([0, 0, 0]);
  weights.push([
    { bone: handL, weight: 0 },
    { bone: 0, weight: 0 },
  ]);

  return { weights, bindPositions };
}

// Fair "original" weights for pose-error comparisons: drop zero entries,
// renormalize, and anchor all-zero vertices to the root (same policy the
// merger applies), so only true LOD error is measured.
export function normalizeWeights(weights) {
  return weights.map((vertexWeights) => {
    const entries = vertexWeights.filter(({ weight }) => weight > 0);
    const total = entries.reduce((sum, { weight }) => sum + weight, 0);
    if (total <= 0) return [{ bone: 0, weight: 1 }];
    return entries.map(({ bone, weight }) => ({ bone, weight: weight / total }));
  });
}

// Posed animation for the hand character: bends chest, left arm and fingers.
export function buildHandPose() {
  const q = (axis, angle) => math.axisAngleToQuat(axis, angle);
  const track = (quat) => ({ rotation: { times: [0, 1], values: [...[0, 0, 0, 1], ...quat] } });
  return {
    'chest': track(q([0, 0, 1], 0.4)),
    'shoulder.L': track(q([0, 0, 1], -0.6)),
    'forearm.L': track(q([0, 1, 0], 0.5)),
    'index.01.L': track(q([0, 0, 1], 0.8)),
    'index.02.L': track(q([0, 0, 1], 0.9)),
    'middle.01.L': track(q([0, 0, 1], 0.7)),
    'thigh.L': track(q([1, 0, 0], 0.3)),
  };
}

export function poseError(original, merged, bindPositions, time) {
  const originalWorlds = evaluateWorldMatrices(original.bones, original.tracks, time);
  const mergedWorlds = evaluateWorldMatrices(merged.bones, merged.tracks, time);
  const originalPositions = skinVertices(
    bindPositions,
    original.weights,
    originalWorlds,
    original.bones.map((bone) => bone.inverseBindMatrix),
  );
  const mergedPositions = skinVertices(
    bindPositions,
    merged.weights,
    mergedWorlds,
    merged.bones.map((bone) => bone.inverseBindMatrix),
  );
  let max = 0;
  let sum = 0;
  for (let v = 0; v < bindPositions.length; v++) {
    const dx = originalPositions[v][0] - mergedPositions[v][0];
    const dy = originalPositions[v][1] - mergedPositions[v][1];
    const dz = originalPositions[v][2] - mergedPositions[v][2];
    const dist = Math.hypot(dx, dy, dz);
    max = Math.max(max, dist);
    sum += dist;
  }
  return { max, mean: sum / bindPositions.length };
}
