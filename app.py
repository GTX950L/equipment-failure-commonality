"""
设备问题共性分析 · 交互式 Web 工具 (Streamlit)

用法:
    streamlit run app.py

流程:
    1. 上传 CSV / Excel 表格
    2. 自动识别表头, 展示每列的类型与样例值
    3. 打钩选择: 源列 / 工序参数列 / 结果列
    4. 选择哪些值算"不良 (NG)"
    5. 出桑基图, 可下载 HTML
"""
from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import streamlit as st

from src.sankey_analysis import build_sankey

PROJECT_ROOT = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# 文件读取 (自动猜编码)
# ---------------------------------------------------------------------------
@st.cache_data(show_spinner="正在读取文件…")
def load_table(raw: bytes, filename: str) -> pd.DataFrame:
    """读取 CSV / Excel。CSV 自动尝试 utf-8-sig / gbk 编码。"""
    name = filename.lower()
    if name.endswith(".csv"):
        for enc in ("utf-8-sig", "gbk", "utf-8"):
            try:
                return pd.read_csv(io.BytesIO(raw), encoding=enc)
            except UnicodeDecodeError:
                continue
        raise ValueError("无法识别 CSV 编码 (尝试了 utf-8 / gbk)")
    if name.endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(raw))
    raise ValueError("仅支持 .csv / .xlsx / .xls 文件")


