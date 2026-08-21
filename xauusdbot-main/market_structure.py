import pandas as pd
from typing import Optional, Tuple
from models import POIType

class MarketStructure:
    def __init__(self, fractal_period=2):
        self.fractal_period = fractal_period
        
    def find_last_swing(self, df_3m: pd.DataFrame, poi_entry_index: int, current_index: int, poi_type: POIType) -> Optional[float]:
        """
        Bulunduğumuz current_index'e kadar olan 3m verisinde,
        POI'ye giriş anından itibaren oluşan son Swing High (LONG için) veya Swing Low'u (SHORT için) bulur.
        """
        if current_index - poi_entry_index < self.fractal_period * 2 + 1:
            return None # Not enough data for a fractal
            
        highs = df_3m['High'].values
        lows = df_3m['Low'].values
        
        last_swing_price = None
        
        if poi_type == POIType.LONG:
            # LONG işlem için "Son Geçerli Düşük Tepe (Lower High)" aranır.
            # Geriye doğru tarayarak ilk geçerli tepeyi buluyoruz.
            for i in range(current_index - self.fractal_period, poi_entry_index + self.fractal_period - 1, -1):
                is_swing_high = True
                for j in range(1, self.fractal_period + 1):
                    if highs[i - j] > highs[i] or highs[i + j] >= highs[i]:
                        is_swing_high = False
                        break
                if is_swing_high:
                    # En son oluşan tepeyi bulduk
                    last_swing_price = highs[i]
                    break
                    
        else: # SHORT
            # SHORT işlem için "Son Geçerli Yüksek Dip (Higher Low)" aranır.
            for i in range(current_index - self.fractal_period, poi_entry_index + self.fractal_period - 1, -1):
                is_swing_low = True
                for j in range(1, self.fractal_period + 1):
                    if lows[i - j] < lows[i] or lows[i + j] <= lows[i]:
                        is_swing_low = False
                        break
                if is_swing_low:
                    # En son oluşan dibi bulduk
                    last_swing_price = lows[i]
                    break
                    
        return last_swing_price
        
    def check_choch(self, df_3m: pd.DataFrame, poi_entry_index: int, current_index: int, poi_type: POIType) -> Tuple[bool, Optional[float], Optional[float]]:
        """
        CHoCH kırılımı var mı kontrol eder.
        Döner: (is_choch, sl_price, swing_price)
        """
        last_swing = self.find_last_swing(df_3m, poi_entry_index, current_index - 1, poi_type)
        if last_swing is None:
            return False, None, None
            
        current_close = df_3m['Close'].iloc[current_index]
        
        if poi_type == POIType.LONG:
            if current_close > last_swing:
                # CHoCH Onaylandı
                # SL seviyesi: POI'ye girdikten CHoCH onaylanana kadarki en düşük fitil (en dip nokta)
                sub_df = df_3m.iloc[poi_entry_index:current_index + 1]
                sl_price = sub_df['Low'].min()
                return True, sl_price, last_swing
                
        elif poi_type == POIType.SHORT:
            if current_close < last_swing:
                # CHoCH Onaylandı
                # SL seviyesi: POI'ye girdikten CHoCH onaylanana kadarki en yüksek fitil (en tepe nokta)
                sub_df = df_3m.iloc[poi_entry_index:current_index + 1]
                sl_price = sub_df['High'].max()
                return True, sl_price, last_swing
                
        return False, None, last_swing
