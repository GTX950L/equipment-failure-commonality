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

    // 4. NG 占比（每层每个值）
    function ngRatioOf(list) {
      const map = new Map();
      rows.forEach(function (r, i) {
        const key = list[i];
        const e = map.get(key) || { n: 0, ng: 0 };
        e.n++;
        e.ng += r.isNG;
        map.set(key, e);
      });
      const out = {};
      map.forEach(function (e, k) { out[k] = e.n ? e.ng / e.n : 0; });
      return out;
    }

    const layerNg = [ngRatioOf(srcShort)];
    paramLayers.forEach(function (list) { layerNg.push(ngRatioOf(list)); });
    layerNg.push({ NG: 1, OK: 0 });

    // 5. 染色轴
    const nodeNgRatio = {};
    layerNodes.forEach(function (layer, li) {
      layer.forEach(function (n) {
        nodeNgRatio[n] = layerNg[li][n] === undefined ? 0 : layerNg[li][n];
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
    const nodeColors = allNodes.map(function (n) { return colorForNode(nodeAxis[n]); });

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
        colorL.push(colorForLink(leftAxis[l] === undefined ? 0 : leftAxis[l]));
      });
    });

    // 7. 标题
    const head = srcShort.slice().sort(function (a, b) {
      return (srcCounts.get(a) || 0) - (srcCounts.get(b) || 0);
    }).pop();
    const title = head + " & " + Math.max(0, layerNodes[0].length - 1) + " more";

    return {
      nodes: { label: allNodes, color: nodeColors, ngRatio: allNodes.map(function (n) { return nodeNgRatio[n]; }) },
      links: { source: srcL, target: tgtL, value: valL, color: colorL },
      title: title,
      baselineNg: baselineNg,
    };
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
    ngRatioToColorAxis: ngRatioToColorAxis,
    mixColor: mixColor,
    shortenLabel: shortenLabel,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined" && !global.SankeyCore) {
    global.SankeyCore = api;
  }
})(typeof window !== "undefined" ? window : this);
