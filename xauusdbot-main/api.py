import os
import uvicorn
import pandas as pd
from typing import Optional
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_DIR, "data", "xauusd_merged.parquet")
df = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global df
    if os.path.exists(DATA_PATH):
        print(f"Loading data from {DATA_PATH}...")
        try:
            df = pd.read_parquet(DATA_PATH)
            # Index'i kesinlikle tz-naive datetime64[ns] yap
            if df.index.tz is not None:
                df.index = df.index.tz_convert('UTC').tz_localize(None)
            # Mükerrer zamanları temizle
            if df.index.duplicated().any():
                df = df[~df.index.duplicated(keep='first')]
            df.sort_index(inplace=True)
            print(f"Data loaded. {len(df)} rows. Range: {df.index[0]} - {df.index[-1]}")
        except Exception as e:
            import traceback
            traceback.print_exc()
    else:
        print(f"WARNING: {DATA_PATH} not found. Run merge_data.py first.")
    yield
    df = None

app = FastAPI(title="XAUUSD OHLC API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

TIMEFRAME_MAP = {
    "1m":  "1min",
    "3m":  "3min",
    "5m":  "5min",
    "10m": "10min",
    "15m": "15min",
    "1h":  "1h",
    "4h":  "4h",
    "1d":  "1d",
}

@app.get("/api/ohlc")
async def get_ohlc(
    timeframe: str = Query("1h"),
    start_time: Optional[int] = Query(None),
    end_time:   Optional[int] = Query(None),
):
    global df
    print(f"API: tf={timeframe} start={start_time} end={end_time}")

    if df is None:
        return {"error": "Data not loaded"}
    if timeframe not in TIMEFRAME_MAP:
        return {"error": f"Unknown timeframe: {timeframe}"}

    try:
        # tz-naive Timestamp ile dilimle (index de tz-naive)
        start_dt = pd.Timestamp(start_time, unit='s') if start_time is not None else df.index[0]
        end_dt   = pd.Timestamp(end_time,   unit='s') if end_time   is not None else df.index[-1]

        sub = df.loc[start_dt:end_dt, ['Open', 'High', 'Low', 'Close']]

        if sub.empty:
            print("No data in range.")
            return []

        # Resample (1m için gerek yok)
        if timeframe != "1m":
            sub = sub.resample(TIMEFRAME_MAP[timeframe]).agg(
                Open=('Open', 'first'),
                High=('High', 'max'),
                Low=('Low',  'min'),
                Close=('Close', 'last'),
            ).dropna()

        # Index → Unix saniye (tz-naive datetime64[ns] için .value nanosecond verir)
        result = [
            {
                "time":  int(ts.value // 1_000_000_000),
                "open":  float(o),
                "high":  float(h),
                "low":   float(l),
                "close": float(c),
            }
            for ts, o, h, l, c in zip(
                sub.index, sub['Open'], sub['High'], sub['Low'], sub['Close']
            )
        ]

        print(f"Returning {len(result)} candles for {timeframe}")
        return result

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e)}
        
@app.get("/api/backtest-results")
async def get_backtest_results():
    import json
    json_path = os.path.join(BASE_DIR, "backtest_results.json")
    if not os.path.exists(json_path):
        return {"error": "Backtest results not found. Please run backtester.py first."}
    
    try:
        with open(json_path, "r") as f:
            data = json.load(f)
        return data
    except Exception as e:
        return {"error": str(e)}

from pydantic import BaseModel

class BacktestRequest(BaseModel):
    emaPeriod: int = 100
    maxLookback: int = 6
    maxPercent: float = 6.0

@app.post("/api/run-backtest")
async def api_run_backtest(req: BacktestRequest):
    import sys
    sys.path.append(BASE_DIR)
    from backtester import run_backtest
    try:
        data = run_backtest(DATA_PATH, req.emaPeriod, req.maxLookback, req.maxPercent)
        return data
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e)}

frontend_dir = os.path.join(BASE_DIR, "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("api:app", host="127.0.0.1", port=8000, reload=True)
