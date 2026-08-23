import pandas as pd
from models import POI, POIType
from typing import List

class POIGenerator:
    def __init__(self, ema_period=100, max_lookback=6, max_percent=5.0):
        self.ema_period = ema_period
        self.max_lookback = max_lookback
        self.max_percent = max_percent

    def generate_pois(self, df_4h: pd.DataFrame) -> List[POI]:
        """
        Geçmiş 4H mumlarını tara, wick-tabanlı reaksiyon alanlarını bul.
        EMA filtresi ve 'karşıt hareketin en uç noktası' mantığını kullanır.
        i=k skip kaldırıldı: Üst üste binen (overlapping) POI'lere izin verir.
        """
        if len(df_4h) < self.ema_period:
            return []

        ema = df_4h['Close'].ewm(span=self.ema_period, adjust=False).mean()
        pois = []

        times = df_4h.index
        closes = df_4h['Close'].values
        opens = df_4h['Open'].values
        highs = df_4h['High'].values
        lows = df_4h['Low'].values
        emas = ema.values

        i = 1
        while i < len(df_4h):
            current_ema = emas[i]
            if pd.isna(current_ema):
                i += 1
                continue

            is_downtrend = closes[i] < current_ema
            is_uptrend = closes[i] > current_ema

            # >= ve <= kullanarak doji mumlarını da sinyal olarak say
            is_green = closes[i] >= opens[i]
            is_red = closes[i] <= opens[i]
            prev_is_green = closes[i-1] >= opens[i-1]
            prev_is_red = closes[i-1] <= opens[i-1]

            # ──────────────────────────────────────────────────────
            # SHORT POI (Supply Zone) — Downtrend
            # Sinyal: Trend aşağı, önceki mum kırmızı, şimdiki mum yeşil
            # ──────────────────────────────────────────────────────
            if is_downtrend and is_green and prev_is_red:
                lookback_start = max(0, i - self.max_lookback)
                lowest_low = lows[i]
                for j in range(i, lookback_start - 1, -1):
                    if lows[j] < lowest_low:
                        lowest_low = lows[j]

                highest_high = highs[i]
                highest_index = i

                k = i + 1
                confirmed = False

                while k < len(df_4h):
                    if highs[k] > highest_high:
                        highest_high = highs[k]
                        highest_index = k
                    if closes[k] < lowest_low:
                        confirmed = True
                        break
                    k += 1

                if confirmed:
                    poi = POI(
                        start_time=times[highest_index],
                        confirm_time=times[k],
                        top=highest_high,
                        bottom=lowest_low,
                        poi_type=POIType.SHORT
                    )
                    poi.origin_time = times[i]
                    poi.origin_price = lows[i]  # impulse started from this low
                    poi.confirm_price = closes[k]
                    if poi.is_valid_size(self.max_percent):
                        pois.append(poi)
                    # i=k YOK: Üst üste binen POI'lere izin verir

            # ──────────────────────────────────────────────────────
            # LONG POI (Demand Zone) — Uptrend
            # Sinyal: Trend yukarı, önceki mum yeşil, şimdiki mum kırmızı
            # ──────────────────────────────────────────────────────
            elif is_uptrend and is_red and prev_is_green:
                lookback_start = max(0, i - self.max_lookback)
                highest_high = highs[i]
                for j in range(i, lookback_start - 1, -1):
                    if highs[j] > highest_high:
                        highest_high = highs[j]

                lowest_low = lows[i]
                lowest_index = i

                k = i + 1
                confirmed = False

                while k < len(df_4h):
                    if lows[k] < lowest_low:
                        lowest_low = lows[k]
                        lowest_index = k
                    if closes[k] > highest_high:
                        confirmed = True
                        break
                    k += 1

                if confirmed:
                    poi = POI(
                        start_time=times[lowest_index],
                        confirm_time=times[k],
                        top=highest_high,
                        bottom=lowest_low,
                        poi_type=POIType.LONG
                    )
                    poi.origin_time = times[i]
                    poi.origin_price = highs[i]  # impulse started from this high
                    poi.confirm_price = closes[k]
                    if poi.is_valid_size(self.max_percent):
                        pois.append(poi)
                    # i=k YOK: Üst üste binen POI'lere izin verir

            i += 1

        # ── Deduplication ─────────────────────────────────────────────────────
        # Üst üste binen POI mantığı aynı bölgeyi birden fazla kez üretebilir.
        # (start_time, round(top,2), round(bottom,2)) üçlüsüne göre tekilleştir.
        seen = set()
        unique_pois = []
        for poi in pois:
            key = (poi.start_time, round(poi.top, 2), round(poi.bottom, 2))
            if key not in seen:
                seen.add(key)
                unique_pois.append(poi)

        return unique_pois
