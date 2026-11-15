import * as math from './math.js';

// Validate the bone array shared by every entry point.
// Bones must be ordered so that a parent always appears before its children.
export function validateBones(bones) {
  if (!Array.isArray(bones) || bones.length === 0) {
    throw new Error('bones must be a non-empty array');
  }
  const names = new Set();
  bones.forEach((bone, i) => {
    if (!bone || typeof bone.name !== 'string' || bone.name.length === 0) {
      throw new Error(`bone ${i} is missing a name`);
    }
    if (names.has(bone.name)) throw new Error(`duplicate bone name: ${bone.name}`);
    names.add(bone.name);
    if (typeof bone.parent !== 'number' || bone.parent < -1 || bone.parent >= i) {
      throw new Error(`bone "${bone.name}" has invalid parent index ${bone.parent} (parents must come first)`);
    }
    if (!Array.isArray(bone.inverseBindMatrix) || bone.inverseBindMatrix.length !== 16) {
      throw new Error(`bone "${bone.name}" is missing a 16-element inverseBindMatrix`);
    }
  });
}

// Rest-pose world transform of each bone, recovered from inverse bind matrices.
export function computeRestWorlds(bones) {
  return bones.map((bone) => math.invert([...bone.inverseBindMatrix]));
}

// Rest-pose local TRS of each bone, derived from the inverse bind matrices.
export function computeRestLocals(bones) {
  const worlds = computeRestWorlds(bones);
  return bones.map((bone, i) => {
    const local =
      bone.parent === -1 ? worlds[i] : math.multiply(math.invert(worlds[bone.parent]), worlds[i]);
    return math.decompose(local);
  });
}

function sampleVec(track, time) {
  const { times, values } = track;
  const stride = values.length / times.length;
  if (time <= times[0]) return values.slice(0, stride);
  if (time >= times[times.length - 1]) return values.slice((times.length - 1) * stride);
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const alpha = span === 0 ? 0 : (time - times[lo]) / span;
  const out = new Array(stride);
  for (let c = 0; c < stride; c++) {
    out[c] = math.lerp(values[lo * stride + c], values[hi * stride + c], alpha);
  }
  return out;
}

function sampleQuat(track, time) {
  const { times, values } = track;
  if (time <= times[0]) return values.slice(0, 4);
  if (time >= times[times.length - 1]) return values.slice((times.length - 1) * 4);
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const alpha = span === 0 ? 0 : (time - times[lo]) / span;
  return math.slerp(values.slice(lo * 4, lo * 4 + 4), values.slice(hi * 4, hi * 4 + 4), alpha);
}

// Local matrix of one bone at a given time: animated TRS when a track exists,
// otherwise the rest-pose local TRS.
export function localMatrixAt(track, restLocal, time) {
  const t = track && track.position ? sampleVec(track.position, time) : restLocal.t;
  const q = track && track.rotation ? sampleQuat(track.rotation, time) : restLocal.q;
  const s = track && track.scale ? sampleVec(track.scale, time) : restLocal.s;
  return math.compose(t, q, s);
}

// World matrices for a skeleton posed by `tracks` ({ boneName: {position, rotation, scale} })
// sampled at `time`. Bones without tracks stay at their rest local transform.
export function evaluateWorldMatrices(bones, tracks, time) {
  const restLocals = computeRestLocals(bones);
  const worlds = new Array(bones.length);
  for (let i = 0; i < bones.length; i++) {
    const track = tracks ? tracks[bones[i].name] : undefined;
    const local = localMatrixAt(track, restLocals[i], time);
    worlds[i] = bones[i].parent === -1 ? local : math.multiply(worlds[bones[i].parent], local);
  }
  return worlds;
}

// Linear blend skinning: out[v] = sum_i w_i * (world_i * ibm_i) * bind_v
export function skinVertices(bindPositions, weights, worldMatrices, inverseBindMatrices) {
  return bindPositions.map((position, v) => {
    const acc = [0, 0, 0];
    for (const { bone, weight } of weights[v]) {
      if (weight === 0) continue;
      const skin = math.multiply(worldMatrices[bone], inverseBindMatrices[bone]);
      const tp = math.transformPoint(skin, position);
      acc[0] += tp[0] * weight;
      acc[1] += tp[1] * weight;
      acc[2] += tp[2] * weight;
    }
    return acc;
  });
}
