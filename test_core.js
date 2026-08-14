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

console.log("\n✅ 全部断言通过");
