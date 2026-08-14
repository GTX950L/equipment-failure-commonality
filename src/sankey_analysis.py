"""
设备问题共性分析 → 桑基图可视化。

流水线：
    FlowCode → 注水阀 → 注水量_g → 扬水通量 → 肘存量 → 判定结果(NG / OK)

可视化工具: Plotly (交互式 HTML 输出)。
颜色规则  : 节点 / 链路按"该节点下游 NG 占比"染色，越红 → NG 越集中。
"""
from __future__ import annotations

import argparse
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
# FlowCode 缩写
# ---------------------------------------------------------------------------
def _shorten_flowcode(code: str, prefix: int = 10, suffix: int = 6) -> str:
    """
    把 KCHLZB00DV001115+A455P 缩成 KCHLZB00DV...+A455P，
    只保留前 N 字符和后 M 字符，Plotly 节点 label 太长会换行变丑。
    """
    if not isinstance(code, str):
        return str(code)
    if len(code) <= prefix + suffix + 3:
        return code
    return f"{code[:prefix]}...{code[-suffix:]}"


# ---------------------------------------------------------------------------
# 连续值分箱
# ---------------------------------------------------------------------------
def bin_continuous(series: pd.Series, n_bins: int = 5) -> pd.Series:
    """将连续值等宽分箱，返回区间字符串标签。"""
    bins = pd.cut(series, bins=n_bins, include_lowest=True)
    # 把 (a, b] 形式改成 [a, b] 风格，可读性更好
    labels = [
        str(b).replace("(", "[").replace(",", " ~ ").replace(")", "]")
        for b in bins
    ]
    return pd.Series(labels, index=series.index)


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
        # 数据全是 OK, 强制按绝对 0.5 当基线
        baseline = 0.5
    diff = (ng_ratio - baseline) / max(baseline, 0.05)
    # 用 tanh 做软裁剪
    import math
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
# 主函数：构造桑基图
# ---------------------------------------------------------------------------
def build_sankey(
    df: pd.DataFrame,
    top_n_flowcodes: int = 6,
    continuous_bins: int = 5,
) -> go.Figure:
    """
    构造桑基图。

    Parameters
    ----------
    df : DataFrame
        必须包含列: FlowCode, 注水阀, 注水量_g, 扬水通量, 肘存量, 判定结果
    top_n_flowcodes : int
        只保留数量最多的 N 个 FlowCode, 其余合并成 "其他 FlowCode"
    continuous_bins : int
        连续值列的分箱数
    """
    work = df.copy()
    work["is_NG"] = (work["判定结果"] == "NG").astype(int)
    # 基线 NG 概率 (用作染色的中心参考)
    baseline_ng = float(work["is_NG"].mean()) if len(work) else 0.0

    # --- 1. FlowCode 截断 ---
    top_flows = work["FlowCode"].value_counts().head(top_n_flowcodes).index.tolist()
    work["FlowCode"] = work["FlowCode"].where(
        work["FlowCode"].isin(top_flows), other="其他 FlowCode"
    )

    # --- 2. 连续值分箱 ---
    work["注水量_g_bin"] = bin_continuous(work["注水量_g"], continuous_bins)
    work["扬水通量_bin"] = bin_continuous(work["扬水通量"], continuous_bins)
    work["肘存量_bin"] = bin_continuous(work["肘存量"], continuous_bins)

    # --- 2.5 短 FlowCode 标签 (Plotly 节点 label 不宜超过 ~15 字符) ---
    work["FlowCode_short"] = work["FlowCode"].apply(_shorten_flowcode)

    # --- 3. 节点集合 + 顺序 ---
    # 对长 FlowCode 做缩写 (Plotly 节点 label 太长会自动换行变丑)
    work["FlowCode_short"] = work["FlowCode"].apply(_shorten_flowcode)

    flow_nodes = sorted(work["FlowCode_short"].unique().tolist())
    valve_nodes = sorted(work["注水阀"].unique().tolist())
    water_nodes = sorted(work["注水量_g_bin"].unique().tolist())
    pump_nodes = sorted(work["扬水通量_bin"].unique().tolist())
    elbow_nodes = sorted(work["肘存量_bin"].unique().tolist())
    result_nodes = ["NG", "OK"]

    all_nodes = (
        flow_nodes
        + valve_nodes
        + water_nodes
        + pump_nodes
        + elbow_nodes
        + result_nodes
    )
    node_index = {name: i for i, name in enumerate(all_nodes)}

    # --- 4. 节点 NG 比率 (用于染色) ---
    def _ng_ratio_by(values_col: str, df: pd.DataFrame) -> dict[str, float]:
        out = {}
        for v, sub in df.groupby(values_col):
            out[v] = float(sub["is_NG"].mean()) if len(sub) else 0.0
        return out

    flow_ng = _ng_ratio_by("FlowCode_short", work)
    valve_ng = _ng_ratio_by("注水阀", work)
    water_ng = _ng_ratio_by("注水量_g_bin", work)
    pump_ng = _ng_ratio_by("扬水通量_bin", work)
    elbow_ng = _ng_ratio_by("肘存量_bin", work)

    node_ng_ratio: dict[str, float] = {}
    for n in flow_nodes:
        node_ng_ratio[n] = flow_ng.get(n, 0.0)
    for n in valve_nodes:
        node_ng_ratio[n] = valve_ng.get(n, 0.0)
    for n in water_nodes:
        node_ng_ratio[n] = water_ng.get(n, 0.0)
    for n in pump_nodes:
        node_ng_ratio[n] = pump_ng.get(n, 0.0)
    for n in elbow_nodes:
        node_ng_ratio[n] = elbow_ng.get(n, 0.0)
    # NG/OK 强制为染色极值
    node_ng_ratio["NG"] = 1.0
    node_ng_ratio["OK"] = 0.0

    # 把 raw NG 比率 → 染色轴 (-1, 1)
    node_color_axis: dict[str, float] = {
        n: _ng_ratio_to_color_axis(r, baseline_ng) for n, r in node_ng_ratio.items()
    }
    node_colors = [_color_for_node(node_color_axis[n]) for n in all_nodes]

    # 每一层源节点的染色轴 (link 颜色按这个传)
    flow_axis = {n: node_color_axis[n] for n in flow_nodes}
    valve_axis = {n: node_color_axis[n] for n in valve_nodes}
    water_axis = {n: node_color_axis[n] for n in water_nodes}
    pump_axis = {n: node_color_axis[n] for n in pump_nodes}
    elbow_axis = {n: node_color_axis[n] for n in elbow_nodes}

    # --- 5. 构造链路 ---
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
            left, right, cnt = row[left_col], row[right_col], int(row["count"])
            src = node_index[left]
            tgt = node_index[right]
            links_src.append(src)
            links_tgt.append(tgt)
            links_val.append(cnt)
            # 链路颜色按源节点的染色轴
            links_color.append(_color_for_link(left_axis.get(left, 0.0)))

    _layer("FlowCode_short", "注水阀", flow_axis)
    _layer("注水阀", "注水量_g_bin", valve_axis)
    _layer("注水量_g_bin", "扬水通量_bin", water_axis)
    _layer("扬水通量_bin", "肘存量_bin", pump_axis)
    _layer("肘存量_bin", "判定结果", elbow_axis)

    # --- 6. 标题: 数量最多的 FlowCode & (top_n - 1) more ---
    head_flow = work["FlowCode_short"].value_counts().idxmax()
    extra = max(0, len(flow_nodes) - 1)
    title = f"{head_flow} & {extra} more"

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
# CLI 入口
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="设备问题共性分析 → 桑基图 (Plotly)"
    )
    parser.add_argument(
        "--csv", default=str(DEFAULT_CSV), help="输入 CSV 文件路径"
    )
    parser.add_argument(
        "--out-html",
        default=str(DEFAULT_OUT_HTML),
        help="输出 HTML 文件路径",
    )
    parser.add_argument(
        "--out-png",
        default=None,
        help="(可选) 同时导出 PNG, 需要 kaleido",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=6,
        help="保留出现次数最多的几个 FlowCode, 其余合并为'其他 FlowCode'",
    )
    parser.add_argument(
        "--bins",
        type=int,
        default=5,
        help="连续值列的分箱数 (默认 5)",
    )
    args = parser.parse_args()

    df = pd.read_csv(args.csv)
    print(f"读取 {len(df)} 条记录, {df['FlowCode'].nunique()} 个 FlowCode")

    fig = build_sankey(
        df,
        top_n_flowcodes=args.top_n,
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
