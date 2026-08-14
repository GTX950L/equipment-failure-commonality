"""
设备问题共性分析 → 桑基图可视化 (通用版)。

流水线:
    源列(如 FlowCode) → 参数列1 → 参数列2 → ... → 结果列(NG / OK)

与固定模板不同, 本版允许你指定任意数量的工序参数列,
列名也不必叫 FlowCode / 注水阀 —— 由调用方传列名。

可视化工具: Plotly (交互式 HTML 输出)。
颜色规则  : 节点 / 链路按"该节点下游 NG 占比"染色, 越红 → NG 越集中。
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go


# ---------------------------------------------------------------------------
# 路径默认值
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = PROJECT_ROOT / "data" / "demo_equipment_issues.csv"
DEFAULT_OUT_HTML = PROJECT_ROOT / "examples" / "sankey_demo.html"


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------
def _shorten_label(text: str, prefix: int = 10, suffix: int = 6) -> str:
    """
    把 KCHLZB00DV001115+A455P 缩成 KCHLZB00DV...+A455P，
    Plotly 节点 label 太长会自动换行变丑。
    """
    if not isinstance(text, str):
        return str(text)
    if len(text) <= prefix + suffix + 3:
        return text
    return f"{text[:prefix]}...{text[-suffix:]}"


# ---------------------------------------------------------------------------
# 连续值分箱
# ---------------------------------------------------------------------------
def bin_continuous(series: pd.Series, n_bins: int = 5) -> pd.Series:
    """将连续值等宽分箱，返回区间字符串标签。"""
    bins = pd.cut(series, bins=n_bins, include_lowest=True)
    labels = [
        str(b).replace("(", "[").replace(",", " ~ ").replace(")", "]")
        for b in bins
    ]
    return pd.Series(labels, index=series.index)


def _is_numeric(series: pd.Series) -> bool:
    """判断一列是否适合当连续值处理 (数值型且取值够多)。"""
    if not pd.api.types.is_numeric_dtype(series):
        return False
    return series.nunique(dropna=True) >= 4


def _prepare_layer_col(
    series: pd.Series,
    continuous_bins: int,
    max_cardinality: int = 30,
) -> pd.Series:
    """
    把一列参数变成"适合当桑基图节点"的离散标签:
      - 数值连续列 → 等宽分箱
      - 离散列类别数太多 → 低频类别合并成"其他"
    """
    s = series.astype(str).fillna("(空值)").str.strip()
    if _is_numeric(series):
        s = bin_continuous(series, n_bins=continuous_bins).astype(str)
    if s.nunique() > max_cardinality:
        top = s.value_counts().head(max_cardinality - 1).index
        s = s.where(s.isin(top), other="其他")
    return s


# ---------------------------------------------------------------------------
# 颜色工具
# ---------------------------------------------------------------------------
def _ng_ratio_to_color_axis(ng_ratio: float, baseline: float) -> float:
    """
    把原始 NG 占比映射到 (-1, 1) 染色轴：
      - baseline  → 0 (中性灰白)
      - baseline 以上 → 红 (偏向 1)
      - baseline 以下 → 蓝 (偏向 -1)
    整体做一个非线性放大, 让差异更显眼。
    """
    if baseline <= 0:
        baseline = 0.5
    diff = (ng_ratio - baseline) / max(baseline, 0.05)
    return math.tanh(diff * 1.5)


def _mix_color(color_axis: float) -> tuple[int, int, int]:
    """color_axis ∈ [-1, 1]: -1=蓝, 0=灰白, 1=红。"""
    color_axis = max(-1.0, min(1.0, color_axis))
    if color_axis >= 0:
        # 灰白 → 红
        t = color_axis
        r = int(210 + (230 - 210) * t)
        g = int(210 - 130 * t)
        b = int(210 - 100 * t)
    else:
        # 蓝 → 灰白
        t = -color_axis
        r = int(210 - 60 * t)
        g = int(210 - 40 * t)
        b = int(210 + (230 - 210) * t)
    return r, g, b


def _color_for_node(color_axis: float) -> str:
    r, g, b = _mix_color(color_axis)
    return f"rgb({r},{g},{b})"


def _color_for_link(color_axis: float) -> str:
    """链路颜色带透明，让多层重叠时仍能看清。"""
    r, g, b = _mix_color(color_axis)
    return f"rgba({r},{g},{b},0.4)"


# ---------------------------------------------------------------------------
# 主函数：构造桑基图 (通用版)
# ---------------------------------------------------------------------------
def build_sankey(
    df: pd.DataFrame,
    source_col: str,
    param_cols: list[str],
    result_col: str,
    top_n: int = 6,
    continuous_bins: int = 5,
    result_positive: str = "NG",
    max_cardinality: int = 30,
) -> go.Figure:
    """
    构造桑基图。

    链路结构: source_col → param_cols[0] → param_cols[1] → ... → result_col

    Parameters
    ----------
    df : DataFrame
    source_col : str
        起点列, 如 "FlowCode" / "条母" / "产品型号"
    param_cols : list[str]
        中间工序参数列, 任意数量
    result_col : str
        终点结果列, 取值应包含 NG/OK (或 result_positive 指定的不良值)
    top_n : int
        source_col 只保留数量最多的 N 个, 其余合并为 "其他"
    continuous_bins : int
        连续值参数列的分箱数
    result_positive : str
        视作"不良"的结果值, 用于统计 NG 占比
    max_cardinality : int
        离散参数列类别数超过该值时, 低频类别合并为 "其他"
    """
    if not param_cols:
        raise ValueError("param_cols 至少需要 1 个参数列")
    for col in [source_col, result_col, *param_cols]:
        if col not in df.columns:
            raise KeyError(f"数据中不存在列: {col}")

    work = df.copy()
    # 结果归一化: 大小写不敏感 (NG / ng / ng 均视为不良)
    work["_result_norm"] = work[result_col].astype(str).str.strip().str.upper()
    work["is_NG"] = (work["_result_norm"] == str(result_positive).upper()).astype(int)
    baseline_ng = float(work["is_NG"].mean()) if len(work) else 0.0

    # --- 1. 源列截断 ---
    top_values = work[source_col].astype(str).value_counts().head(top_n).index.tolist()
    work["_src_norm"] = work[source_col].astype(str).where(
        work[source_col].astype(str).isin(top_values),
        other="其他",
    )
    work["_src_short"] = work["_src_norm"].apply(_shorten_label)

    # --- 2. 逐层准备节点列 ---
    # 每一层: (原始列名, 展示名, 规范后的列)
    layer_cols: list[tuple[str, str]] = [("_src_short", source_col)]
    for pc in param_cols:
        work[f"_layer_{pc}"] = _prepare_layer_col(
            work[pc], continuous_bins, max_cardinality
        )
        layer_cols.append((f"_layer_{pc}", pc))

    # 结果层拆成 NG / OK 两个节点
    result_values = ["NG", "OK"]

    # --- 3. 节点集合 ---
    layer_nodes: list[list[str]] = []
    for col, _ in layer_cols:
        layer_nodes.append(sorted(work[col].unique().tolist()))
    layer_nodes.append(result_values)

    all_nodes: list[str] = []
    for layer in layer_nodes:
        all_nodes.extend(layer)
    node_index = {name: i for i, name in enumerate(all_nodes)}

    # --- 4. 节点 NG 比率 → 染色轴 ---
    def _ng_ratio_by(values_col: str, df: pd.DataFrame) -> dict[str, float]:
        out: dict[str, float] = {}
        for v, sub in df.groupby(values_col):
            out[str(v)] = float(sub["is_NG"].mean()) if len(sub) else 0.0
        return out

    layer_ng: list[dict[str, float]] = []
    for col, _ in layer_cols:
        layer_ng.append(_ng_ratio_by(col, work))

    node_ng_ratio: dict[str, float] = {}
    for layer, ng in zip(layer_nodes, layer_ng):
        for n in layer:
            node_ng_ratio[n] = ng.get(n, 0.0)
    node_ng_ratio["NG"] = 1.0
    node_ng_ratio["OK"] = 0.0

    node_color_axis: dict[str, float] = {
        n: _ng_ratio_to_color_axis(r, baseline_ng) for n, r in node_ng_ratio.items()
    }
    node_colors = [_color_for_node(node_color_axis[n]) for n in all_nodes]

    # --- 5. 构造链路 (相邻层两两统计) ---
    links_src: list[int] = []
    links_tgt: list[int] = []
    links_val: list[int] = []
    links_color: list[str] = []

    def _layer(left_col: str, right_col: str, left_axis: dict[str, float]) -> None:
        grouped = (
            work.groupby([left_col, right_col])
            .size()
            .reset_index(name="count")
            .sort_values("count", ascending=False)
        )
        for _, row in grouped.iterrows():
            left, right, cnt = str(row[left_col]), str(row[right_col]), int(row["count"])
            src = node_index[left]
            tgt = node_index[right]
            links_src.append(src)
            links_tgt.append(tgt)
            links_val.append(cnt)
            links_color.append(_color_for_link(left_axis.get(left, 0.0)))

    for i in range(len(layer_cols)):
        left_col, _ = layer_cols[i]
        if i + 1 < len(layer_cols):
            right_col, _ = layer_cols[i + 1]
        else:
            right_col = "_result_norm"  # 最后一层接 NG / OK
        left_axis = {n: node_color_axis[n] for n in layer_nodes[i]}
        _layer(left_col, right_col, left_axis)

    # --- 6. 标题: 数量最多的源值 & (top_n - 1) more ---
    head_src = work["_src_short"].value_counts().idxmax()
    extra = max(0, len(layer_nodes[0]) - 1)
    title = f"{head_src} & {extra} more"

    # --- 7. 绘图 ---
    fig = go.Figure(
        go.Sankey(
            arrangement="snap",
            node=dict(
                pad=12,
                thickness=14,
                line=dict(color="black", width=0.5),
                label=all_nodes,
                color=node_colors,
                customdata=[[node_ng_ratio[n]] for n in all_nodes],
                hovertemplate="%{label}<br>下游 NG 占比: %{customdata[0]:.1%}<extra></extra>",
            ),
            link=dict(
                source=links_src,
                target=links_tgt,
                value=links_val,
                color=links_color,
                hovertemplate="%{source.label} → %{target.label}<br>样本数: %{value}<extra></extra>",
            ),
        )
    )

    fig.update_layout(
        title_text=title,
        title_x=0.5,
        font=dict(family="Microsoft YaHei, Arial", size=11),
        width=1400,
        height=820,
        margin=dict(l=10, r=10, t=60, b=30),
    )
    return fig


# ---------------------------------------------------------------------------
# CLI 入口 (也支持传任意列名)
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="设备问题共性分析 → 桑基图 (Plotly, 通用列名版)"
    )
    parser.add_argument("--csv", default=str(DEFAULT_CSV), help="输入 CSV 文件路径")
    parser.add_argument(
        "--out-html", default=str(DEFAULT_OUT_HTML), help="输出 HTML 文件路径"
    )
    parser.add_argument(
        "--out-png", default=None, help="(可选) 同时导出 PNG, 需要 kaleido"
    )
    parser.add_argument("--source-col", default="FlowCode", help="源列名")
    parser.add_argument(
        "--param-cols",
        nargs="+",
        default=["注水阀", "注水量_g", "扬水通量", "肘存量"],
        help="中间参数列名 (可传多个)",
    )
    parser.add_argument("--result-col", default="判定结果", help="结果列名")
    parser.add_argument(
        "--result-positive", default="NG", help="视作不良的结果值"
    )
    parser.add_argument(
        "--top-n", type=int, default=6,
        help="源列只保留出现次数最多的几个, 其余合并为'其他'",
    )
    parser.add_argument("--bins", type=int, default=5, help="连续值列的分箱数")
    args = parser.parse_args()

    df = pd.read_csv(args.csv)
    print(f"读取 {len(df)} 条记录, 源列 '{args.source_col}' 有 "
          f"{df[args.source_col].nunique()} 个取值")

    fig = build_sankey(
        df,
        source_col=args.source_col,
        param_cols=args.param_cols,
        result_col=args.result_col,
        result_positive=args.result_positive,
        top_n=args.top_n,
        continuous_bins=args.bins,
    )

    out_html = Path(args.out_html)
    out_html.parent.mkdir(parents=True, exist_ok=True)
    fig.write_html(out_html, include_plotlyjs="cdn")
    print(f"已生成 HTML -> {out_html}")

    if args.out_png:
        try:
            fig.write_image(args.out_png)
            print(f"已生成 PNG  -> {args.out_png}")
        except Exception as exc:  # noqa: BLE001
            print(f"[警告] PNG 导出失败: {exc}")
            print("        请确认已安装 kaleido: pip install kaleido")


if __name__ == "__main__":
    main()
