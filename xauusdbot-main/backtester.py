import os
import time
import json
from data_loader import DataLoader
from poi_generator import POIGenerator
from trade_engine import TradingEngine
from models import TradeStatus

def run_backtest(data_path: str, ema_period: int = 100, max_lookback: int = 6, max_percent: float = 15.0):
    start_time = time.time()
    
    # 1. Veri Yükleme ve Hazırlama
    loader = DataLoader(data_path)
    loader.load_and_prepare()
    
    if loader.df_4h is None or loader.df_3m is None:
        print("Data loading failed.")
        return
        
    print("Generating 4H POIs...")
    poi_gen = POIGenerator(ema_period=ema_period, max_lookback=max_lookback, max_percent=max_percent)
    all_pois = poi_gen.generate_pois(loader.df_4h)
    
    print(f"Total valid 4H POIs generated: {len(all_pois)}")
    
    # 2. Simülasyon Motorunu Başlatma
    print("Starting Tick-by-Tick Simulation on 3m data...")
    engine = TradingEngine(loader.df_3m, all_pois)
    engine.run_simulation()
    
    # 3. İstatistikleri Hesaplama ve Raporlama
    total_trades = len(engine.trades)
    winning_trades = sum(1 for t in engine.trades if t.status == TradeStatus.WIN)
    losing_trades = sum(1 for t in engine.trades if t.status == TradeStatus.LOSS)
    active_trades = sum(1 for t in engine.trades if t.status == TradeStatus.ACTIVE)
    
    win_rate = (winning_trades / (winning_trades + losing_trades) * 100) if (winning_trades + losing_trades) > 0 else 0
    
    # Rapor
    print("\n" + "="*50)
    print("BACKTEST RESULTS")
    print("="*50)
    print(f"Total Trades Taken: {total_trades}")
    print(f"Wins: {winning_trades}")
    print(f"Losses: {losing_trades}")
    print(f"Active (Unclosed): {active_trades}")
    print(f"Win Rate: {win_rate:.2f}%")
    print("="*50)
    
    # İşlemlerin bir kısmını dosyaya yazdıralım
    output_file = os.path.join(os.path.dirname(data_path), "..", "backtest_report.txt")
    with open(output_file, "w") as f:
        f.write("BACKTEST RESULTS\n")
        f.write(f"Total Trades: {total_trades}, Wins: {winning_trades}, Losses: {losing_trades}, Win Rate: {win_rate:.2f}%\n\n")
        f.write("TRADE LOG:\n")
        for i, t in enumerate(engine.trades):
            f.write(f"#{i+1} {t.direction.name} | Entry: {t.entry_price:.2f} | SL: {t.sl_price:.2f} | TP: {t.tp_price:.2f} | Status: {t.status.name} | Entry Time: {t.entry_time} | Exit Time: {t.exit_time}\n")
            
    # Frontend için JSON dosyası oluşturalım
    json_file = os.path.join(os.path.dirname(data_path), "..", "backtest_results.json")
    json_data = {
        "pois": [],
        "trades": []
    }
    
    for poi in all_pois:
        json_data["pois"].append({
            "id": poi.id,
            "type": poi.poi_type.name.lower(),
            "status": poi.status.name.lower(),
            "top": poi.top,
            "bottom": poi.bottom,
            "confirm_time": int(poi.confirm_time.value // 1_000_000_000),
            "confirm_price": poi.confirm_price,
            "start_time": int(poi.start_time.value // 1_000_000_000),
            "end_time": int(poi.end_time.value // 1_000_000_000) if poi.end_time else None,
            "origin_time": int(poi.origin_time.value // 1_000_000_000) if poi.origin_time else None,
            "origin_price": poi.origin_price
        })
        
    for t in engine.trades:
        json_data["trades"].append({
            "direction": t.direction.name.lower(),
            "entry_price": t.entry_price,
            "sl_price": t.sl_price,
            "tp_price": t.tp_price,
            "status": t.status.name.lower(),
            "entry_time": int(t.entry_time.value // 1_000_000_000) if t.entry_time else None,
            "exit_time": int(t.exit_time.value // 1_000_000_000) if t.exit_time else None,
            "choch_time": int(t.choch_time.value // 1_000_000_000) if t.choch_time else None,
            "choch_price": t.choch_price,
            "swing_time": int(t.swing_time.value // 1_000_000_000) if t.swing_time else None,
            "swing_price": t.swing_price
        })
        
    with open(json_file, "w") as f:
        json.dump(json_data, f)
            
    print(f"Detailed trade log saved to {output_file}")
    print(f"Frontend JSON data saved to {json_file}")
    print(f"Total Execution Time: {time.time() - start_time:.2f} seconds")
    return json_data

if __name__ == "__main__":
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_PATH = os.path.join(BASE_DIR, "data", "xauusd_merged.parquet")
    
    if os.path.exists(DATA_PATH):
        run_backtest(DATA_PATH)
    else:
        print(f"Data file not found at {DATA_PATH}. Please run merge_data.py first.")
