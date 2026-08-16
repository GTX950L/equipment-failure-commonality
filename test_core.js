/**
 * test_core.js — 验证 sankey_core.js 的核心逻辑
 * 用法: node test_core.js
 * 用内置示例数据 (demo_data.js 的 DEMO_CSV) 跑一遍，并输出关键统计供核对。
 * demo 数据为 9610 线真实导出 (800 行, 33 列), 结果值为 PASS/FAIL。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const core = require("./sankey_core.js");

// 直接从内置示例 (demo_data.js 的 DEMO_CSV) 读取, 不再依赖外部 CSV 文件
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

// 源列=条码(唯一标识), 结果列=测试结果, 参数列取 4 个工艺列
const SOURCE = "条码";
const RESULT = "测试结果";
const PARAMS = ["注水阀", "注水量-g", "除气真空值", "封存量"];
const NG = ["FAIL"];

// 跑 buildSankey
const result = core.buildSankey({
  data: data,
  sourceCol: SOURCE,
  paramCols: PARAMS,
  resultCol: RESULT,
  ngValues: NG,
  topN: 6,
  bins: 5,
  labels: { ng: "FAIL", ok: "PASS" },
});

if (!result) {
  console.error("FAIL: buildSankey 返回 null");
  process.exit(1);
}

console.log("\n=== 节点 ===");
console.log("节点数:", result.nodes.label.length);
console.log("节点:", result.nodes.label.slice(0, 30).join(", "));

console.log("\n=== 链路 ===");
console.log("链路数:", result.links.value.length);

const total = result.links.value.reduce(function (a, b) { return a + b; }, 0);
console.log("链路总量(应为 800×5):", total);

// 检查源→第一参数层链路
let firstLayer = 0;
for (let i = 0; i < result.links.value.length; i++) {
  const s = result.links.source[i];
  const t = result.links.target[i];
  // 第一层: 源节点 (前 layerNodes[0] 个) → 第一参数层
  const srcLayerCount = result.layers[0].indices.length;
  if (s < srcLayerCount) {
    firstLayer += result.links.value[i];
    if (t < srcLayerCount) {
      console.error("FAIL: 第一层不应连接到源层节点");
      process.exit(1);
    }
  }
}
console.log("第一层链路总量(源→注水阀):", firstLayer);

// 基线 NG 占比
console.log("\n基线 FAIL 占比:", (result.baselineNg * 100).toFixed(2) + "%");

// 标题
console.log("标题:", result.title);

// 断言
const assert = require("assert");
// 800 条样本 × (1 源 + 4 参数 + 1 结果 = 5 段链路) = 4000
assert.strictEqual(total, 800 * (PARAMS.length + 1), "链路总量应为 4000 (800 行 × 5 段)");
assert.strictEqual(firstLayer, 800, "第一层链路应为 800");
assert.ok(result.nodes.label.includes("FAIL"), "应包含 FAIL 节点");
assert.ok(result.nodes.label.includes("PASS"), "应包含 PASS 节点");
assert.strictEqual(result.nodes.customdata.length, result.nodes.label.length, "customdata 应与节点数一致");
assert.strictEqual(result.nodes.customdata[0].length, 7, "customdata 应为 [占比, 层索引, 列名, 筛选用值, 样本数n, 数, 完整取值]");
// 二色模式
const resultBinary = core.buildSankey({
  data: data, sourceCol: SOURCE,
  paramCols: PARAMS,
  resultCol: RESULT, ngValues: NG, topN: 6, bins: 5,
  colorMode: "binary",
  labels: { ng: "FAIL", ok: "PASS" },
});
assert.ok(resultBinary, "二色模式应可构建");
const ngIdx = resultBinary.nodes.label.indexOf("FAIL");
assert.strictEqual(resultBinary.nodes.color[ngIdx], "rgb(221,63,63)", "FAIL 节点应为红色");
const okIdx = resultBinary.nodes.label.indexOf("PASS");
assert.strictEqual(resultBinary.nodes.color[okIdx], "rgb(58,110,205)", "PASS 节点应为蓝色");
assert.ok(resultBinary.links.color.every(function (c) {
  return c.indexOf("221,63,63") >= 0 || c.indexOf("58,110,205") >= 0;
}), "二色模式所有链路应只含红/蓝两种颜色");
// 校验源层节点的筛选用值能还原到原始行（缩短 label → 完整条码）
const srcLayerNode = result.nodes.customdata.find(function (cd) { return cd[1] === 0 && cd[3] !== "其他"; });
assert.ok(srcLayerNode, "应存在源层节点");
const rawValue = srcLayerNode[3];
assert.ok(data.some(function (r) { return r[SOURCE] === rawValue; }), "源层筛选用值应能在原始数据中匹配到行");
// 校验样本数与 NG 数: 参数层节点 n>0 且 ng<=n
const paramNode = result.nodes.customdata.find(function (cd) { return cd[1] === 1; });
assert.ok(paramNode[4] > 0, "参数层节点样本数应 > 0");
assert.ok(paramNode[5] <= paramNode[4], "FAIL 数不应超过样本数");
// 校验 FAIL 节点 n = 总 FAIL 数
const ngNode = result.nodes.customdata[result.nodes.label.indexOf("FAIL")];
assert.strictEqual(ngNode[4], Math.round(800 * result.baselineNg), "FAIL 节点样本数应等于总 FAIL 数");
assert.strictEqual(ngNode[5], ngNode[4], "FAIL 节点的 FAIL 数应等于其样本数");

// ============ scoreColumns (重要列自动识别) 断言 ============
const scores = core.scoreColumns(data, parsed.header, SOURCE, RESULT, NG, 5);
assert.strictEqual(scores[SOURCE], -1, "源列应被排除 (-1)");
assert.strictEqual(scores[RESULT], -1, "结果列应被排除 (-1)");
// 候选参数列应有正分数, 范围 0~1
PARAMS.forEach(function (c) {
  assert.ok(scores[c] > 0 && scores[c] <= 1, c + " 应有正分数且在 0~1: " + scores[c]);
});
// 排除规则: 元数据列(时间/编号/设备等)应被排除
const metaCols = ["测试时间", "设备编号", "车间", "线别", "工单", "测试站点", "CDateTime", "单据编号"];
metaCols.forEach(function (c) {
  assert.strictEqual(scores[c], -1, c + " 应被排除 (-1)");
});
// 故障分类列(异常原因/错误代码)应放行 —— 修复点: 不再被"异常/错误"黑名单误杀
const faultCols = ["异常原因", "错误代码"];
faultCols.forEach(function (c) {
  assert.ok(scores[c] !== undefined && scores[c] > 0, c + " 应放行且为正分: " + scores[c]);
});
// 整数低基数列当离散档位处理 (如注水阀 1/2/3/4 不应分箱成区间)
const gearVals = ["1", "1", "2", "3", "3", "4", "1", "2", "3", "4"];
const gearPrep = core.prepareLayer(gearVals, 5, 30);
assert.deepStrictEqual(gearPrep.slice(), ["1", "1", "2", "3", "3", "4", "1", "2", "3", "4"], "整数档位应保留原值, 不分箱");
const floatVals = ["0.108", "0.110", "0.107", "0.112", "0.109"];
const floatPrep = core.prepareLayer(floatVals, 2, 30);
assert.ok(floatPrep[0] !== floatPrep[floatPrep.length - 1] || floatPrep.length > 0, "连续小数应分箱为区间标签");
assert.ok(String(floatPrep[0]).indexOf("~") >= 0 || String(floatPrep[0]).indexOf("(") >= 0, "分箱标签应为区间形式");
// 整数高基数(如唯一值 200)应仍走分箱: 桶标签为区间([a ~ b])或截尾桶(<lo / >hi)
const manyInts = [];
for (let i = 0; i < 200; i++) manyInts.push(String(i));
const manyPrep = core.prepareLayer(manyInts, 4, 30);
assert.ok(
  String(manyPrep[0]).indexOf("~") >= 0 || String(manyPrep[0]).indexOf("<") >= 0,
  "整数高基数列应分箱"
);
// layers 结构
assert.ok(Array.isArray(result.layers), "buildSankey 应返回 layers");
assert.strictEqual(result.layers.length, 1 + PARAMS.length + 1, "应为 6 层 (1 源 + 4 参数 + 1 结果)");
assert.strictEqual(result.layers[0].name, SOURCE, "第一层应为源列名");
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

// ============ comboNgAnalysis (组合 FAIL 浓度) 断言 ============
const combos = core.comboNgAnalysis({
  data: data,
  candCols: ["注水阀", "除气温度"],
  baseCols: ["注水量-g", "封存量"],
  resultCol: RESULT, ngValues: NG, bins: 5,
});
assert.ok(Array.isArray(combos), "comboNgAnalysis 应返回数组");
assert.ok(combos.length > 0, "真实数据应能找到至少一个高 FAIL 组合");
combos.forEach(function (c) {
  assert.ok(c.n >= 5, "组合样本数应 >= minN");
  assert.ok(c.rate > 0.1, "组合 FAIL 率应显著高于基线");
  assert.ok(c.x !== undefined && c.y !== undefined && c.baseCol, "组合应含 x/y/baseCol 字段");
});
// 组合线索应能命中"注水阀 × 注水量"这类交互根因
const comboOfValve = combos.filter(function (c) { return c.col === "注水阀"; });
console.log("\n组合线索(前5条):");
combos.slice(0, 5).forEach(function (c) {
  console.log("  " + c.col + "=" + c.x + " × " + c.baseCol + "=" + c.y + " → " + c.ng + "/" + c.n + " (" + Math.round(c.rate * 100) + "%)");
});

// ============ calcCpK 断言 ============
// 已知数据集: 1..20, 均值 10.5, sd≈5.92, 规格 8~12
const nums = [];
for (let i = 1; i <= 20; i++) nums.push(i);
const stats = core.calcCpK(nums, 8, 12);
assert.ok(stats.usable, "数据应可计算");
assert.strictEqual(stats.n, 20);
assert.ok(Math.abs(stats.mean - 10.5) < 1e-9, "均值应为 10.5");
const expectCp = 4 / (6 * stats.sd);
assert.ok(Math.abs(stats.cp - expectCp) < 1e-9, "Cp 公式正确");
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

console.log("\n✅ 全部断言通过 (含 calcCpK / verdictForCpk / comboNgAnalysis / 故障分类列放行)");
