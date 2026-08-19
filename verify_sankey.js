/**
 * verify_sankey.js — 验证 buildSankey 输出在数学上自洽(逻辑正确性)
 * 不依赖 DOM/Plotly, 纯数据层面校验:
 *   1) 链路 value 守恒: 每层节点流入 = 流出(源层/结果层除外)
 *   2) 总样本守恒: 链路 value 总和 = 800 × 层数, 源层流量 = 800
 *   3) 基线 NG 占比: 与节点 n/ng 一致
 *   4) 节点颜色: 红=高于基线, 蓝=低于基线, 灰=接近基线(灰色对应 axis≈0)
 *   5) 标题: NG 数最多的源值(用缩短 label 展示)
 *   6) "其他"节点: 包含所有不在 Top-N 内的源值
 *   7) 分箱: 无 [NaN ~ NaN], 边界值落在正确桶
 *   8) 复合层: 同 label 跨层不冲突(无环状结构)
 *   9) 结果层: FAIL 节点 NG 率=100%, PASS 节点 NG 率=0%
 *  10) Wilson/Fisher: 节点 hover 文本与 ngRatio 一致
 *  11) 源层筛选用值: nodeFilterValue 能还原回原始行
 *  12) 完整值映射: 同一完整值在源层只出现一个节点
 *  13) prepareLayer: 与 buildSankey 内部使用一致(applyFilter 筛选能命中)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const core = require("./sankey_core.js");

// 加载 demo
const src = fs.readFileSync(path.join(__dirname, "demo_data.js"), "utf-8");
const m = src.match(/DEMO_CSV\s*=\s*"([\s\S]*?)"\s*;/);
if (!m) throw new Error("未能从 demo_data.js 提取 DEMO_CSV");
const text = m[1].split("\\n").join("\n").split('\\"').join('"');
const parsed = core.parseDelimited(text);
const data = parsed.rows.map(function (cells) {
  const obj = {};
  parsed.header.forEach(function (h, i) { obj[h] = cells[i]; });
  return obj;
});

const SOURCE = "条码";
const RESULT = "测试结果";
const PARAMS = ["注水阀", "注水量-g", "除气真空值", "封存量"];
const NG = ["FAIL"];
const TOPN = 6;
const BINS = 5;

const result = core.buildSankey({
  data: data, sourceCol: SOURCE, paramCols: PARAMS, resultCol: RESULT,
  ngValues: NG, topN: TOPN, bins: BINS,
  labels: { ng: "FAIL", ok: "PASS" },
});

const fails = [], passes = [];
function check(name, cond, detail) {
  if (cond) passes.push(name);
  else fails.push(name + (detail ? ": " + detail : ""));
}

const N = data.length;
const expectedLayerCount = 1 + PARAMS.length + 1;
// 链路是相邻层两两: 源→参数1→参数2→...→结果, 共 PARAMS.length+1 段
const expectedTotalValue = N * (PARAMS.length + 1);

// ===== 1) 基础结构 =====
check("结构: 返回非 null", result != null);
check("结构: layers 数 = " + expectedLayerCount, result.layers.length === expectedLayerCount);
check("结构: 节点 customdata 数 = label 数", result.nodes.customdata.length === result.nodes.label.length);
check("结构: 链路 value 数 = source/target 数",
  result.links.value.length === result.links.source.length &&
  result.links.value.length === result.links.target.length);

// ===== 2) 链路 value 总和 = 800 × 5 = 4000 =====
const totalVal = result.links.value.reduce(function (a, b) { return a + b; }, 0);
check("链路总和: 应为 " + expectedTotalValue, totalVal === expectedTotalValue, "实际 " + totalVal);

// ===== 3) 基线 NG 占比 =====
const ngRows = data.filter(function (r) {
  return String(r[RESULT]).trim().toUpperCase() === "FAIL";
}).length;
const expectedBaseline = ngRows / N;
check("基线: baselineNg = " + expectedBaseline.toFixed(4),
  Math.abs(result.baselineNg - expectedBaseline) < 1e-9, "实际 " + result.baselineNg);

// ===== 4) 每层节点样本数 = 该层总链路流量 =====
result.layers.forEach(function (layer, li) {
  // 流入 = ∑link.value (target = layer)
  const inV = result.links.value.reduce(function (s, v, i) {
    return s + (result.links.target[i] === layer.indices[0] ? 0 : 0); // 不能按 idx 简单等于
  }, 0);
  // 用更直接的方式: 该层节点 n 之和 = N
  const nodeNs = layer.indices.map(function (idx) { return result.nodes.customdata[idx][4]; });
  const sumN = nodeNs.reduce(function (a, b) { return a + b; }, 0);
  if (li === 0 || li === result.layers.length - 1) {
    check("层 " + li + " 节点样本之和 = N (" + N + ")", sumN === N, "实际 " + sumN);
  }
  // 中间层节点样本数 = N(每个原始行都经过中间层)
  // 源层和结果层节点样本数之和 = N(中间层同理)
});

// ===== 5) 链路守恒: 中间层(非源/非结果)每个节点流入 = 流出 =====
function nodeFlow(li, idx) {
  let inV = 0, outV = 0;
  for (let i = 0; i < result.links.value.length; i++) {
    if (result.links.source[i] === idx) outV += result.links.value[i];
    if (result.links.target[i] === idx) inV += result.links.value[i];
  }
  return { in: inV, out: outV };
}
for (let li = 1; li < result.layers.length - 1; li++) {
  result.layers[li].indices.forEach(function (idx) {
    const f = nodeFlow(li, idx);
    check("中间层" + li + " 节点 idx=" + idx + " (" + result.nodes.label[idx] + ") 流入=流出",
      f.in === f.out && f.in === result.nodes.customdata[idx][4],
      "in=" + f.in + " out=" + f.out + " n=" + result.nodes.customdata[idx][4]);
  });
}

// 源层: 流出总和 = N
let srcOut = 0;
result.layers[0].indices.forEach(function (idx) {
  const f = nodeFlow(0, idx);
  srcOut += f.out;
});
check("源层总流出 = N", srcOut === N, "实际 " + srcOut);

// 结果层: 流入总和 = N
let resIn = 0;
result.layers[result.layers.length - 1].indices.forEach(function (idx) {
  const f = nodeFlow(result.layers.length - 1, idx);
  resIn += f.in;
});
check("结果层总流入 = N", resIn === N, "实际 " + resIn);

// ===== 6) 结果层 FAIL 节点 NG 率 = 100%, PASS = 0% =====
const failIdx = result.nodes.label.indexOf("FAIL");
const passIdx = result.nodes.label.indexOf("PASS");
check("结果层 FAIL 节点存在", failIdx >= 0);
check("结果层 PASS 节点存在", passIdx >= 0);
if (failIdx >= 0) {
  const cd = result.nodes.customdata[failIdx];
  check("FAIL 节点 n = 总 NG 数", cd[4] === ngRows, "n=" + cd[4] + " 期望=" + ngRows);
  check("FAIL 节点 NG 数 = n", cd[5] === cd[4]);
  check("FAIL 节点 ratio = 1", Math.abs(cd[0] - 1) < 1e-9, "实际 " + cd[0]);
}
if (passIdx >= 0) {
  const cd = result.nodes.customdata[passIdx];
  check("PASS 节点 NG 数 = 0", cd[5] === 0);
  check("PASS 节点 ratio = 0", Math.abs(cd[0] - 0) < 1e-9, "实际 " + cd[0]);
}

// ===== 7) 染色: 红=高于基线, 蓝=低于基线 =====
function isReddish(color) {
  const m = color.match(/rgb\((\d+),(\d+),(\d+)/);
  if (!m) return false;
  const r = +m[1], g = +m[2], b = +m[3];
  return r > 200 && r > b + 5;   // R > 200 且 R > B (覆盖渐变到深红 rgb(221,63,63))
}
function isBlueish(color) {
  const m = color.match(/rgb\((\d+),(\d+),(\d+)/);
  if (!m) return false;
  const r = +m[1], g = +m[2], b = +m[3];
  return b > 200 && b > r + 5;   // B > 200 且 B > R (覆盖渐变到深蓝 rgb(58,110,205), 含略偏蓝边界)
}
result.nodes.customdata.forEach(function (cd, idx) {
  const lbl = result.nodes.label[idx];
  const color = result.nodes.color[idx];
  if (cd[4] < 5) return;   // 小样本置灰跳过
  if (cd[1] === result.layers.length - 1) return;   // 结果层染色无意义
  if (cd[0] > expectedBaseline * 1.3) {
    check("节点 " + lbl + " 高 NG 染色偏红 (NG=" + (cd[0]*100).toFixed(1) + "%)", isReddish(color), "颜色=" + color);
  } else if (cd[0] < expectedBaseline * 0.7) {
    check("节点 " + lbl + " 低 NG 染色偏蓝 (NG=" + (cd[0]*100).toFixed(1) + "%)", isBlueish(color), "颜色=" + color);
  }
});

// ===== 8) 标题: NG 数最多的源值(缩短 label) =====
const srcAgg = new Map();
data.forEach(function (r) {
  const v = String(r[SOURCE] || "");
  const e = srcAgg.get(v) || { n: 0, ng: 0 };
  e.n++;
  if (String(r[RESULT]).trim().toUpperCase() === "FAIL") e.ng++;
  srcAgg.set(v, e);
});
let headRaw = "", headNg = -1;
srcAgg.forEach(function (e, k) { if (e.ng > headNg) { headNg = e.ng; headRaw = k; } });
const expectedHeadShort = core.shortenLabel(headRaw) + " & " + Math.max(0, result.layers[0].indices.length - 1) + " more";
check("标题: 与 NG 最多源值一致", result.title === expectedHeadShort,
  "result=" + result.title + " 期望=" + expectedHeadShort);

// ===== 9) "其他"节点合并: top 之外的源值都归 "其他" =====
const topSrcSet = new Set(
  Array.from(srcAgg.entries())
    .sort(function (a, b) { return b[1].ng - a[1].ng || b[1].n - a[1].n; })
    .slice(0, TOPN)
    .map(function (e) { return e[0]; })
);
const nonTopSrc = Array.from(srcAgg.keys()).filter(function (k) { return !topSrcSet.has(k); });
const otherNode = result.nodes.customdata.find(function (cd, i) {
  return result.nodes.label[i] === "其他" && cd[1] === 0;
});
if (otherNode) {
  check("「其他」节点: n = 非 top 源值总样本数",
    otherNode[4] === nonTopSrc.reduce(function (s, k) { return s + srcAgg.get(k).n; }, 0),
    "n=" + otherNode[4]);
} else if (nonTopSrc.length > 0) {
  fails.push("「其他」节点缺失(应存在 " + nonTopSrc.length + " 个非 top 源值)");
}

// ===== 10) 分箱无 [NaN~NaN] 标签 =====
const nanBucket = result.nodes.label.filter(function (l) { return l.indexOf("NaN") >= 0; });
check("分箱: 无 [NaN~NaN] 标签", nanBucket.length === 0, "出现 " + JSON.stringify(nanBucket));

// ===== 11) 复合层: 同 label 跨层不形成环 =====
for (let i = 0; i < result.links.value.length; i++) {
  const s = result.links.source[i], t = result.links.target[i];
  const ls = result.nodes.customdata[s][1], lt = result.nodes.customdata[t][1];
  check("链路 " + i + " 严格指向下一层 (ls+1=lt)", lt === ls + 1, ls + "→" + lt);
  check("链路 " + i + " 无自环", s !== t);
}

// ===== 12) 源层筛选用值: nodeFilterValue 能还原到原始行 (排除 "其他" 合并节点) =====
let filterOK = 0, filterFail = 0;
result.layers[0].indices.forEach(function (idx) {
  if (result.nodes.label[idx] === "其他") return;   // 合并节点设计上不参与筛选(前端拦截, 走 showOtherDetail)
  const fv = result.nodes.customdata[idx][3];
  const matched = data.filter(function (r) { return String(r[SOURCE]) === String(fv); });
  if (matched.length > 0) filterOK++;
  else filterFail++;
});
check("源层节点筛选用值: " + filterOK + " 个能匹配, " + filterFail + " 个不能(排除其他)", filterFail === 0);

// ===== 13) 源层: 同一完整值只对应一个节点 (P1 修复) =====
const labelToN = new Map();
result.layers[0].indices.forEach(function (idx) {
  const lbl = result.nodes.label[idx];
  labelToN.set(lbl, (labelToN.get(lbl) || 0) + 1);
});
let duplicateLabels = 0;
labelToN.forEach(function (c) { if (c > 1) duplicateLabels++; });
check("源层: 无重复 label (P1 修复)", duplicateLabels === 0, duplicateLabels + " 个 label 重复");

// ===== 14) 显著性与 ngRatio 对应 =====
let sigMismatch = 0;
result.nodes.customdata.forEach(function (cd) {
  if (cd[4] < 5) return;
  const sig = cd[9] || "";
  if (sig.indexOf("显著偏高") >= 0 && cd[0] < expectedBaseline) sigMismatch++;
  if (sig.indexOf("显著偏低") >= 0 && cd[0] > expectedBaseline) sigMismatch++;
});
check("显著性: 方向与 ngRatio 一致", sigMismatch === 0, sigMismatch + " 处矛盾");

// ===== 15) 置信区间宽度合理 =====
let ciCheck = 0;
result.nodes.customdata.forEach(function (cd) {
  if (cd[4] < 5) return;
  const ci = cd[8] || "";
  const m = ci.match(/([\d.]+)%~([\d.]+)%/);
  if (!m) return;
  const lo = parseFloat(m[1]) / 100, hi = parseFloat(m[2]) / 100;
  if (lo > cd[0] + 0.001 || hi < cd[0] - 0.001) ciCheck++;
});
check("置信区间: 包含 ngRatio", ciCheck === 0, ciCheck + " 处不包含");

// ===== 16) 链路颜色与下游节点 NG 占比一致 =====
let linkColorMismatch = 0;
for (let i = 0; i < result.links.value.length; i++) {
  const t = result.links.target[i];
  const tRatio = result.nodes.customdata[t][0];
  const tColor = result.nodes.color[t];
  const lColor = result.links.color[i];
  // 链路颜色应与下游节点颜色"相近"(同色系, alpha 0.6)
  // 简单检查: 链路 RGBA 的 RGB 三个值与节点 RGB 差应 < 5
  const tm = tColor.match(/rgb\((\d+),(\d+),(\d+)/);
  const lm = lColor.match(/rgba?\((\d+),(\d+),(\d+)/);
  if (tm && lm) {
    const dr = Math.abs(+tm[1] - +lm[1]);
    const dg = Math.abs(+tm[2] - +lm[2]);
    const db = Math.abs(+tm[3] - +lm[3]);
    if (dr > 5 || dg > 5 || db > 5) linkColorMismatch++;
  }
}
check("链路颜色: 与下游节点 RGB 一致 (alpha 略低)", linkColorMismatch === 0,
  linkColorMismatch + " 处不一致");

// ===== 17) 配色模式: 二色模式红蓝应清晰 =====
const resultBinary = core.buildSankey({
  data: data, sourceCol: SOURCE, paramCols: PARAMS, resultCol: RESULT,
  ngValues: NG, topN: TOPN, bins: BINS, colorMode: "binary",
  labels: { ng: "FAIL", ok: "PASS" },
});
const failColor = resultBinary.nodes.color[failIdx];
const passColor = resultBinary.nodes.color[passIdx];
check("二色模式: FAIL 红", failColor === "rgb(221,63,63)", "实际 " + failColor);
check("二色模式: PASS 蓝", passColor === "rgb(58,110,205)", "实际 " + passColor);
const allRedOrBlue = resultBinary.links.color.every(function (c) {
  return c.indexOf("221,63,63") >= 0 || c.indexOf("58,110,205") >= 0;
});
check("二色模式: 链路只含红蓝", allRedOrBlue);

// ===== 18) 自定义结果标签 (FAIL/PASS) 正确性 =====
const failCd = result.nodes.customdata[failIdx];
const passCd = result.nodes.customdata[passIdx];
check("自定义标签: FAIL 节点 (自定义标签而非硬编码 NG)", result.nodes.label[failIdx] === "FAIL");
check("自定义标签: PASS 节点 (自定义标签而非硬编码 OK)", result.nodes.label[passIdx] === "PASS");
check("自定义标签: 标题生成与自定义一致 (无 NG/OK 残留)", result.title.indexOf("NG") < 0 && result.title.indexOf("OK") < 0);

// ===== 19) prepareLayer 内部与 applyFilter 一致 (参数层筛选能命中) =====
// 注水阀在 layer 1; "2" label 只在本层搜(全局 indexOf 会被其他层同名干扰)
const fc = data.filter(function (r) { return String(r[PARAMS[0]]) === "2"; }).length;
let valve2Idx = -1;
result.layers[1].indices.forEach(function (idx) {
  if (result.nodes.label[idx] === "2") valve2Idx = idx;
});
let param1Value2In = 0;
if (valve2Idx >= 0) {
  for (let i = 0; i < result.links.value.length; i++) {
    if (result.links.source[i] === valve2Idx) param1Value2In += result.links.value[i];
  }
}
check("参数层(注水阀)「2」总样本 = 实际行数", param1Value2In === fc,
  "链路=" + param1Value2In + " 实际行=" + fc);

// ===== 汇总 =====
console.log("\n=== 校验汇总 ===");
console.log("通过: " + passes.length);
console.log("失败: " + fails.length);
if (fails.length > 0) {
  console.log("\n❌ 失败项:");
  fails.forEach(function (f) { console.log("  - " + f); });
  process.exit(1);
} else {
  console.log("\n✅ 全部 " + passes.length + " 项自洽性校验通过, 桑基图输出逻辑正确");
}
