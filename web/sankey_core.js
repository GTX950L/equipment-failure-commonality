/**
 * sankey_core.js — 桑基图核心计算逻辑（纯 JS，无 DOM 依赖）
 *
 * 与 Python 版 src/sankey_analysis.py 保持同一套算法：
 *   - 数值列等宽分箱
 *   - 离散列超过最大类别数时，低频合并为「其他」
 *   - 节点/链路按「相对基线 NG 占比」染色（tanh 映射到 [-1,1]）
 *
 * 可在 Node.js 中直接测试：node test_core.js
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 文本工具
  // ---------------------------------------------------------------------
  function shortenLabel(text, prefix, suffix) {
    prefix = prefix || 10;
    suffix = suffix || 6;
    if (text === null || text === undefined) return String(text);
    text = String(text);
    if (text.length <= prefix + suffix + 3) return text;
    return text.slice(0, prefix) + "..." + text.slice(-suffix);
  }

  // ---------------------------------------------------------------------
  // 分隔文本解析（自动识别逗号/制表符/分号，支持引号转义）
  // ---------------------------------------------------------------------
  function detectDelimiter(headerLine) {
    const candidates = [",", "\t", ";"];
    let best = ",";
    let bestCount = -1;
    candidates.forEach(function (d) {
      const count = headerLine.split(d).length;
      if (count > bestCount) {
        bestCount = count;
        best = d;
      }
    });
    return best;
  }

  function parseCell(text) {
    // 去掉首尾空白与引号
    let s = (text || "").trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      s = s.slice(1, -1).replace(/""/g, '"');
    }
    return s;
  }

  function parseDelimited(text) {
    /** 解析 CSV/TSV，返回 { header: string[], rows: string[][] } */
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    // 跳过空行和注释行
    const dataLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      dataLines.push(lines[i]);
    }
    if (dataLines.length === 0) return { header: [], rows: [] };

    const delim = detectDelimiter(dataLines[0]);
    const tokenize = function (line) {
      const cells = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '"') {
            if (line[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQuote = false;
            }
          } else {
            cur += ch;
          }
        } else if (ch === '"') {
          inQuote = true;
        } else if (ch === delim) {
          cells.push(parseCell(cur));
          cur = "";
        } else {
          cur += ch;
        }
      }
      cells.push(parseCell(cur));
      return cells;
    };

    const header = tokenize(dataLines[0]).map(function (h) { return h.trim(); });
    const rows = [];
    for (let i = 1; i < dataLines.length; i++) {
      const cells = tokenize(dataLines[i]);
      if (cells.length > 0 && cells.some(function (c) { return c !== ""; })) {
        rows.push(cells);
      }
    }
    return { header: header, rows: rows };
  }

  // ---------------------------------------------------------------------
  // 类型推断 / 分箱
  // ---------------------------------------------------------------------
  function toNumber(v) {
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim().replace(/,/g, "").replace(/[^\d.eE+-]/g, "");
    if (s === "") return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function isNumericColumn(values, minUnique) {
    /** 数值列：≥80% 可转数字 且 唯一值足够多 */
    minUnique = minUnique || 4;
    if (values.length < 2) return false;
    let numeric = 0;
    const uniq = new Set();
    values.forEach(function (v) {
      const n = toNumber(v);
      if (!isNaN(n)) {
        numeric++;
        uniq.add(n);
      }
    });
    return numeric / values.length >= 0.8 && uniq.size >= minUnique;
  }

  function binNumeric(values, nBins) {
    /** 等宽分箱，与 pandas.cut 行为接近，返回字符串标签 */
    const nums = values.map(toNumber);
    let min = Infinity;
    let max = -Infinity;
    nums.forEach(function (n) {
      if (!isNaN(n)) {
        if (n < min) min = n;
        if (n > max) max = n;
      }
    });
    if (!isFinite(min) || !isFinite(max)) {
      return values.map(function () { return "(空值)"; });
    }
    if (min === max) {
      // 只有一个值，分箱无意义，直接返回原值
      return values.map(function (v) { return String(v); });
    }
    const width = (max - min) / nBins;
    const labels = values.map(function (v) {
      const n = toNumber(v);
      if (isNaN(n)) return "(空值)";
      let idx = Math.floor((n - min) / width);
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      const lo = min + idx * width;
      const hi = lo + width;
      const fmt = function (x) {
        // 最多显示 5 位小数（去掉末尾 0）
        return String(Math.round(x * 1e5) / 1e5);
      };
      return "[" + fmt(lo) + " ~ " + fmt(hi) + "]";
    });
    return labels;
  }

  function collapseLowCardinality(values, maxCardinality) {
    /** 离散列类别数过多时，低频类别合并为「其他」 */
    const counts = new Map();
    values.forEach(function (v) {
      const key = v === "" || v === null || v === undefined ? "(空值)" : String(v);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    if (counts.size <= maxCardinality) {
      return values.map(function (v) {
        return v === "" || v === null || v === undefined ? "(空值)" : String(v);
      });
    }
    const top = Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, maxCardinality - 1)
      .map(function (e) { return e[0]; });
    return values.map(function (v) {
      const key = v === "" || v === null || v === undefined ? "(空值)" : String(v);
      return top.indexOf(key) >= 0 ? key : "其他";
    });
  }

  function prepareLayer(values, nBins, maxCardinality) {
    /** 把一列变成适合做桑基图节点的离散标签 */
    if (isNumericColumn(values)) {
      return binNumeric(values, nBins);
    }
    return collapseLowCardinality(values, maxCardinality);
  }

  // ---------------------------------------------------------------------
  // 颜色
  // ---------------------------------------------------------------------
  function ngRatioToColorAxis(ngRatio, baseline) {
    if (!(baseline > 0)) baseline = 0.5;
    const diff = (ngRatio - baseline) / Math.max(baseline, 0.05);
    return Math.tanh(diff * 1.5);
  }

  function mixColor(colorAxis) {
    colorAxis = Math.max(-1, Math.min(1, colorAxis));
    let r, g, b;
    if (colorAxis >= 0) {
      const t = colorAxis;
      r = Math.round(210 + (230 - 210) * t);
      g = Math.round(210 - 130 * t);
      b = Math.round(210 - 100 * t);
    } else {
      const t = -colorAxis;
      r = Math.round(210 - 60 * t);
      g = Math.round(210 - 40 * t);
      b = Math.round(210 + (230 - 210) * t);
    }
    return [r, g, b];
  }

  function colorForNode(axis) {
    const c = mixColor(axis);
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  function colorForLink(axis) {
    const c = mixColor(axis);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.4)";
  }

  // ---------- JMP 风格二色模式: 以基线 NG 占比为界, 上红下蓝 ----------
  function colorForNodeBinary(axis) {
    return axis >= 0 ? "rgb(221,63,63)" : "rgb(58,110,205)";
  }

  function colorForLinkBinary(axis) {
    return axis >= 0 ? "rgba(221,63,63,0.5)" : "rgba(58,110,205,0.5)";
  }

  // ---------------------------------------------------------------------
  // CPK 过程能力计算
  // ---------------------------------------------------------------------
  function meanStd(values) {
    /** values: 数值数组（已过滤 NaN），返回 {n, mean, sd(样本标准差)} */
    const n = values.length;
    if (n === 0) return { n: 0, mean: NaN, sd: NaN };
    const mean = values.reduce(function (a, b) { return a + b; }, 0) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = values[i] - mean;
      sum += d * d;
    }
    const sd = n > 1 ? Math.sqrt(sum / (n - 1)) : 0;
    return { n: n, mean: mean, sd: sd };
  }

  function calcCpK(values, lsl, usl) {
    /**
     * 计算过程能力指数。lsl / usl 可传 null 表示单侧。
     * 返回 {n, mean, sd, cp, cpk, usable}；数据不足或 σ=0 时 usable=false。
     */
    const clean = values.filter(function (v) { return isFinite(Number(v)); }).map(Number);
    const { n, mean, sd } = meanStd(clean);
    const base = { n: n, mean: mean, sd: sd, cp: null, cpk: null, usable: false };
    if (n < 2 || !(sd > 0)) return base;

    let cp = null;
    let cpk = null;
    if (lsl !== null && lsl !== undefined && usl !== null && usl !== undefined) {
      cp = (usl - lsl) / (6 * sd);
    }
    if (lsl !== null && lsl !== undefined) {
      cpk = (mean - lsl) / (3 * sd);
    }
    if (usl !== null && usl !== undefined) {
      const c = (usl - mean) / (3 * sd);
      cpk = cpk === null ? c : Math.min(cpk, c);
    }
    return { n: n, mean: mean, sd: sd, cp: cp, cpk: cpk, usable: true };
  }

  function verdictForCpk(cpk) {
    /** 判级：与 cpk_calculator.html 保持一致的 A/B/C/D 分级 */
    if (!isFinite(cpk)) return { level: "?", text: "无法判定", color: "#6a737d" };
    if (cpk >= 1.67) return { level: "A", text: "优秀", color: "#1a7f37" };
    if (cpk >= 1.33) return { level: "B", text: "合格", color: "#0969da" };
    if (cpk >= 1.0) return { level: "C", text: "边缘", color: "#bf8700" };
    return { level: "D", text: "不足", color: "#cf222e" };
  }

  // ---------------------------------------------------------------------
  // 核心：构造桑基图
  // ---------------------------------------------------------------------
  function buildSankey(opts) {
    /**
     * opts:
     *   data: object[]           行数据（每行是 { 列名: 值 }）
     *   sourceCol: string        源列
     *   paramCols: string[]      参数列（按顺序）
     *   resultCol: string        结果列
     *   ngValues: string[]       视为 NG 的值（忽略大小写）
     *   topN: number             源列保留数量，其余合并「其他」
     *   bins: number             数值分箱数
     *   maxCardinality: number   离散列最大类别数
     *   labels: object           { ng: 'NG', ok: 'OK' }
     * 返回:
     *   { nodes:{label[],color[],ngRatio[]}, links:{source[],target[],value[],color[]}, title }
     */
    const data = opts.data;
    const sourceCol = opts.sourceCol;
    const paramCols = opts.paramCols;
    const resultCol = opts.resultCol;
    const ngValues = (opts.ngValues || ["NG"]).map(function (v) {
      return String(v).trim().toUpperCase();
    });
    const topN = opts.topN || 6;
    const bins = opts.bins || 5;
    const maxCardinality = opts.maxCardinality || 30;
    const colorMode = opts.colorMode === "binary" ? "binary" : "gradient";
    const LABEL_NG = (opts.labels && opts.labels.ng) || "NG";
    const LABEL_OK = (opts.labels && opts.labels.ok) || "OK";

    if (!data.length || !paramCols.length) {
      return null;
    }

    // 1. 结果二元化
    const rows = data.map(function (r) {
      const raw = String(r[resultCol] === null || r[resultCol] === undefined ? "" : r[resultCol]).trim().toUpperCase();
      return {
        src: String(r[sourceCol] === null || r[sourceCol] === undefined ? "" : r[sourceCol]),
        params: paramCols.map(function (c) {
          return r[c] === null || r[c] === undefined ? "" : r[c];
        }),
        isNG: ngValues.indexOf(raw) >= 0 ? 1 : 0,
      };
    });
    const baselineNg = rows.reduce(function (s, r) { return s + r.isNG; }, 0) / rows.length;

    // 2. 源列 top-N
    const srcCounts = new Map();
    rows.forEach(function (r) {
      srcCounts.set(r.src, (srcCounts.get(r.src) || 0) + 1);
    });
    const topSrc = Array.from(srcCounts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, topN)
      .map(function (e) { return e[0]; });
    const isTop = new Set(topSrc);
    rows.forEach(function (r) {
      if (!isTop.has(r.src)) r.src = "其他";
    });

    // 3. 各层节点
    const srcShort = rows.map(function (r) { return shortenLabel(r.src); });
    const paramLayers = paramCols.map(function (_, i) {
      return prepareLayer(
        rows.map(function (r) { return r.params[i]; }),
        bins,
        maxCardinality
      );
    });

    const layerLists = [srcShort].concat(paramLayers).concat([[LABEL_NG, LABEL_OK]]);
    // 去重 + 排序，保持稳定
    const layerNodes = layerLists.map(function (list) {
      const uniq = Array.from(new Set(list)).sort();
      return uniq;
    });

    // 4. 每层每个值的统计 {ratio, n, ng}（ratio = NG 占比）
    function layerStat(list) {
      const map = new Map();
      rows.forEach(function (r, i) {
        const key = list[i];
        const e = map.get(key) || { n: 0, ng: 0 };
        e.n++;
        e.ng += r.isNG;
        map.set(key, e);
      });
      const out = {};
      map.forEach(function (e, k) {
        out[k] = { ratio: e.n ? e.ng / e.n : 0, n: e.n, ng: e.ng };
      });
      return out;
    }

    const layerStats = [layerStat(srcShort)];
    paramLayers.forEach(function (list) { layerStats.push(layerStat(list)); });
    // 结果层 NG/OK 的统计
    layerStats.push({ NG: { ratio: 1, n: 0, ng: 0 }, OK: { ratio: 0, n: 0, ng: 0 } });
    rows.forEach(function (r) {
      const key = r.isNG ? "NG" : "OK";
      layerStats[layerStats.length - 1][key].n++;
      if (r.isNG) layerStats[layerStats.length - 1][key].ng++;
    });

    // 5. 染色轴
    const nodeNgRatio = {};
    const nodeNgCount = {};   // 每节点 NG 样本数
    const nodeNCount = {};    // 每节点样本数
    layerNodes.forEach(function (layer, li) {
      layer.forEach(function (n) {
        const st = layerStats[li][n];
        nodeNgRatio[n] = st ? st.ratio : 0;
        nodeNgCount[n] = st ? st.ng : 0;
        nodeNCount[n] = st ? st.n : 0;
      });
    });
    const nodeAxis = {};
    Object.keys(nodeNgRatio).forEach(function (n) {
      nodeAxis[n] = ngRatioToColorAxis(nodeNgRatio[n], baselineNg);
    });
    const nodeIndex = {};
    const allNodes = [];
    layerNodes.forEach(function (layer) {
      layer.forEach(function (n) {
        if (!(n in nodeIndex)) {
          nodeIndex[n] = allNodes.length;
          allNodes.push(n);
        }
      });
    });
    const nodeColors = allNodes.map(function (n) {
      return colorMode === "binary" ? colorForNodeBinary(nodeAxis[n]) : colorForNode(nodeAxis[n]);
    });

    // 6. 链路：相邻层两两计数
    const srcL = [], tgtL = [], valL = [], colorL = [];
    const colLists = [srcShort].concat(paramLayers);
    colLists.forEach(function (list, i) {
      const rightList = (i + 1 < colLists.length) ? colLists[i + 1] :
        rows.map(function (r) { return r.isNG ? LABEL_NG : LABEL_OK; });
      const counts = new Map();
      list.forEach(function (l, r) {
        const key = l + "\u0000" + rightList[r];
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      const leftAxis = nodeAxis;
      counts.forEach(function (cnt, key) {
        const idx = key.indexOf("\u0000");
        const l = key.slice(0, idx);
        const rt = key.slice(idx + 1);
        srcL.push(nodeIndex[l]);
        tgtL.push(nodeIndex[rt]);
        valL.push(cnt);
        const axis = leftAxis[l] === undefined ? 0 : leftAxis[l];
        colorL.push(colorMode === "binary" ? colorForLinkBinary(axis) : colorForLink(axis));
      });
    });

    // 7. 标题
    const head = srcShort.slice().sort(function (a, b) {
      return (srcCounts.get(a) || 0) - (srcCounts.get(b) || 0);
    }).pop();
    const title = head + " & " + Math.max(0, layerNodes[0].length - 1) + " more";

    // 节点所属层信息（供"点击节点 → 筛选数据子集"使用）
    // layerCols: 每一层对应的原始列名
    const layerCols = [sourceCol].concat(paramCols).concat([resultCol]);
    const nodeLayerIdx = [];
    const nodeColName = [];
    // 每个节点用于筛选的原始值: 源层用完整值, 参数层用分箱/合并后的标签
    const nodeFilterValue = [];
    // 源层: shortenLabel 之后无法直接匹配原始行, 需要映射回完整值
    const srcShortToRaw = {};
    rows.forEach(function (r) {
      const key = shortenLabel(r.src);
      if (!(key in srcShortToRaw)) srcShortToRaw[key] = r.src;
    });

    layerNodes.forEach(function (layer, li) {
      layer.forEach(function (n) {
        const idx = nodeIndex[n];
        if (nodeLayerIdx[idx] === undefined) {
          nodeLayerIdx[idx] = li;
          nodeColName[idx] = layerCols[li];
          if (li === 0) {
            nodeFilterValue[idx] = srcShortToRaw[n] !== undefined ? srcShortToRaw[n] : n;
          } else {
            nodeFilterValue[idx] = n; // 参数层 / 结果层的标签即可直接匹配
          }
        }
      });
    });

    return {
      nodes: {
        label: allNodes,
        color: nodeColors,
        ngRatio: allNodes.map(function (n) { return nodeNgRatio[n]; }),
        // 每个节点: [NG占比, 层索引, 列名, 筛选用原始值, 样本数n, NG数, 完整取值]
        // 完整取值: 源层是完整 FlowCode; 其余层同 label
        customdata: allNodes.map(function (n, i) {
          return [
            nodeNgRatio[n],
            nodeLayerIdx[i],
            nodeColName[i],
            nodeFilterValue[i],
            nodeNCount[n],
            nodeNgCount[n],
            nodeFilterValue[i],
          ];
        }),
      },
      links: { source: srcL, target: tgtL, value: valL, color: colorL },
      title: title,
      baselineNg: baselineNg,
      // 每层信息: {name: 字段名, indices: 该层节点索引} —— 用于 X 轴层标题
      layers: layerNodes.map(function (layer, li) {
        return {
          name: layerCols[li],
          indices: layer.map(function (n) { return nodeIndex[n]; }),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------
  // 重要列自动识别: 信息增益（相对 NG/OK 结果）
  // ---------------------------------------------------------------------
  function entropy(p) {
    if (!(p > 0) || p >= 1) return 0;
    return -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
  }

  function scoreColumns(data, header, sourceCol, resultCol, ngValues, bins) {
    /**
     * 评估每个候选参数列"区分 NG/OK"的信息增益(0~1)。
     * 返回 { 列名: 分数 }, 排除规则命中的列得 -1。
     * - 数值列: 分箱后按组计算 IG
     * - 离散列: 高基数(唯一值过多)排除, 否则按类别计算 IG
     * - 时间/编号/设备等元数据列: 按列名启发式排除
     */
    bins = bins || 5;
    const ngSet = {};
    (ngValues || []).forEach(function (v) {
      ngSet[String(v).trim().toUpperCase()] = true;
    });
    const n = data.length;
    if (!n) return {};
    const isNg = data.map(function (r) {
      const key = String(r[resultCol] === null || r[resultCol] === undefined ? "" : r[resultCol]).trim().toUpperCase();
      return ngSet[key] ? 1 : 0;
    });
    const ngCount = isNg.reduce(function (a, b) { return a + b; }, 0);
    const baseP = ngCount / n;
    const baseEntropy = entropy(baseP);
    if (!(baseEntropy > 0)) {
      // 结果没有区分度（全 NG 或全 OK），无法用 IG，全部给 0
      const flat = {};
      header.forEach(function (c) { flat[c] = 0; });
      return flat;
    }

    // 元数据列名启发式排除
    const excludeKw = [
      "时间", "时刻", "日期", "time", "date", "cdate", "datetime",
      "编号", "码", "单据", "工单", "批次", "批号", "id", "no", "pcd",
      "user", "name", "设备", "车间", "线别", "部门", "站点", "通道",
      "异常", "错误", "code", "retest", "rework", "复测", "返工", "操作员",
    ];
    const scores = {};
    header.forEach(function (col) {
      if (col === sourceCol || col === resultCol) { scores[col] = -1; return; }
      const low = String(col).toLowerCase();
      if (excludeKw.some(function (k) { return low.indexOf(k) >= 0; })) { scores[col] = -1; return; }

      const vals = data.map(function (r) {
        return r[col] === null || r[col] === undefined ? "" : r[col];
      });
      let labels;
      if (isNumericColumn(vals)) {
        labels = binNumeric(vals, bins);
      } else {
        const uniq = new Set(vals.map(String));
        // 离散列唯一值太多 → 每值一例, 无共性意义, 排除
        if (uniq.size > 40 || uniq.size > n * 0.3) { scores[col] = -1; return; }
        labels = collapseLowCardinality(vals, 30);
      }
      // 信息增益
      const groups = {};
      labels.forEach(function (lab, i) {
        const g = groups[lab] || (groups[lab] = { n: 0, ng: 0 });
        g.n++;
        if (isNg[i]) g.ng++;
      });
      let cond = 0;
      Object.keys(groups).forEach(function (k) {
        const g = groups[k];
        if (g.n > 0) cond += (g.n / n) * entropy(g.ng / g.n);
      });
      scores[col] = baseEntropy > 0 ? (baseEntropy - cond) / baseEntropy : 0;
    });
    return scores;
  }

  // ---------------------------------------------------------------------
  // 导出（浏览器 window 或 Node module）
  // ---------------------------------------------------------------------
  const api = {
    parseDelimited: parseDelimited,
    detectDelimiter: detectDelimiter,
    isNumericColumn: isNumericColumn,
    binNumeric: binNumeric,
    collapseLowCardinality: collapseLowCardinality,
    prepareLayer: prepareLayer,
    buildSankey: buildSankey,
    scoreColumns: scoreColumns,
    entropy: entropy,
    ngRatioToColorAxis: ngRatioToColorAxis,
    mixColor: mixColor,
    colorForNodeBinary: colorForNodeBinary,
    colorForLinkBinary: colorForLinkBinary,
    shortenLabel: shortenLabel,
    meanStd: meanStd,
    calcCpK: calcCpK,
    verdictForCpk: verdictForCpk,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined" && !global.SankeyCore) {
    global.SankeyCore = api;
  }
})(typeof window !== "undefined" ? window : this);
