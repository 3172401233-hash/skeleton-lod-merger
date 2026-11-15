# skeleton-lod-merger

JavaScript 游戏角色骨骼 LOD 合并库，处理层级压缩、权重重分配和动画映射。

面向远景角色：把保留两百多根面部/手指骨骼的骨架压缩到 GPU 骨骼调色板预算内，
不删除末端骨骼（避免蒙皮权重丢失产生尖刺），而是把低影响骨骼合并进最近的保留祖先。

## 用法

```js
import { mergeSkeleton, remapAnimationTracks } from 'skeleton-lod-merger';

const result = mergeSkeleton({
  bones,            // [{ name, parent, inverseBindMatrix }]，父骨骼必须排在子骨骼前
  weights,          // 每顶点 [{ bone, weight }]，bone 为骨骼索引
  budget: 64,       // 目标骨骼预算
  protectedBones: ['hips', 'foot.L', 'foot.R', 'weapon.R'], // 根/脚底/武器挂点
  maxInfluences: 4, // 可选：每顶点影响数上限
});

// result.bones           合并后的骨架（保留骨骼，parent 已重挂）
// result.weights         重映射并归一化后的蒙皮权重
// result.influenceCounts 每顶点影响数
// result.boneMap         旧骨骼名 -> 合并后骨骼名
// result.animationMap    动画轨道映射（旧轨道名 -> 新轨道名）
// result.removedBones / keptBones / budgetMet

const newTracks = remapAnimationTracks(tracks, bones, result, { sampleRate: 30 });
```

## 合并策略

- **贪心移除**：按骨骼总蒙皮影响（所有顶点权重之和）升序移除；影响相同优先移除
  叶子（冗余末端骨骼），再按骨骼索引决胜，保证确定性。
- **只向祖先合并**：被移除骨骼的权重和子骨骼都并入最近的保留祖先，因此左右肢体、
  断开的层级永远不会互相合并。
- **骨骼保护**：`protectedBones` 中的骨骼（根、脚底、武器挂点等）绝不移除；
  根骨骼天然不可移除（没有可并入的祖先）。预算小于受保护数量时保留全部受保护
  骨骼并返回 `budgetMet: false`。
- **权重归一化**：零权重条目直接丢弃；同一目标的权重累加后每顶点归一化为 1；
  全零顶点锚定到根骨骼（权重 1）；`maxInfluences` 截断保留权重最大的前 K 个
  影响并重新归一化。
- **动画烘焙**：被移除祖先的局部运动会烘焙进保留子骨骼的轨道
  （`newLocal(t) = L(removed_1, t) * ... * L(self, t)`），按关键帧并集加
  `sampleRate` 均匀网格采样，采样点上世界变换与原动画完全一致。

## 测试

```sh
node --test
```

覆盖多指角色、链式骨骼、不同影响数、零权重、超预算场景，检查姿态误差、
权重归一化和确定性，并输出合并前后的姿态误差对比表。
