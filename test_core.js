/**
 * test_core.js — 验证 sankey_core.js 的核心逻辑
 * 用法: node test_core.js
 * 用项目 demo CSV 跑一遍，并输出关键统计供核对。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const core = require("./sankey_core.js");

// 读 demo CSV
const csvPath = path.join(__dirname, "..", "data", "demo_equipment_issues.csv");
const text = fs.readFileSync(csvPath, "utf-8");
const parsed = core.parseDelimited(text);

console.log("表头:", parsed.header.join(" | "));
console.log("行数:", parsed.rows.length);

// 转成 object 数组
const data = parsed.rows.map(function (cells) {
  const obj = {};
  parsed.header.forEach(function (h, i) { obj[h] = cells[i]; });
  return obj;
});

// 跑 buildSankey
const result = core.buildSankey({
  data: data,
  sourceCol: "FlowCode",
  paramCols: ["注水阀", "注水量_g", "扬水通量", "肘存量"],
  resultCol: "判定结果",
  ngValues: ["NG"],
  topN: 6,
  bins: 5,
});

if (!result) {
  console.error("FAIL: buildSankey 返回 null");
  process.exit(1);
}

console.log("\n=== 节点 ===");
console.log("节点数:", result.nodes.label.length);
console.log("节点:", result.nodes.label.join(", "));

console.log("\n=== 链路 ===");
console.log("链路数:", result.links.value.length);

const total = result.links.value.reduce(function (a, b) { return a + b; }, 0);
console.log("链路总量(应为 800):", total);

// 检查源→阀门 第一层链路
let firstLayer = 0;
for (let i = 0; i < result.links.value.length; i++) {
  const s = result.links.source[i];
  const t = result.links.target[i];
  // 第一层: 源节点 (前 layerNodes[0] 个) → 阀门
  if (s < 7) { // top6 + 其他
    firstLayer += result.links.value[i];
    if (t < 7) {
      console.error("FAIL: 第一层不应连接到源层节点");
      process.exit(1);
    }
  }
}
console.log("第一层链路总量(源→阀门):", firstLayer);

// 基线 NG 占比
console.log("\n基线 NG 占比:", (result.baselineNg * 100).toFixed(2) + "%");

// 标题
console.log("标题:", result.title);

// 断言
const assert = require("assert");
// 800 条样本 × 5 层链路 = 4000
assert.strictEqual(total, 800 * 5, "链路总量应为 4000 (800 行 × 5 层)");
assert.strictEqual(firstLayer, 800, "第一层链路应为 800");
assert.ok(result.nodes.label.includes("NG"), "应包含 NG 节点");
assert.ok(result.nodes.label.includes("OK"), "应包含 OK 节点");
assert.strictEqual(result.nodes.customdata.length, result.nodes.label.length, "customdata 应与节点数一致");
assert.strictEqual(result.nodes.customdata[0].length, 4, "customdata 应为 [NG占比, 层索引, 列名, 筛选用原始值]");
// 校验源层节点的筛选用值能还原到原始行（缩短 label → 完整 FlowCode）
const srcLayerNode = result.nodes.customdata.find(function (cd) { return cd[1] === 0 && cd[3] !== "其他"; });
assert.ok(srcLayerNode, "应存在源层节点");
const rawValue = srcLayerNode[3];
assert.ok(data.some(function (r) { return r.FlowCode === rawValue; }), "源层筛选用值应能在原始数据中匹配到行");

// ============ calcCpK 断言 ============
// 已知数据集: 手工构造 均值=10, σ≈1, 规格 8~12 → Cp=Cpk≈0.67
const nums = [];
for (let i = 1; i <= 20; i++) nums.push(i); // 1..20, 均值 10.5, sd≈5.92
const stats = core.calcCpK(nums, 8, 12);
assert.ok(stats.usable, "数据应可计算");
assert.strictEqual(stats.n, 20);
// 验证均值
assert.ok(Math.abs(stats.mean - 10.5) < 1e-9, "均值应为 10.5");
// σ 手算: sqrt(sum((x-10.5)^2)/19)
// Cp = (12-8)/(6σ)
const expectCp = 4 / (6 * stats.sd);
assert.ok(Math.abs(stats.cp - expectCp) < 1e-9, "Cp 公式正确");
// Cpk = min((12-10.5)/(3σ), (10.5-8)/(3σ))
const expectCpk = Math.min((12 - 10.5) / (3 * stats.sd), (10.5 - 8) / (3 * stats.sd));
assert.ok(Math.abs(stats.cpk - expectCpk) < 1e-9, "Cpk 公式正确");

// 单侧: 只有 LSL
const oneSided = core.calcCpK(nums, 8, null);
assert.strictEqual(oneSided.cp, null, "单侧时 Cp 应为 null");
assert.ok(oneSided.cpk > 0, "单侧 Cpk 应可算");
assert.strictEqual(oneSided.cpk, (10.5 - 8) / (3 * oneSided.sd), "单侧 Cpk 公式正确");

// 判级
assert.strictEqual(core.verdictForCpk(0.8).level, "D");
assert.strictEqual(core.verdictForCpk(1.2).level, "C");
assert.strictEqual(core.verdictForCpk(1.5).level, "B");
assert.strictEqual(core.verdictForCpk(2.0).level, "A");

console.log("✅ 全部断言通过 (含 calcCpK / verdictForCpk)");

console.log("\n✅ 全部断言通过");
