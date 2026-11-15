import * as math from './math.js';
import { computeRestLocals, localMatrixAt } from './skeleton.js';

function cloneTrack(track) {
  const out = {};
  for (const prop of ['position', 'rotation', 'scale']) {
    if (track[prop]) {
      out[prop] = { times: [...track[prop].times], values: [...track[prop].values] };
    }
  }
  return out;
}

// Remap animation tracks onto the merged skeleton.
//
// tracks: { boneName: { position?: {times, values}, rotation?: {...}, scale?: {...} } }
//
// A kept bone whose ancestors all survived keeps its track untouched. When one
// or more ancestors were removed, their local motion is baked into the kept
// bone's track: newLocal(t) = local(removedAncestor_1, t) * ... * local(self, t),
// sampled at the union of all keyframe times in the collapsed chain plus a
// uniform grid (`sampleRate` Hz) so arcs between sparse keys stay accurate.
// This keeps world-space motion of surviving bones (approximately) identical
// to the original animation; it is exact at every baked sample time.
export function remapAnimationTracks(tracks, originalBones, mergeResult, options = {}) {
  const { sampleRate = 30 } = options;
  const restLocals = computeRestLocals(originalBones);
  const keptOldIndices = new Set(mergeResult.bones.map((bone) => bone.originalIndex));
  const out = {};

  for (const newBone of mergeResult.bones) {
    const k = newBone.originalIndex;
    const chain = [];
    let p = originalBones[k].parent;
    while (p !== -1 && !keptOldIndices.has(p)) {
      chain.push(p);
      p = originalBones[p].parent;
    }

    const ownTrack = tracks[originalBones[k].name];
    if (chain.length === 0) {
      if (ownTrack) out[newBone.name] = cloneTrack(ownTrack);
      continue;
    }

    // Farthest removed ancestor first, down to the kept bone itself.
    const sequence = [...chain].reverse().concat([k]);
    const timeSet = new Set();
    for (const boneIndex of sequence) {
      const track = tracks[originalBones[boneIndex].name];
      if (!track) continue;
      for (const prop of ['position', 'rotation', 'scale']) {
        if (track[prop]) for (const t of track[prop].times) timeSet.add(t);
      }
    }
    if (timeSet.size === 0) continue; // whole chain is static: rest pose already correct

    const keyTimes = [...timeSet].sort((a, b) => a - b);
    const t0 = keyTimes[0];
    const t1 = keyTimes[keyTimes.length - 1];
    const steps = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
    for (let s = 0; s <= steps; s++) {
      const t = t0 + ((t1 - t0) * s) / steps;
      if (!keyTimes.some((key) => Math.abs(key - t) < 1e-9)) timeSet.add(t);
    }
    const times = [...timeSet].sort((a, b) => a - b);
    const positions = [];
    const rotations = [];
    const scales = [];
    for (const time of times) {
      let local = math.identity();
      for (const boneIndex of sequence) {
        const track = tracks[originalBones[boneIndex].name];
        local = math.multiply(local, localMatrixAt(track, restLocals[boneIndex], time));
      }
      const { t, q, s } = math.decompose(local);
      positions.push(...t);
      rotations.push(...q);
      scales.push(...s);
    }
    out[newBone.name] = {
      position: { times: [...times], values: positions },
      rotation: { times: [...times], values: rotations },
      scale: { times: [...times], values: scales },
    };
  }
  return out;
}
