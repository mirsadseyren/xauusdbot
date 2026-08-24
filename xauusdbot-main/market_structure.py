import pandas as pd
from typing import Optional, Tuple
from models import POIType

class MarketStructure:
    def __init__(self, fractal_period: int = 1, pre_entry_lookback: int = 20):
        # KURAL: Swing High/Low = 1'er komşulu 3 mumluk fractal → fractal_period=1
        self.fractal_period      = fractal_period
        # Temastan önce kaç mum geriye swing araması yapılacak
        self.pre_entry_lookback  = pre_entry_lookback

    # ── Swing Tespit Yardımcıları ─────────────────────────────────────────────

    def _is_swing_high(self, highs, idx: int) -> bool:
        """idx etrafında fractal_period komşuyla Swing High testi."""
        fp = self.fractal_period
        if idx - fp < 0 or idx + fp >= len(highs):
            return False
        for j in range(1, fp + 1):
            # SPEC §34: merkez HIGH, sol ve sağ komşulardan KESİN daha yüksek olmalı
            if highs[idx - j] >= highs[idx] or highs[idx + j] >= highs[idx]:
                return False
        return True

    def _is_swing_low(self, lows, idx: int) -> bool:
        """idx etrafında fractal_period komşuyla Swing Low testi."""
        fp = self.fractal_period
        if idx - fp < 0 or idx + fp >= len(lows):
            return False
        for j in range(1, fp + 1):
            # SPEC §35: merkez LOW, sol ve sağ komşulardan KESİN daha düşük olmalı
            if lows[idx - j] <= lows[idx] or lows[idx + j] <= lows[idx]:
                return False
        return True

    # ── CHoCH Referans Swing'i ────────────────────────────────────────────────

    def find_last_swing(
        self,
        df_3m: pd.DataFrame,
        poi_entry_index: int,
        current_index: int,
        poi_type: POIType,
    ) -> Optional[Tuple[float, int]]:
        """
        CHoCH onayı için referans Swing'i bulur.

        KURAL — Swing temastan önce oluşabilir:
          Arama, poi_entry_index'ten pre_entry_lookback mum geriye açılır.

        LONG  → son Swing HIGH aranır (kırılacak seviye)
        SHORT → son Swing LOW  aranır (kırılacak seviye)
        """
        search_start = max(0, poi_entry_index - self.pre_entry_lookback)
        if current_index - search_start < self.fractal_period * 2 + 1:
            return None

        highs = df_3m["High"].values
        lows  = df_3m["Low"].values

        if poi_type == POIType.LONG:
            for idx in range(current_index - self.fractal_period,
                             search_start + self.fractal_period - 1, -1):
                if self._is_swing_high(highs, idx):
                    return (highs[idx], idx)
        else:  # SHORT
            for idx in range(current_index - self.fractal_period,
                             search_start + self.fractal_period - 1, -1):
                if self._is_swing_low(lows, idx):
                    return (lows[idx], idx)

        return None

    # ── SL Referans Swing'i ───────────────────────────────────────────────────

    def find_sl_swing(
        self,
        df_3m: pd.DataFrame,
        poi_entry_index: int,
        current_index: int,
        poi_type: POIType,
    ) -> Optional[Tuple[float, int]]:
        """
        KURAL — SL = CHoCH'u oluşturan hareketin son relevant Swing Low/High:
          CHoCH hareketi LONG için yukarı impuls → SL = bu impulsun başladığı Swing Low.
          CHoCH hareketi SHORT için aşağı impuls → SL = bu impulsun başladığı Swing High.

        LONG  → son Swing LOW  (CHoCH impulsunun dip noktası)
        SHORT → son Swing HIGH (CHoCH impulsunun tepe noktası)
        """
        search_start = max(0, poi_entry_index - self.pre_entry_lookback)
        if current_index - search_start < self.fractal_period * 2 + 1:
            return None

        highs = df_3m["High"].values
        lows  = df_3m["Low"].values

        if poi_type == POIType.LONG:
            # LONG CHoCH → SL = son Swing Low
            for idx in range(current_index - self.fractal_period,
                             search_start + self.fractal_period - 1, -1):
                if self._is_swing_low(lows, idx):
                    return (lows[idx], idx)
        else:  # SHORT
            # SHORT CHoCH → SL = son Swing High
            for idx in range(current_index - self.fractal_period,
                             search_start + self.fractal_period - 1, -1):
                if self._is_swing_high(highs, idx):
                    return (highs[idx], idx)

        return None

    # ── CHoCH Onay Kontrolü ───────────────────────────────────────────────────

    def check_choch(
        self,
        df_3m: pd.DataFrame,
        poi_entry_index: int,
        current_index: int,
        poi_type: POIType,
    ) -> Tuple[bool, Optional[float], Optional[int]]:
        """
        CHoCH kırılımı var mı kontrol eder.

        KURAL — CHoCH onayı temastan sonra olmalı:
          current_index < poi_entry_index → False.

        Döner: (is_choch, swing_price, swing_index)
        """
        if current_index < poi_entry_index:
            return False, None, None

        ref_swing = self.find_last_swing(df_3m, poi_entry_index, current_index - 1, poi_type)
        if ref_swing is None:
            return False, None, None

        last_swing, swing_index = ref_swing
        current_close = df_3m["Close"].iloc[current_index]

        if poi_type == POIType.LONG and current_close > last_swing:
            return True, last_swing, swing_index
        if poi_type == POIType.SHORT and current_close < last_swing:
            return True, last_swing, swing_index

        return False, last_swing, swing_index
