/**
 * sankey_core.js — 桑基图核心计算逻辑（纯 JS，无 DOM 依赖）
 *
 * 纯 JS 实现桑基图核心计算逻辑（浏览器 / Node 通用）：
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
    /**
     * 自适应分箱:
     * - 先做 1%/99% 分位数截尾(Winsorize), 避免极端离群值(如 0 或 2.5 的测量异常)拉宽分箱
     * - 在截尾后的 [lo, hi] 内等宽分箱, 保证正常数据能分开
     * - 小于 lo 的归入下限桶, 大于 hi 的归入上限桶(标为异常区间)
     * 比纯等宽分箱对偏态数据更科学。
     */
    const nums = values.map(toNumber);
    const valid = nums.filter(function (n) { return !isNaN(n); });
    if (!valid.length) {
      return values.map(function () { return "(空值)"; });
    }
    valid.sort(function (a, b) { return a - b; });
    if (valid[valid.length - 1] === valid[0]) {
      // 只有一个值，分箱无意义，直接返回原值
      return values.map(function (v) {
        const n = toNumber(v);
        return isNaN(n) ? "(空值)" : String(v);
      });
    }
    // 1% / 99% 分位数作为截尾边界
    const p1 = valid[Math.max(0, Math.floor(valid.length * 0.01))];
    const p99 = valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.99))];
    const lo = p1, hi = p99;
    const width = (hi - lo) / nBins;
    const fmt = function (x) {
      return String(Math.round(x * 1e5) / 1e5);
    };
    const labels = values.map(function (v) {
      const n = toNumber(v);
      if (isNaN(n)) return "(空值)";
      if (n < lo) return "<" + fmt(lo);              // 低于下限 → 异常低值桶
      if (n > hi) return ">" + fmt(hi);              // 高于上限 → 异常高值桶
      let idx = Math.floor((n - lo) / width);
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      const l2 = lo + idx * width;
      const h2 = l2 + width;
      return "[" + fmt(l2) + " ~ " + fmt(h2) + "]";
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

  // 整数低基数列(如档位 1/2/3/4)当离散处理, 不做连续分箱
  function isIntegerLowCardinality(values, maxCardinality) {
    const uniq = new Set();
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === "" || v === null || v === undefined) continue;
      const n = Number(v);
      if (!isFinite(n) || !Number.isInteger(n)) return false;
      uniq.add(n);
      if (uniq.size > maxCardinality) return false;
    }
    return uniq.size >= 2 && uniq.size <= maxCardinality;
  }

  function prepareLayer(values, nBins, maxCardinality) {
    /** 把一列变成适合做桑基图节点的离散标签 */
    if (isNumericColumn(values)) {
      // 整数档位(1/2/3/4)保留为离散节点, 连续数值才分箱
      if (isIntegerLowCardinality(values, maxCardinality)) {
        return collapseLowCardinality(values, maxCardinality);
      }
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

    // 2. 源列 top-N: 按「NG 数优先、出现次数其次」排序, 保证单独显示的是最有问题的条码
    //    (以前只按出现次数, 唯一值全为 1 时等于随机挑前 N 行, 对"查 NG"没有意义)
    const srcAgg = new Map();  // src -> {n, ng}
    rows.forEach(function (r) {
      const e = srcAgg.get(r.src) || { n: 0, ng: 0 };
      e.n++;
      e.ng += r.isNG;
      srcAgg.set(r.src, e);
    });
    const topSrc = Array.from(srcAgg.entries())
      .sort(function (a, b) {
        if (b[1].ng !== a[1].ng) return b[1].ng - a[1].ng;   // NG 数多的优先
        return b[1].n - a[1].n;                                // 其次出现次数多
      })
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
    // 结果层 NG/OK 的统计 (键用 LABEL_NG/LABEL_OK, 兼容自定义结果标签)
    const resultStat = {};
    resultStat[LABEL_NG] = { ratio: 1, n: 0, ng: 0 };
    resultStat[LABEL_OK] = { ratio: 0, n: 0, ng: 0 };
    layerStats.push(resultStat);
    rows.forEach(function (r) {
      const key = r.isNG ? LABEL_NG : LABEL_OK;
      layerStats[layerStats.length - 1][key].n++;
      if (r.isNG) layerStats[layerStats.length - 1][key].ng++;
    });

    // 5. 染色轴 + 节点索引
    // 关键: 节点索引用「层索引 + 值」复合键, 避免跨层同 label(如"其他"/"1")被合并成同一节点,
    //      否则链路会指回自身/前层, 形成环状结构
    const nodeIndex = {};
    const allNodes = [];
    const nodeKeys = [];
    const nodeNgRatio = {};
    const nodeNgCount = {};   // 每节点 NG 样本数
    const nodeNCount = {};    // 每节点样本数
    const nodeAxis = {};
    layerNodes.forEach(function (layer, li) {
      layer.forEach(function (n) {
        const key = li + "\u0000" + n;
        const st = layerStats[li][n];
        nodeNgRatio[key] = st ? st.ratio : 0;
        nodeNgCount[key] = st ? st.ng : 0;
        nodeNCount[key] = st ? st.n : 0;
        nodeAxis[key] = ngRatioToColorAxis(nodeNgRatio[key], baselineNg);
        if (!(key in nodeIndex)) {
          nodeIndex[key] = allNodes.length;
          allNodes.push(n);
          nodeKeys.push(key);
        }
      });
    });
    const nodeColors = nodeKeys.map(function (k) {
      return colorMode === "binary" ? colorForNodeBinary(nodeAxis[k]) : colorForNode(nodeAxis[k]);
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
      counts.forEach(function (cnt, key) {
        const idx = key.indexOf("\u0000");
        const l = key.slice(0, idx);
        const rt = key.slice(idx + 1);
        srcL.push(nodeIndex[i + "\u0000" + l]);
        tgtL.push(nodeIndex[(i + 1) + "\u0000" + rt]);
        valL.push(cnt);
        // 链路颜色 = 该链路下游(目标节点)的 NG 浓度: 流入 FAIL 的链路红, 流入 PASS 的链路蓝
        const axis = nodeAxis[(i + 1) + "\u0000" + rt] === undefined ? 0 : nodeAxis[(i + 1) + "\u0000" + rt];
        colorL.push(colorMode === "binary" ? colorForLinkBinary(axis) : colorForLink(axis));
      });
    });

    // 7. 标题
    const head = srcShort.slice().sort(function (a, b) {
      return (srcAgg.get(a) || { ng: 0 }).ng - (srcAgg.get(b) || { ng: 0 }).ng;
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
        const idx = nodeIndex[li + "\u0000" + n];
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
        ngRatio: nodeKeys.map(function (k) { return nodeNgRatio[k]; }),
        // 每个节点: [NG占比, 层索引, 列名, 筛选用原始值, 样本数n, NG数, 完整取值]
        // 完整取值: 源层是完整 FlowCode; 其余层同 label
        customdata: nodeKeys.map(function (k, i) {
          return [
            nodeNgRatio[k],
            nodeLayerIdx[i],
            nodeColName[i],
            nodeFilterValue[i],
            nodeNCount[k],
            nodeNgCount[k],
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
          indices: layer.map(function (n) { return nodeIndex[li + "\u0000" + n]; }),
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

  function scoreColumns(data, header, sourceCol, resultCol, ngValues, bins, maxRows) {
    /**
     * 评估每个候选参数列"区分 NG/OK"的信息增益(0~1)。
     * 返回 { 列名: 分数 }, 排除规则命中的列得 -1。
     * - 数值列: 分箱后按组计算 IG
     * - 离散列: 高基数(唯一值过多)排除, 否则按类别计算 IG
     * - 时间/编号/设备等元数据列: 按列名启发式排除
     * maxRows: 大数据集评估采样上限(默认 3000, 保持分布采样)
     */
    bins = bins || 5;
    if (data.length > (maxRows || 3000)) {
      const step = Math.ceil(data.length / (maxRows || 3000));
      data = data.filter(function (_, i) { return i % step === 0; });
    }
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
    // 故障分类列例外: 列名同时含「故障信号词」与「分类特征词」(如 异常原因 / 错误代码 / 不良类别)
    // 这类列是"问题到底出在哪"的直接证据, 不能被黑名单一刀切排除。
    const faultClassKw = ["原因", "代码", "类别", "分类", "说明", "描述", "备注", "类型"];
    const faultSignalKw = ["异常", "错误", "不良", "ng", "fail", "reject", "defect", "缺陷", "rework", "复测"];
    const scores = {};
    header.forEach(function (col) {
      if (col === sourceCol || col === resultCol) { scores[col] = -1; return; }
      const low = String(col).toLowerCase();
      const isFaultClass = faultClassKw.some(function (k) { return low.indexOf(k) >= 0; }) &&
                           faultSignalKw.some(function (k) { return low.indexOf(k) >= 0; });
      if (!isFaultClass && excludeKw.some(function (k) { return low.indexOf(k) >= 0; })) { scores[col] = -1; return; }

      const vals = data.map(function (r) {
        return r[col] === null || r[col] === undefined ? "" : r[col];
      });
      let labels;
      if (isNumericColumn(vals)) {
        // 与 prepareLayer 一致: 整数档位当离散, 连续值才分箱
        labels = isIntegerLowCardinality(vals, 30)
          ? collapseLowCardinality(vals, 30)
          : binNumeric(vals, bins);
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
  // 组合 FAIL 浓度分析: 找出「单看都不高、合在一起 FAIL 率飙升」的交互根因
  // ---------------------------------------------------------------------
  function comboNgAnalysis(opts) {
    /**
     * 对「候选列 X 的每个类别 × 基准列 Y 的每个标签」统计组合 FAIL 浓度。
     * 用于把被信息增益漏掉的"组合/交互根因"捞回来 —— 例如注水阀=1/2档本身
     * FAIL 率只有 8.8%/10.7%, 注水量低桶 100% FAIL, 但"注水阀=1档 × 注水量低桶"
     * 的组合会以 100% FAIL 浓度出现, 且与任一单列都有可观测差异。
     *
     * opts:
     *   data: object[]          行数据
     *   candCols: string[]      候选列(通常是未勾选的参数列)
     *   baseCols: string[]      基准列(通常是已勾选的参数列)
     *   resultCol: string       结果列
     *   ngValues: string[]      视为 NG 的值
     *   bins: number            数值分箱数(默认 5)
     *   maxCardinality: number  离散列最大类别数(默认 30)
     *   minN: number            组合最小样本数, 低于此不提示(默认 5)
     *   rateThr: number         基准列"危险标签"阈值: FAIL 率 >= max(rateThr, 基线×2) 才参与组合(默认 0.15)
     *   maxResults: number      返回组合数上限(默认 12)
     * 返回: [{x, y, baseCol, n, ng, rate, xRate, yRate}]
     *   x = 候选列类别, y = 基准列标签, xRate = 该 x 单独 FAIL 率, yRate = 该 y 单独 FAIL 率
     */
    const data = opts.data;
    const candCols = opts.candCols || [];
    const baseCols = opts.baseCols || [];
    const resultCol = opts.resultCol;
    const ngValues = (opts.ngValues || ["NG"]).map(function (v) { return String(v).trim().toUpperCase(); });
    const bins = opts.bins || 5;
    const maxCardinality = opts.maxCardinality || 30;
    const minN = opts.minN || 5;
    const rateThr = opts.rateThr || 0.15;
    if (!data.length || !candCols.length || !baseCols.length || !resultCol) return [];

    const n = data.length;
    const isNg = data.map(function (r) {
      const key = String(r[resultCol] === null || r[resultCol] === undefined ? "" : r[resultCol]).trim().toUpperCase();
      return ngValues.indexOf(key) >= 0 ? 1 : 0;
    });
    const baseline = isNg.reduce(function (a, b) { return a + b; }, 0) / n;
    const dangerThr = Math.max(rateThr, baseline * 2);

    function prep(col) {
      const vals = data.map(function (r) { return r[col] === null || r[col] === undefined ? "" : r[col]; });
      return prepareLayer(vals, bins, maxCardinality);
    }
    function stat(list) {
      const map = new Map();
      list.forEach(function (lab, i) {
        const e = map.get(lab) || { n: 0, ng: 0 };
        e.n++;
        e.ng += isNg[i];
        map.set(lab, e);
      });
      return map;
    }

    const out = [];
    candCols.forEach(function (cc) {
      const cLabels = prep(cc);
      const cStat = stat(cLabels);
      baseCols.forEach(function (bc) {
        if (cc === bc) return;
        const bLabels = prep(bc);
        const bStat = stat(bLabels);
        // 基准列里 FAIL 浓度达标的"危险标签"
        const dangerY = [];
        bStat.forEach(function (e, y) {
          if (e.n >= minN && e.ng / e.n >= dangerThr) dangerY.push(y);
        });
        if (!dangerY.length) return;
        // 候选列类别 × 危险标签 组合计数
        const combo = new Map();
        cLabels.forEach(function (x, i) {
          const y = bLabels[i];
          if (dangerY.indexOf(y) < 0) return;
          const key = x + "\u0000" + y;
          const e = combo.get(key) || { n: 0, ng: 0 };
          e.n++;
          e.ng += isNg[i];
          combo.set(key, e);
        });
        combo.forEach(function (e, key) {
          if (e.n < minN || e.ng / e.n < dangerThr) return;
          const idx = key.indexOf("\u0000");
          const x = key.slice(0, idx), y = key.slice(idx + 1);
          const xs = cStat.get(x), ys = bStat.get(y);
          out.push({
            col: cc, x: x, y: y, baseCol: bc,
            n: e.n, ng: e.ng, rate: e.ng / e.n,
            xRate: xs ? xs.ng / xs.n : 0,
            yRate: ys ? ys.ng / ys.n : 0,
          });
        });
      });
    });
    out.sort(function (a, b) { return b.rate - a.rate; });
    return out.slice(0, opts.maxResults || 12);
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
    comboNgAnalysis: comboNgAnalysis,
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
