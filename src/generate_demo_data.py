"""
生成模拟的设备工艺数据，用于演示桑基图共性分析。
字段参考制造业(注塑/压铸)场景：FlowCode、注水阀、注水量、扬水通量、肘存量、判定结果。
"""
import random
import pandas as pd
from pathlib import Path

random.seed(42)  # 让每次生成的数据一致


# 模拟 10 个条母（FlowCode），按 8222 / 9610 线的真实风格命名
FLOW_CODES = [
    "KCHLZB00NU001115+A166P",
    "KCHLZB00NU001115+A167P",
    "KCHLZB00NU001115+A168P",
    "KCHLZB00DV001115+A455P",
    "KCHLZB00DV001115+A456P",
    "KCHLZB00GD001115+A789P",
    "KCHLZB00GD001115+A790P",
    "KCHLZB00LL001115+A001P",
    "KCHLZB00LL001115+A002P",
    "KCHLZB00XX001115+A100P",
]

# 注水阀档位（离散值）
WATER_VALVES = ["A档", "B档", "C档", "D档"]

# 注水量-g 档位
def _water_amount():
    return round(random.uniform(0.100, 0.120), 4)

# 扬水通量
def _pump_flow():
    return round(random.uniform(0.04, 0.12), 4)

# 肘存量
def _elbow_stock():
    return random.choice([round(x * 0.001, 4) for x in range(80, 140, 5)])


def _judgement(flow_code: str, valve: str, water: float, pump: float, elbow: float) -> str:
    """
    模拟判定逻辑：让某些 FlowCode + 阀门 + 参数区间的组合明显偏向 NG,
    这样桑基图能呈现明显的"共性"红流。
    """
    # 共性1: FlowCode 以 DV 开头时，C档阀门 + 注水量偏低 → NG 概率高
    if flow_code.startswith("KCHLZB00DV") and valve == "C档" and water < 0.108:
        return "NG" if random.random() < 0.85 else "OK"

    # 共性2: FlowCode 以 GD 开头时，D档阀门 + 扬水通量偏高 → NG 概率高
    if flow_code.startswith("KCHLZB00GD") and valve == "D档" and pump > 0.10:
        return "NG" if random.random() < 0.75 else "OK"

    # 共性3: FlowCode 以 LL 开头时 + 肘存量异常高 → NG 概率较高
    if flow_code.startswith("KCHLZB00LL") and elbow > 0.115:
        return "NG" if random.random() < 0.65 else "OK"

    # 其余情况按基线判定（约 15% NG）
    return "NG" if random.random() < 0.15 else "OK"


def generate(n: int = 800) -> pd.DataFrame:
    """生成 n 条模拟数据。"""
    rows = []
    for _ in range(n):
        fc = random.choice(FLOW_CODES)
        valve = random.choice(WATER_VALVES)
        water = _water_amount()
        pump = _pump_flow()
        elbow = _elbow_stock()
        verdict = _judgement(fc, valve, water, pump, elbow)
        rows.append({
            "FlowCode": fc,
            "注水阀": valve,
            "注水量_g": water,
            "扬水通量": pump,
            "肘存量": elbow,
            "判定结果": verdict,
        })
    df = pd.DataFrame(rows)
    return df


def main():
    out_dir = Path(__file__).resolve().parent.parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    df = generate(n=800)
    out_file = out_dir / "demo_equipment_issues.csv"
    df.to_csv(out_file, index=False, encoding="utf-8-sig")

    print(f"已生成 {len(df)} 条数据 -> {out_file}")
    print(f"  NG 占比: {(df['判定结果'] == 'NG').mean():.1%}")
    print(f"  OK 占比: {(df['判定结果'] == 'OK').mean():.1%}")
    print(f"  FlowCode 数量: {df['FlowCode'].nunique()}")
    print("\n前 5 行预览:")
    print(df.head().to_string(index=False))


if __name__ == "__main__":
    main()
