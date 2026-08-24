import pandas as pd
from models import POI, POIType
from typing import List

class POIGenerator:
    def __init__(self, ema_period=100, max_lookback=6, max_percent=6.0):
        self.ema_period = ema_period
        self.max_lookback = max_lookback
        self.max_percent = max_percent

    def generate_pois(self, df_4h: pd.DataFrame) -> List[POI]:
        """
        Geçmiş 4H mumlarını tara, wick-tabanlı reaksiyon alanlarını bul.
        EMA filtresi kullanılır. Countertrend'in gerçek başlangıcı signal
        candle (i) olarak kabul edilir — lookback ile yapay ekstrem alınmaz.
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
                # KURAL — Başlangıç wick'i countertrend'in gerçek başlangıcını temsil etmeli:
                #   SHORT zone'un alt sınırı (bottom) = signal candle i'nin low'u.
                #   Bu, yukarı countertrend'in tam başladığı noktadır; lookback ile
                #   daha eski diplerden yapay bir alt sınır alınmaz.
                lowest_low = lows[i]   # countertrend gerçek başlangıcı

                highest_high = highs[i]

                k = i + 1
                confirmed = False

                while k < len(df_4h):
                    if highs[k] > highest_high:
                        highest_high = highs[k]
                    if closes[k] < lowest_low:
                        confirmed = True
                        break
                    k += 1

                if confirmed:
                    # confirm_time: onay mumunun KAPANIŞI (açılış + 4h)
                    confirm_close_time = times[k] + pd.Timedelta(hours=4)
                    poi = POI(
                        start_time=times[i],          # countertrend başlangıcı
                        confirm_time=confirm_close_time,
                        top=highest_high,
                        bottom=lowest_low,
                        poi_type=POIType.SHORT
                    )
                    poi.origin_time  = times[i]
                    poi.origin_price = lows[i]
                    poi.confirm_price = closes[k]
                    if poi.is_valid_size(self.max_percent):
                        pois.append(poi)
                    # i=k YOK: Üst üste binen POI'lere izin verir

            # ──────────────────────────────────────────────────────
            # LONG POI (Demand Zone) — Uptrend
            # Sinyal: Trend yukarı, önceki mum yeşil, şimdiki mum kırmızı
            # ──────────────────────────────────────────────────────
            elif is_uptrend and is_red and prev_is_green:
                # KURAL — Başlangıç wick'i countertrend'in gerçek başlangıcını temsil etmeli:
                #   LONG zone'un üst sınırı (top) = signal candle i'nin high'ı.
                #   Bu, aşağı countertrend'in tam başladığı noktadır; lookback ile
                #   daha eski tepelerden yapay bir üst sınır alınmaz.
                highest_high = highs[i]   # countertrend gerçek başlangıcı

                lowest_low = lows[i]

                k = i + 1
                confirmed = False

                while k < len(df_4h):
                    if lows[k] < lowest_low:
                        lowest_low = lows[k]
                    if closes[k] > highest_high:
                        confirmed = True
                        break
                    k += 1

                if confirmed:
                    # confirm_time: onay mumunun KAPANIŞI (açılış + 4h)
                    confirm_close_time = times[k] + pd.Timedelta(hours=4)
                    poi = POI(
                        start_time=times[i],          # countertrend başlangıcı
                        confirm_time=confirm_close_time,
                        top=highest_high,
                        bottom=lowest_low,
                        poi_type=POIType.LONG
                    )
                    poi.origin_time  = times[i]
                    poi.origin_price = highs[i]
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