def _infer_column_info(df: pd.DataFrame) -> pd.DataFrame:
    """生成"表头识别"表: 列名 / 类型 / 唯一值数 / 样例值。"""
    rows = []
    for col in df.columns:
        s = df[col].dropna()
        if pd.api.types.is_numeric_dtype(s):
            kind = "数值"
        else:
            kind = "文本"
        sample = "、".join(map(str, s.head(3).tolist()))
        rows.append({
            "列名": col,
            "类型": kind,
            "唯一值数": int(s.nunique()),
            "样例值": sample[:60] + ("…" if len(sample) > 60 else ""),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 自动推荐
# ---------------------------------------------------------------------------
_SRC_KEYWORDS = ("flowcode", "条母", "型号", "批号", "产品", "编号", "code", "id", "物料")
_RESULT_KEYWORDS = ("判定", "结果", "ng", "ok", "pass", "fail", "合格", "不良", "判")


def _recommend_source(cols: list[str]) -> str:
    """从表头里猜哪一列是"源列"(型号 / 条母 / 批次)。"""
    for col in cols:
        low = str(col).lower()
        if any(k in low for k in _SRC_KEYWORDS):
            return col
    return cols[0] if cols else ""


def _recommend_result(cols: list[str]) -> str:
    """从表头里猜哪一列是"结果列"(NG / OK 判定)。"""
    for col in cols:
        low = str(col).lower()
        if any(k in low for k in _RESULT_KEYWORDS):
            return col
    return cols[-1] if cols else ""


def _recommend_params(cols: list[str], source: str, result: str) -> list[str]:
    """排除源列 / 结果列后, 剩下的就是工序参数列。"""
    return [c for c in cols if c not in (source, result)]


# ---------------------------------------------------------------------------
# 页面
# ---------------------------------------------------------------------------
st.set_page_config(page_title="设备问题共性分析", page_icon="🔧", layout="wide")
st.title("🔧 设备问题共性分析 · 桑基图")

st.caption(
    "上传设备质量数据表 → 自动识别表头 → 打钩选择参与分析的列 → 一键出图。"
    "红色 = 该路径 NG 集中, 蓝色 = 合格为主。"
)

uploaded = st.file_uploader(
    "上传数据表 (CSV / Excel)",
    type=["csv", "xlsx", "xls"],
)

if uploaded is None:
    # 空状态: 提供一个快速体验入口
    st.info(
        "👆 先上传你的数据表。\n\n"
        "也可以先用项目自带的示例数据体验：`data/demo_equipment_issues.csv`"
    )
    if st.button("加载示例数据 (demo_equipment_issues.csv)"):
        demo_path = PROJECT_ROOT / "data" / "demo_equipment_issues.csv"
        uploaded = io.StringIO(demo_path.read_text(encoding="utf-8-sig"))
        uploaded.name = "demo_equipment_issues.csv"  # type: ignore[attr-defined]
        st.session_state["demo_loaded"] = True
    st.stop()

# --- 1. 读取 ---
try:
    raw = uploaded.read() if hasattr(uploaded, "read") else None
    if isinstance(uploaded, io.StringIO):
        raw = uploaded.read().encode("utf-8")
    df = load_table(raw, uploaded.name)
except Exception as exc:  # noqa: BLE001
    st.error(f"读取失败: {exc}")
    st.stop()

st.success(f"读取成功: {len(df):,} 行 × {df.shape[1]} 列")

# --- 2. 表头识别 ---
with st.expander("📋 自动识别的表头 (点开查看每列类型与样例)", expanded=True):
    info = _infer_column_info(df)
    st.dataframe(info, use_container_width=True, hide_index=True)
    with st.columns(3)[0]:
        st.dataframe(df.head(5), use_container_width=True, hide_index=True)

st.divider()

# --- 3. 打钩选择列 ---
st.subheader("🎯 选择参与分析的列")

cols = list(df.columns)
rec_source = _recommend_source(cols)
rec_result = _recommend_result(cols)

c1, c2 = st.columns([1, 1])
with c1:
    source_col = st.selectbox(
        "源列 (条母 / 产品型号 / 批号)",
        cols,
        index=cols.index(rec_source) if rec_source in cols else 0,
        help="桑基图的起点。通常选产品型号 / 条母 / 批号这类列。",
    )
with c2:
    result_col = st.selectbox(
        "结果列 (NG / OK 判定)",
        cols,
        index=cols.index(rec_result) if rec_result in cols else len(cols) - 1,
        help="最终判定结果所在列。",
    )

# 参数列: 排除已选的两列
param_candidates = [c for c in cols if c not in (source_col, result_col)]
rec_params = _recommend_params(param_candidates, source_col, result_col)
param_cols = st.multiselect(
    "工序参数列 (可多选, 按顺序形成链路)",
    param_candidates,
    default=rec_params,
    help="中间经过的工序参数列。可以是档位(离散)或数值(自动分箱)。",
)

# 不良值: 从结果列取值中打钩
result_values = df[result_col].astype(str).unique().tolist()
ng_default = [v for v in result_values if v.strip().upper() == "NG"]
ng_values = st.multiselect(
    "哪些值算「不良」? (NG 标记为红色)",
    result_values,
    default=ng_default or result_values,
    help="勾选的所有值都会当作 NG 统计。默认自动勾选名为 NG 的值。",
)

# --- 4. 参数 ---
st.subheader("⚙️ 出图参数")
c3, c4 = st.columns([1, 1])
with c3:
    top_n = st.slider("源列保留多少个 (其余合并为'其他')", 2, 20, 6)
with c4:
    continuous_bins = st.slider("数值参数分箱数", 2, 10, 5)

# --- 5. 出图 ---
if not param_cols:
    st.warning("请至少勾选 1 个工序参数列。")
    st.stop()
if not ng_values:
    st.warning("请至少勾选 1 个值作为「不良」。")
    st.stop()

# 构造二值结果列
work = df.copy()
result_lower = work[result_col].astype(str).str.strip().upper()
ng_lower = {str(v).strip().upper() for v in ng_values}
work["_NG_BOOL"] = result_lower.isin(ng_lower).astype(int)
work["_NG_OK"] = work["_NG_BOOL"].map({1: "NG", 0: "OK"})

ng_ratio = work["_NG_BOOL"].mean()
st.write(f"当前数据 NG 占比: **{ng_ratio:.1%}**")

if st.button("🚀 生成桑基图", type="primary", use_container_width=True):
    with st.spinner("正在绘图…"):
        fig = build_sankey(
            work,
            source_col=source_col,
            param_cols=param_cols,
            result_col="_NG_OK",
            result_positive="NG",
            top_n=top_n,
            continuous_bins=continuous_bins,
        )
    st.plotly_chart(fig, use_container_width=True)

    # 下载 HTML
    html_bytes = fig.to_html(include_plotlyjs="cdn").encode("utf-8")
    st.download_button(
        "💾 下载交互式 HTML",
        data=html_bytes,
        file_name="sankey.html",
        mime="text/html",
    )
