import { validateBones } from './skeleton.js';

// Merge a skinned skeleton down to a bone budget.
//
// options:
//   bones           [{ name, parent, inverseBindMatrix }] parents ordered before children
//   weights         per-vertex arrays of { bone, weight } (bone = index into `bones`)
//   budget          maximum number of bones in the output skeleton
//   protectedBones  names or indices that must survive (roots, feet, weapon sockets, ...)
//   maxInfluences   optional per-vertex influence cap applied after remapping
//
// Merging only ever collapses a bone into its nearest surviving ancestor, so
// disconnected hierarchies and left/right limbs can never bleed into each other.
export function mergeSkeleton(options) {
  const { bones, weights, budget, protectedBones = [], maxInfluences = Infinity } = options;
  validateBones(bones);
  if (!Array.isArray(weights)) throw new Error('weights must be an array');
  if (!Number.isInteger(budget) || budget < 1) throw new Error('budget must be a positive integer');
  if (!(maxInfluences >= 1)) throw new Error('maxInfluences must be >= 1');

  const n = bones.length;
  const nameToIndex = new Map(bones.map((bone, i) => [bone.name, i]));

  const protectedIdx = new Set();
  for (const entry of protectedBones) {
    const i = typeof entry === 'number' ? entry : nameToIndex.get(entry);
    if (i === undefined || i < 0 || i >= n) {
      throw new Error(`unknown protected bone: ${entry}`);
    }
    protectedIdx.add(i);
  }

  // Total skin influence per bone; drives the greedy removal order.
  const importance = new Float64Array(n);
  for (const vertexWeights of weights) {
    for (const { bone, weight } of vertexWeights) {
      if (bone < 0 || bone >= n) throw new Error(`weight references invalid bone index ${bone}`);
      importance[bone] += weight;
    }
  }

  const alive = new Array(n).fill(true);
  const currentParent = bones.map((bone) => bone.parent);
  const childCount = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (currentParent[i] !== -1) childCount[currentParent[i]]++;
  }
  let aliveCount = n;

  // Greedy, deterministic: remove the lowest-importance removable bone first.
  // Ties prefer leaf bones (redundant end bones collapse before interior
  // joints), then the lowest bone index, so repeated runs are identical.
  while (aliveCount > budget) {
    let best = -1;
    let bestImportance = Infinity;
    let bestChildCount = Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i] || protectedIdx.has(i) || currentParent[i] === -1) continue;
      if (
        importance[i] < bestImportance ||
        (importance[i] === bestImportance && childCount[i] < bestChildCount)
      ) {
        best = i;
        bestImportance = importance[i];
        bestChildCount = childCount[i];
      }
    }
    if (best === -1) break; // nothing removable left: budget cannot be met
    alive[best] = false;
    aliveCount--;
    childCount[currentParent[best]] += childCount[best] - 1;
    for (let c = 0; c < n; c++) {
      if (alive[c] && currentParent[c] === best) currentParent[c] = currentParent[best];
    }
  }

  // Old index -> old index of the nearest surviving ancestor (or itself).
  const remapTarget = new Array(n);
  for (let i = 0; i < n; i++) {
    if (alive[i]) {
      remapTarget[i] = i;
      continue;
    }
    let p = bones[i].parent;
    while (p !== -1 && !alive[p]) p = bones[p].parent;
    remapTarget[i] = p;
  }

  // Build the reduced skeleton, preserving original bone order.
  const oldToNew = new Array(n).fill(-1);
  const newBones = [];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    oldToNew[i] = newBones.length;
    let p = bones[i].parent;
    while (p !== -1 && !alive[p]) p = bones[p].parent;
    newBones.push({
      name: bones[i].name,
      parent: p === -1 ? -1 : oldToNew[p],
      inverseBindMatrix: [...bones[i].inverseBindMatrix],
      originalIndex: i,
    });
  }

  // Remap and renormalize skin weights.
  const firstRoot = newBones.findIndex((bone) => bone.parent === -1);
  const newWeights = weights.map((vertexWeights) => {
    const acc = new Map();
    for (const { bone, weight } of vertexWeights) {
      if (!weight) continue; // drop zero-weight influences
      const target = oldToNew[remapTarget[bone]];
      acc.set(target, (acc.get(target) ?? 0) + weight);
    }
    let entries = [...acc.entries()];
    let total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) {
      // Vertex with no usable weights: anchor it to the root so it stays normalized.
      entries = [[firstRoot, 1]];
      total = 1;
    }
    entries = entries.map(([bone, w]) => [bone, w / total]);
    if (entries.length > maxInfluences) {
      entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      entries = entries.slice(0, maxInfluences);
      const kept = entries.reduce((sum, [, w]) => sum + w, 0);
      entries = entries.map(([bone, w]) => [bone, w / kept]);
    }
    entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return entries.map(([bone, weight]) => ({ bone, weight }));
  });
  const influenceCounts = newWeights.map((vertexWeights) => vertexWeights.length);

  const boneMap = {};
  const animationMap = {};
  for (let i = 0; i < n; i++) {
    const targetName = bones[remapTarget[i]].name;
    boneMap[bones[i].name] = targetName;
    animationMap[bones[i].name] = targetName;
  }

  return {
    bones: newBones,
    weights: newWeights,
    influenceCounts,
    boneMap,
    animationMap,
    remapTarget,
    oldToNew,
    removedBones: bones.filter((_, i) => !alive[i]).map((bone) => bone.name),
    keptBones: newBones.map((bone) => bone.name),
    boneCount: newBones.length,
    budgetMet: newBones.length <= budget,
  };
}
