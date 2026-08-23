import pandas as pd
from typing import List, Optional
from models import POI, POIStatus, POIType, Trade, TradeStatus
from market_structure import MarketStructure

class TradingEngine:
    def __init__(self, df_3m: pd.DataFrame, all_pois: List[POI]):
        self.df_3m = df_3m
        # Sort POIs by confirm_time so we can add them chronologically
        self.all_pois = sorted(all_pois, key=lambda x: x.confirm_time)
        self.active_pois: List[POI] = []
        self.trades: List[Trade] = []
        self.market_structure = MarketStructure(fractal_period=2)
        
        # Track entry index for each armed POI
        self.armed_poi_entries = {}
        
        # Deduplication: (entry_time, round(entry_price,2)) çiftini takip et
        self._executed_keys: set = set()

    def run_simulation(self):
        poi_idx = 0
        total_pois = len(self.all_pois)
        
        closes = self.df_3m['Close'].values
        opens = self.df_3m['Open'].values
        highs = self.df_3m['High'].values
        lows = self.df_3m['Low'].values
        times = self.df_3m.index
        
        for i in range(len(self.df_3m)):
            current_time = times[i]
            current_close = closes[i]
            current_open = opens[i]
            current_high = highs[i]
            current_low = lows[i]
            
            # 1. Add POIs that are confirmed by this time
            while poi_idx < total_pois and self.all_pois[poi_idx].confirm_time <= current_time:
                new_poi = self.all_pois[poi_idx]
                new_poi.status = POIStatus.ACTIVE
                self.active_pois.append(new_poi)
                poi_idx += 1
                
            # 2. Manage Active Trades (Check TP/SL)
            for trade in self.trades:
                if trade.status == TradeStatus.ACTIVE:
                    if trade.check_exit(current_high, current_low, current_time):
                        trade.poi.end_time = trade.exit_time
                    
            # 3. Process Active and Armed POIs
            for poi in list(self.active_pois):
                if poi.status == POIStatus.MITIGATED or poi.status == POIStatus.INVALIDATED:
                    self.active_pois.remove(poi)
                    if poi.id in self.armed_poi_entries:
                        del self.armed_poi_entries[poi.id]
                    continue
                    
                if poi.status == POIStatus.ACTIVE:
                    # STATE 1: İzleme (Monitoring)
                    # Check invalidation BEFORE checking for ARMED
                    if poi.check_invalidation(current_high, current_low, current_time):
                        continue
                        
                    # Fiyatın High veya Low değeri POI içine girdiyse ARMED olur.
                    entered = False
                    if poi.poi_type == POIType.LONG and current_low <= poi.top and current_high >= poi.bottom:
                        entered = True
                    elif poi.poi_type == POIType.SHORT and current_high >= poi.bottom and current_low <= poi.top:
                        entered = True
                        
                    if entered:
                        poi.status = POIStatus.ARMED
                        self.armed_poi_entries[poi.id] = i
                        
                elif poi.status == POIStatus.ARMED:
                    # STATE 2: Alarm ve Onay (Armed & Confirmation)
                    if poi.check_invalidation(current_high, current_low, current_time):
                        continue
                        
                    # Kâr yönünde alanı terk etme durumu (fiyat alanın üzerinden choch oluşmadan geçtiyse iptal)
                    left_profitably = False
                    if poi.poi_type == POIType.LONG and current_close > poi.top:
                        left_profitably = True
                    elif poi.poi_type == POIType.SHORT and current_close < poi.bottom:
                        left_profitably = True
                        
                    if left_profitably:
                        # CHoCH oluşmadan alanı kâr yönünde terk etti. İptal.
                        poi.status = POIStatus.INVALIDATED
                        poi.end_time = current_time
                        continue
                        
                    # SADECE ALAN İÇERİSİNDEYKEN choch araştırılır.
                    poi_entry_idx = self.armed_poi_entries[poi.id]
                    is_choch, swing_price, swing_index = self.market_structure.check_choch(
                        self.df_3m, poi_entry_idx, i, poi.poi_type
                    )
                    
                    if is_choch:
                        # CHoCH Onaylandı. Anında işleme giriyoruz.
                        trade = Trade(poi, current_close, current_time)
                        
                        # Set CHoCH and swing points for visualization
                        trade.choch_time = current_time
                        trade.choch_price = current_close
                        trade.swing_time = times[swing_index]
                        trade.swing_price = swing_price
                        
                        trade_key = (current_time, round(current_close, 2))
                        if trade_key not in self._executed_keys:
                            self._executed_keys.add(trade_key)
                            self.trades.append(trade)
                            
                        poi.status = POIStatus.MITIGATED # İşleme girildi, alanı kapat
                            
        print(f"Simulation Finished. Processed {len(self.trades)} trades.")
