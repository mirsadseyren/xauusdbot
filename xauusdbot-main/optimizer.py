import os
import time
import itertools
from data_loader import DataLoader
from poi_generator import POIGenerator
from trade_engine import TradingEngine
from models import TradeStatus

def run_optimization():
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_PATH = os.path.join(BASE_DIR, "data", "xauusd_merged.parquet")
    
    if not os.path.exists(DATA_PATH):
        print(f"Data file not found at {DATA_PATH}")
        return

    print("Loading data for optimization...")
    loader = DataLoader(DATA_PATH)
    loader.load_and_prepare()
    
    if loader.df_4h is None or loader.df_3m is None:
        print("Data loading failed.")
        return
        
    print("Data loaded. Starting grid search...")
    
    # Focused grid search around best result: EMA=150, LB=2, MaxMov=30%
    ema_periods   = [100, 120, 130, 140, 150, 160, 170, 180, 200]
    max_lookbacks = [1, 2, 3, 4, 5]
    max_percents  = [20.0, 25.0, 30.0, 35.0, 40.0, 50.0]
    
    combinations = list(itertools.product(ema_periods, max_lookbacks, max_percents))
    total_combinations = len(combinations)
    print(f"Total Combinations: {total_combinations}")
    print(f"Estimated time: ~{total_combinations * 20 / 60:.0f} minutes\n")
    
    results = []
    
    start_time = time.time()
    for i, (ema, lookback, percent) in enumerate(combinations):
        elapsed = time.time() - start_time
        if i > 0:
            avg_per_run = elapsed / i
            remaining = avg_per_run * (total_combinations - i)
            eta_str = f"ETA: {remaining/60:.1f}min"
        else:
            eta_str = ""
            
        print(f"[{i+1}/{total_combinations}] EMA:{ema:<3} LB:{lookback:<2} %:{percent:<4} {eta_str} ... ", end="", flush=True)
        
        poi_gen = POIGenerator(ema_period=ema, max_lookback=lookback, max_percent=percent)
        all_pois = poi_gen.generate_pois(loader.df_4h)
        
        engine = TradingEngine(loader.df_3m, all_pois)
        engine.run_simulation()
        
        total_trades = len(engine.trades)
        winning_trades = sum(1 for t in engine.trades if t.status == TradeStatus.WIN)
        losing_trades  = sum(1 for t in engine.trades if t.status == TradeStatus.LOSS)
        win_rate = (winning_trades / (winning_trades + losing_trades) * 100) if (winning_trades + losing_trades) > 0 else 0
        
        print(f"POIs:{len(all_pois):<4} Trades:{total_trades:<4} WR:{win_rate:.1f}%")
        
        results.append({
            "ema": ema,
            "lookback": lookback,
            "percent": percent,
            "total_pois": len(all_pois),
            "total_trades": total_trades,
            "win_rate": win_rate
        })
        
    total_time = time.time() - start_time
    print(f"\nOptimization completed in {total_time:.1f} seconds ({total_time/60:.1f} minutes).")
    
    # ── Leaderboard 1: Highest Win Rate (min 50 trades) ──────────────────────
    print("\n" + "="*75)
    print("LEADERBOARD: HIGHEST WIN RATE  (min 50 trades)")
    print("="*75)
    
    by_wr = sorted(
        [r for r in results if r["total_trades"] >= 50],
        key=lambda x: (x["win_rate"], x["total_trades"]),
        reverse=True
    )
    if not by_wr:
        print("No combinations yielded at least 50 trades.")
    for rank, res in enumerate(by_wr[:15], 1):
        print(f"{rank:2}. WR:{res['win_rate']:>6.2f}% | Trades:{res['total_trades']:<5} | POIs:{res['total_pois']:<5} | "
              f"EMA:{res['ema']:<3} LB:{res['lookback']:<2} MaxMov:{res['percent']}%")

    # ── Leaderboard 2: Most Trades ───────────────────────────────────────────
    print("\n" + "="*75)
    print("LEADERBOARD: MOST TRADES")
    print("="*75)
    
    by_trades = sorted(results, key=lambda x: (x["total_trades"], x["win_rate"]), reverse=True)
    for rank, res in enumerate(by_trades[:15], 1):
        print(f"{rank:2}. Trades:{res['total_trades']:<5} | WR:{res['win_rate']:>6.2f}% | POIs:{res['total_pois']:<5} | "
              f"EMA:{res['ema']:<3} LB:{res['lookback']:<2} MaxMov:{res['percent']}%")

    # ── Best Balanced (≥75% WR, most trades) ────────────────────────────────
    print("\n" + "="*75)
    print("LEADERBOARD: BEST BALANCE  (WR ≥ 75%, most trades)")
    print("="*75)
    
    balanced = sorted(
        [r for r in results if r["win_rate"] >= 75.0 and r["total_trades"] >= 50],
        key=lambda x: (x["total_trades"], x["win_rate"]),
        reverse=True
    )
    if not balanced:
        print("No combinations have WR ≥ 75% with at least 50 trades.")
    for rank, res in enumerate(balanced[:15], 1):
        print(f"{rank:2}. Trades:{res['total_trades']:<5} | WR:{res['win_rate']:>6.2f}% | POIs:{res['total_pois']:<5} | "
              f"EMA:{res['ema']:<3} LB:{res['lookback']:<2} MaxMov:{res['percent']}%")

if __name__ == "__main__":
    run_optimization()
