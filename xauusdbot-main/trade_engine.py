import pandas as pd
from typing import List, Set
from models import POI, POIStatus, POIType, Trade, TradeStatus
from market_structure import MarketStructure

# ── Sabitler ──────────────────────────────────────────────────────────────────
MAX_TOUCHES      = 2    # İzin verilen maksimum temas sayısı
SL_PCT_THRESHOLD = 0.3  # SL mesafesi (%) bu eşiğin üstündeyse alan tükenmez


class TradingEngine:
    def __init__(self, df_3m: pd.DataFrame, all_pois: List[POI]):
        self.df_3m = df_3m
        self.all_pois = sorted(all_pois, key=lambda x: x.confirm_time)
        self.active_pois: List[POI] = []
        self.trades: List[Trade] = []
        # KURAL: 3 mumluk fractal (fractal_period=1), temastan 20 mum geriye swing arama
        self.market_structure = MarketStructure(fractal_period=1, pre_entry_lookback=20)
        self.armed_poi_entries: dict = {}   # poi.id → 3m bar index (temas anı)
        self._executed_keys: Set[tuple] = set()

    # ── Yardımcı Metodlar ────────────────────────────────────────────────────

    def _is_touching(self, poi: POI, high: float, low: float) -> bool:
        """
        Mumun (fitili) alan aralığıyla kesişip kesişmediğini kontrol eder (SPEC §29).
        Bölgeler wick tabanlıdır; temas için fitil yeterlidir, kapanış gerekmez.
        İki taraflı kontrol: low <= top VE high >= bottom.
        """
        return low <= poi.top and high >= poi.bottom

    def _poi_size(self, poi: POI) -> float:
        return poi.top - poi.bottom

    def _try_choch(
        self,
        poi: POI,
        bar_idx: int,
        current_close: float,
        current_time,
        times,
    ) -> bool:
        """
        CHoCH varlığını kontrol eder; varsa işlem açar ve POI'yi MITIGATED yapar.

        KURAL — SL = CHoCH'u oluşturan hareketin son relevant Swing Low/High:
          find_sl_swing ile bulunur. Swing yoksa işlem açılmaz (SPEC §45 tampon yok).

        KURAL — Entry alan dışında da geçerli:
          current_close alan sınırının ötesinde olsa da geçerli entry sayılır (SPEC §39/§61).

        KURAL — SL > %0.3 ise işlem AÇILMAZ ve alan tükenmez (SPEC §46-49).

        Dönüş: True → trade açıldı + MITIGATED. False → hiçbir şey değişmez, alan tükenmez.
        """
        entry_idx = self.armed_poi_entries.get(poi.id, bar_idx)
        is_choch, swing_price, swing_index = self.market_structure.check_choch(
            self.df_3m, entry_idx, bar_idx, poi.poi_type
        )
        if not is_choch:
            return False

        # ── SL hesapla (SPEC §44: CHoCH hareketinin son relevant swing'i) ─────
        sl_result = self.market_structure.find_sl_swing(
            self.df_3m, entry_idx, bar_idx, poi.poi_type
        )
        if sl_result is None:
            # Geçerli swing bulunamadı → SPEC §45 gereği tampon yok, işlem YOK,
            # alan tükenmez (MITIGATED yapılmaz).
            return False

        sl_price = sl_result[0]

        # ── Risk filtresi (SPEC §46-47/§93): SL > %0.3 → işlem YOK, alan tükenmez ──
        sl_pct = abs(current_close - sl_price) / current_close * 100
        if sl_pct > SL_PCT_THRESHOLD:
            return False

        # ── İşlem aç ─────────────────────────────────────────────────────────
        trade = Trade(poi, current_close, current_time, sl_price)
        trade.choch_time  = current_time
        trade.choch_price = current_close
        trade.swing_time  = times[swing_index]
        trade.swing_price = swing_price

        key = (current_time, round(current_close, 2))
        if key not in self._executed_keys:
            self._executed_keys.add(key)
            self.trades.append(trade)

        poi.status = POIStatus.MITIGATED
        return True

    # ── Ana Simülasyon Döngüsü ────────────────────────────────────────────────

    def run_simulation(self):
        poi_idx    = 0
        total_pois = len(self.all_pois)

        closes = self.df_3m["Close"].values
        highs  = self.df_3m["High"].values
        lows   = self.df_3m["Low"].values
        times  = self.df_3m.index

        for i in range(len(self.df_3m)):
            current_time  = times[i]
            current_close = closes[i]
            current_high  = highs[i]
            current_low   = lows[i]

            # ── 1. Yeni onaylanan POI'leri ekle ──────────────────────────────
            while poi_idx < total_pois and self.all_pois[poi_idx].confirm_time <= current_time:
                new_poi        = self.all_pois[poi_idx]
                new_poi.status = POIStatus.ACTIVE
                self.active_pois.append(new_poi)
                poi_idx += 1

            # ── 2. İşlem çıkışları (TP / SL) ─────────────────────────────────
            # SPEC §96: Bir alan en fazla 1 işlem açar; işlem TP/SL ile kapanınca
            # alan tükenmiş sayılır (CONSUMED). SL > %0.3 ön-filtresi işlem
            # açılmadan uygulandığı için burada alanı yeniden aktive ETMEYİZ.
            for trade in self.trades:
                if trade.status != TradeStatus.ACTIVE:
                    continue
                trade.check_exit(current_high, current_low, current_time)

            # ── 3. Overlap: aynı mumda birden fazla temas → küçük alan kazanır ──
            # KURAL: Aynı anda iki alana temas → küçük alan kazanır, büyük INVALIDATED (SPEC §63/§98).
            touching_now = [
                p for p in self.active_pois
                if p.status in (POIStatus.ACTIVE, POIStatus.ARMED)
                and self._is_touching(p, current_high, current_low)
            ]
            if len(touching_now) > 1:
                touching_now.sort(key=self._poi_size)           # küçük → büyük
                for big_poi in touching_now[1:]:                # [0] = en küçük, kazanır
                    big_poi.status   = POIStatus.INVALIDATED
                    big_poi.end_time = current_time

            # ── 4. POI State Machine ──────────────────────────────────────────
            for poi in list(self.active_pois):

                # Temizlik: MITIGATED / INVALIDATED → listeden çıkar
                if poi.status in (POIStatus.MITIGATED, POIStatus.INVALIDATED):
                    self.active_pois.remove(poi)
                    self.armed_poi_entries.pop(poi.id, None)
                    continue

                # KURAL — İnvalidasyon yalnızca 3M KAPANIŞLA (SPEC §57/§58/§109):
                #   fitil tek başına yeterli değildir; kapanış karşı taraftaysa alan ölür.
                if poi.check_invalidation(current_close, current_time):
                    continue

                touching = self._is_touching(poi, current_high, current_low)

                # ────────────────────────────────────────────────────────────
                # STATE: ACTIVE — Temas bekleniyor
                #   SPEC §31/§80: ilk temasta 3M izleme BAŞLAR (CHoCH aranır).
                # ────────────────────────────────────────────────────────────
                if poi.status == POIStatus.ACTIVE:
                    if touching:
                        if not poi._price_inside:
                            # Yeni temas başladı
                            poi.touch_count  += 1
                            poi._price_inside = True

                            # KURAL — Touch #3 yok (SPEC §52-55):
                            if poi.touch_count > MAX_TOUCHES:
                                poi.status   = POIStatus.INVALIDATED
                                poi.end_time = current_time
                                continue

                            # İlk temasta ARMED'a geç ve aynı mumda CHoCH dene (SPEC §40)
                            poi.status = POIStatus.ARMED
                            self.armed_poi_entries[poi.id] = i
                            if self._try_choch(poi, i, current_close, current_time, times):
                                continue   # MITIGATED → sonraki mum temizlenir
                        else:
                            # Aynı temas devam ediyor — yine de CHoCH ara
                            if self._try_choch(poi, i, current_close, current_time, times):
                                continue
                    else:
                        if poi._price_inside:
                            # İçerideydi, şimdi dışarı çıktı → temas bitti (henüz işlem yok)
                            poi._price_inside = False
                            poi.status        = POIStatus.ACTIVE
                            # 2. temas da boş çıkarsa invalidate (SPEC §55)
                            if poi.touch_count >= MAX_TOUCHES:
                                poi.status   = POIStatus.INVALIDATED
                                poi.end_time = current_time

                # ────────────────────────────────────────────────────────────
                # STATE: ARMED — CHoCH aranıyor (temas #1 ve #2'de de)
                # ────────────────────────────────────────────────────────────
                elif poi.status == POIStatus.ARMED:
                    if touching:
                        poi._price_inside = True
                        # KURAL — Entry alan dışında da geçerli (SPEC §39/§61):
                        #   Onay mumunun kapanışı alan sınırının ötesinde olsa da CHoCH geçerli.
                        if self._try_choch(poi, i, current_close, current_time, times):
                            continue
                    else:
                        if poi._price_inside:
                            # Fitil alan sınırını kesmez hale geldi → temas bitti, CHoCH yok
                            poi._price_inside = False
                            poi.status        = POIStatus.ACTIVE
                            # 2. temas boş çıkınca invalidate (SPEC §55)
                            if poi.touch_count >= MAX_TOUCHES:
                                poi.status   = POIStatus.INVALIDATED
                                poi.end_time = current_time

        print(f"Simulation Finished. Processed {len(self.trades)} trades.")
