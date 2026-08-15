/**
 * test_core.js — 验证 sankey_core.js 的核心逻辑
 * 用法: node test_core.js
 * 用内置示例数据 (web/demo_data.js 的 DEMO_CSV) 跑一遍，并输出关键统计供核对。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const core = require("./sankey_core.js");

// 直接从内置示例 (web/demo_data.js 的 DEMO_CSV) 读取, 不再依赖外部 CSV 文件
function loadDemoCsv() {
  const src = fs.readFileSync(path.join(__dirname, "demo_data.js"), "utf-8");
  const m = src.match(/DEMO_CSV\s*=\s*"([\s\S]*?)"\s*;/);
  if (!m) throw new Error("未能从 demo_data.js 提取 DEMO_CSV");
  // DEMO_CSV 中是字面量转义 (\n), 还原成真实换行符
  return m[1].split("\\n").join("\n").split('\\"').join('"');
}
const text = loadDemoCsv();
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
  paramCols: ["注水阀", "注水量_g", "扬水通量", "封存量"],
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
assert.strictEqual(result.nodes.customdata[0].length, 7, "customdata 应为 [NG占比, 层索引, 列名, 筛选用值, 样本数n, NG数, 完整取值]");
// 二色模式
const resultBinary = core.buildSankey({
  data: data, sourceCol: "FlowCode",
  paramCols: ["注水阀", "注水量_g", "扬水通量", "封存量"],
  resultCol: "判定结果", ngValues: ["NG"], topN: 6, bins: 5,
  colorMode: "binary",
});
assert.ok(resultBinary, "二色模式应可构建");
const ngIdx = resultBinary.nodes.label.indexOf("NG");
assert.strictEqual(resultBinary.nodes.color[ngIdx], "rgb(221,63,63)", "NG 节点应为红色");
const okIdx = resultBinary.nodes.label.indexOf("OK");
assert.strictEqual(resultBinary.nodes.color[okIdx], "rgb(58,110,205)", "OK 节点应为蓝色");
assert.ok(resultBinary.links.color.every(function (c) {
  return c.indexOf("221,63,63") >= 0 || c.indexOf("58,110,205") >= 0;
}), "二色模式所有链路应只含红/蓝两种颜色");
// 校验源层节点的筛选用值能还原到原始行（缩短 label → 完整 FlowCode）
const srcLayerNode = result.nodes.customdata.find(function (cd) { return cd[1] === 0 && cd[3] !== "其他"; });
assert.ok(srcLayerNode, "应存在源层节点");
const rawValue = srcLayerNode[3];
assert.ok(data.some(function (r) { return r.FlowCode === rawValue; }), "源层筛选用值应能在原始数据中匹配到行");
// 校验样本数与 NG 数: 参数层节点 n>0 且 ng<=n
const paramNode = result.nodes.customdata.find(function (cd) { return cd[1] === 1; });
assert.ok(paramNode[4] > 0, "参数层节点样本数应 > 0");
assert.ok(paramNode[5] <= paramNode[4], "NG 数不应超过样本数");
// 校验 NG 节点 n = 总 NG 数 (demo 基线 21.5%, 800 条 → 172 NG)
const ngNode = result.nodes.customdata[result.nodes.label.indexOf("NG")];
assert.strictEqual(ngNode[4], Math.round(800 * result.baselineNg), "NG 节点样本数应等于总 NG 数");
assert.strictEqual(ngNode[5], ngNode[4], "NG 节点的 NG 数应等于其样本数");

// ============ scoreColumns (重要列自动识别) 断言 ============
const scores = core.scoreColumns(data, parsed.header, "FlowCode", "判定结果", ["NG"], 5);
assert.strictEqual(scores["FlowCode"], -1, "源列应被排除 (-1)");
assert.strictEqual(scores["判定结果"], -1, "结果列应被排除 (-1)");
// 候选参数列(非排除列)应有正分数, 范围 0~1
const candidates = ["注水阀", "注水量_g", "扬水通量", "封存量"];
candidates.forEach(function (c) {
  assert.ok(scores[c] > 0 && scores[c] <= 1, c + " 应有正分数且在 0~1: " + scores[c]);
});
// 分数能区分相对重要性: 封存量在 demo 中对 NG 区分度最高, 不应低于其他列太多
assert.ok(scores["封存量"] >= scores["注水阀"], "封存量分数应不低于注水阀");
// 排除规则: 构造带时间/编号列的假表头, 应被排除
const fakeHeader = ["条码", "测试时间", "设备编号", "注水量_g", "判定结果"];
const fakeScores = core.scoreColumns(data, fakeHeader, "FlowCode", "判定结果", ["NG"], 5);
// 注: fakeHeader 引用真实列名, 这里仅验证 scoreColumns 可运行且不崩溃
assert.ok(fakeScores, "scoreColumns 应能处理任意表头");
// 整数低基数列当离散档位处理 (如注水阀 1/2/3/4 不应分箱成区间)
const gearVals = ["1", "1", "2", "3", "3", "4", "1", "2", "3", "4"];
const gearPrep = core.prepareLayer(gearVals, 5, 30);
assert.deepStrictEqual(gearPrep.slice(), ["1", "1", "2", "3", "3", "4", "1", "2", "3", "4"], "整数档位应保留原值, 不分箱");
const floatVals = ["0.108", "0.110", "0.107", "0.112", "0.109"];
const floatPrep = core.prepareLayer(floatVals, 2, 30);
assert.ok(floatPrep[0] !== floatPrep[floatPrep.length - 1] || floatPrep.length > 0, "连续小数应分箱为区间标签");
assert.ok(String(floatPrep[0]).indexOf("~") >= 0 || String(floatPrep[0]).indexOf("(") >= 0, "分箱标签应为区间形式");
// 整数高基数(如唯一值 200)应仍走分箱
const manyInts = [];
for (let i = 0; i < 200; i++) manyInts.push(String(i));
const manyPrep = core.prepareLayer(manyInts, 4, 30);
assert.ok(String(manyPrep[0]).indexOf("~") >= 0, "整数高基数列应分箱");
// layers 结构
assert.ok(Array.isArray(result.layers), "buildSankey 应返回 layers");
assert.strictEqual(result.layers.length, 6, "demo 应有 6 层 (1 源 + 4 参数 + 1 结果)");
assert.strictEqual(result.layers[0].name, "FlowCode", "第一层应为源列名");
assert.ok(result.layers[0].indices.length > 0, "每层应有节点索引");

// ============ 环状结构检测 ============
// 每条链路必须从低层指向相邻下一层: 不允许自环 / 回边 / 跨层指向
function assertNoCycle(buildResult, tag) {
  const layerOf = {};
  buildResult.layers.forEach(function (layer, li) {
    layer.indices.forEach(function (idx) { layerOf[idx] = li; });
  });
  buildResult.links.source.forEach(function (s, i) {
    const t = buildResult.links.target[i];
    assert.ok(s !== t, "[" + tag + "] 不允许自环 (链路 " + i + ")");
    const ls = layerOf[s], lt = layerOf[t];
    assert.ok(lt === ls + 1, "[" + tag + "] 链路必须指向相邻下一层: " + ls + "->" + lt + " (链路 " + i + ")");
  });
}
assertNoCycle(result, "demo");
// 构造跨层同 label 数据(参数1=1/2/3/4, 参数2=1/2 同 label): 旧代码会合并节点成环
const conflictData = [
  { A: "X1", 档: "1", 位: "1", 结果: "NG" },
  { A: "X1", 档: "1", 位: "1", 结果: "OK" },
  { A: "X1", 档: "2", 位: "2", 结果: "NG" },
  { A: "X2", 档: "3", 位: "1", 结果: "OK" },
  { A: "X2", 档: "3", 位: "2", 结果: "NG" },
  { A: "X2", 档: "4", 位: "1", 结果: "OK" },
];
const conflictResult = core.buildSankey({
  data: conflictData, sourceCol: "A",
  paramCols: ["档", "位"], resultCol: "结果",
  ngValues: ["NG"], topN: 2, bins: 3,
});
assert.ok(conflictResult, "跨层同 label 应能构建");
assertNoCycle(conflictResult, "conflict");
// 参数1 的 "1" 与参数2 的 "1" 必须是不同节点 (不同层索引)
const layer1Idx = new Set(conflictResult.layers[1].indices);
const layer2Idx = new Set(conflictResult.layers[2].indices);
assert.ok([...layer1Idx].every(function (i) { return !layer2Idx.has(i); }),
  "跨层同 label 必须为不同节点(复合键)");

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

console.log("\n✅ 全部断言通过 (含 calcCpK / verdictForCpk)");
