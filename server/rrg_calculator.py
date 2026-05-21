#!/usr/bin/env python3
import json
import sys
import numpy as np
import pandas as pd

def _load_payload():
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}

def compute_single_rrg(sector_prices, benchmark_prices, tail_length=8):
    """Compute RS-Ratio and RS-Momentum for one symbol vs benchmark."""
    # Ensure they are aligned series
    common_idx = sector_prices.index.intersection(benchmark_prices.index)
    s = sector_prices.loc[common_idx]
    b = benchmark_prices.loc[common_idx]

    if len(s) < 20:
        return None

    raw_rs = (s / b) * 100
    rs_smoothed = raw_rs.ewm(span=10, adjust=False).mean()

    rolling_mean = rs_smoothed.rolling(window=52, min_periods=20).mean()
    rolling_std = rs_smoothed.rolling(window=52, min_periods=20).std()

    # Avoid division by zero
    rolling_std = rolling_std.replace(0, np.nan)
    rs_ratio = 100 + ((rs_smoothed - rolling_mean) / rolling_std) * 2

    rs_momentum_raw = rs_ratio - rs_ratio.shift(1)
    mom_smoothed = rs_momentum_raw.ewm(span=5, adjust=False).mean()
    mom_mean = mom_smoothed.rolling(window=52, min_periods=20).mean()
    mom_std = mom_smoothed.rolling(window=52, min_periods=20).std()
    mom_std = mom_std.replace(0, np.nan)
    rs_momentum = 100 + ((mom_smoothed - mom_mean) / mom_std) * 2

    valid = rs_ratio.notna() & rs_momentum.notna()
    rs_r = rs_ratio[valid]
    rs_m = rs_momentum[valid]

    if len(rs_r) == 0:
        return None

    n = min(tail_length, len(rs_r))
    tail = []
    for i in range(-n, 0):
        tail.append({
            "date": rs_r.index[i].strftime("%Y-%m-%d"),
            "rs_ratio": round(float(rs_r.iloc[i]), 2),
            "rs_momentum": round(float(rs_m.iloc[i]), 2),
        })

    current = tail[-1] if tail else None
    if current:
        r, m = current["rs_ratio"], current["rs_momentum"]
        if r >= 100 and m >= 100:
            quadrant = "Leading"
        elif r >= 100 and m < 100:
            quadrant = "Weakening"
        elif r < 100 and m >= 100:
            quadrant = "Improving"
        else:
            quadrant = "Lagging"
    else:
        quadrant = "Unknown"

    return {"tail": tail, "current": current, "quadrant": quadrant}

def main():
    payload = _load_payload()
    data = payload.get("data", {})
    benchmark_sym = payload.get("benchmark")
    tail_length = int(payload.get("tailLength", 8))

    if not data or benchmark_sym not in data:
        print(json.dumps({"error": "Missing data or benchmark"}))
        return

    # Convert to DataFrame
    df = pd.DataFrame(data)
    df.index = pd.to_datetime(df.index)
    
    # Resample to weekly (Friday close)
    weekly = df.resample("W-FRI").last().dropna(how="all")
    
    if benchmark_sym not in weekly.columns:
        print(json.dumps({"error": f"Benchmark {benchmark_sym} not in weekly data"}))
        return

    bench_prices = weekly[benchmark_sym]
    results = {}

    for sym in weekly.columns:
        if sym == benchmark_sym:
            continue
        
        rrg = compute_single_rrg(weekly[sym].dropna(), bench_prices, tail_length=tail_length)
        if rrg:
            results[sym] = rrg

    latest_date = None
    for sym, d in results.items():
        if d["tail"]:
            latest_date = d["tail"][-1]["date"]
            break

    output = {
        "benchmark": benchmark_sym,
        "tail_length": tail_length,
        "latest_data_date": latest_date,
        "sectors": results
    }

    print(json.dumps(output))

if __name__ == "__main__":
    main()
