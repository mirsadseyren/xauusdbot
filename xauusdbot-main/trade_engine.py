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
        Mum fitilinin (high/low) alan sınırını kesip kesmediğini kontrol eder.
        LONG demand: low <= top   (fitil alanın üst sınırına veya içine ulaşıyor)
        SHORT supply: high >= bottom (fitil alanın alt sınırına veya içine ulaşıyor)
        Not: check_invalidation önce çağrıldığı için 'tam geçiş' burada yakalanmaz.
        """
        if poi.poi_type == POIType.LONG:
            return low <= poi.top
        return high >= poi.bottom

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
          find_sl_swing ile bulunur. Swing yoksa entry'nin 0.5% uzagında fallback.

        KURAL — Entry alan dışında da geçerli:
          current_close alan sınırının ötesinde olsa da geçerli entry sayılır.

        Dönüş: True → trade açıldı + MITIGATED.
        """
        entry_idx = self.armed_poi_entries.get(poi.id, bar_idx)
        is_choch, swing_price, swing_index = self.market_structure.check_choch(
            self.df_3m, entry_idx, bar_idx, poi.poi_type
        )
        if not is_choch:
            return False

        # ── SL hesapla ───────────────────────────────────────────────────────
        sl_result = self.market_structure.find_sl_swing(
            self.df_3m, entry_idx, bar_idx, poi.poi_type
        )
        if sl_result is not None:
            sl_price = sl_result[0]
        else:
            # Fallback: entry'nin 0.5% uzagı (swing bulunamadıysa)
            if poi.poi_type == POIType.LONG:
                sl_price = current_close * 0.995
            else:
                sl_price = current_close * 1.005

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
            # KURAL — SL > %0.3 → alan tükenmez; Touch #2 hakkı sürer:
            #   SL ile kapanan trade'in POI'si ACTIVE'e geri döner, active_pois'e
            #   yeniden eklenir ve aynı mum için invalidation atlanır.
            just_recovered: Set[str] = set()

            for trade in self.trades:
                if trade.status != TradeStatus.ACTIVE:
                    continue
                if not trade.check_exit(current_high, current_low, current_time):
                    continue

                if trade.status == TradeStatus.WIN:
                    # TP → POI gerçekten tükendi
                    trade.poi.end_time = trade.exit_time

                else:  # LOSS (SL)
                    sl_pct = abs(trade.entry_price - trade.sl_price) / trade.entry_price * 100
                    if sl_pct > SL_PCT_THRESHOLD:
                        # Alan tükenmez; POI'yi ACTIVE'e geri döndür
                        poi            = trade.poi
                        poi.status     = POIStatus.ACTIVE
                        poi._price_inside = False   # SL fiyatı alanın dışında
                        poi.end_time   = None
                        just_recovered.add(poi.id)
                        if poi not in self.active_pois:
                            self.active_pois.append(poi)
                        self.armed_poi_entries.pop(poi.id, None)

            # ── 3. Overlap: aynı mumda birden fazla temas → küçük alan kazanır ──
            # KURAL: Aynı anda iki alana temas → küçük alan kazanır, büyük INVALIDATED.
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

                # SL kurtarmalı POI: bu mum için invalidation atlanır
                skip_invalidation = poi.id in just_recovered

                # Temizlik: MITIGATED / INVALIDATED → listeden çıkar
                if poi.status in (POIStatus.MITIGATED, POIStatus.INVALIDATED):
                    self.active_pois.remove(poi)
                    self.armed_poi_entries.pop(poi.id, None)
                    continue

                # Fitil karşı yönde geçti mi? (SL kurtarmasında bu mum atlanır)
                if not skip_invalidation:
                    if poi.check_invalidation(current_high, current_low, current_time):
                        continue

                touching = self._is_touching(poi, current_high, current_low)

                # ────────────────────────────────────────────────────────────
                # STATE: ACTIVE — Temas bekleniyor
                # ────────────────────────────────────────────────────────────
                if poi.status == POIStatus.ACTIVE:
                    if touching:
                        if not poi._price_inside:
                            # Dışarıdan içeriye: yeni temas başladı
                            poi.touch_count  += 1
                            poi._price_inside = True

                            # KURAL — Touch #3 yok:
                            if poi.touch_count > MAX_TOUCHES:
                                poi.status   = POIStatus.INVALIDATED
                                poi.end_time = current_time
                                continue

                            # CHoCH ön şartı: daha önce alandan çıkıldıysa ARMED'a geç
                            if poi.has_left_after_touch:
                                poi.status = POIStatus.ARMED
                                self.armed_poi_entries[poi.id] = i

                                # KURAL — Aynı 3M mumda temas + CHoCH geçerli:
                                #   ARMED'a geçtiğimiz mum, aynı zamanda CHoCH onay
                                #   mumu olabilir; entry o mumun kapanışıdır.
                                if self._try_choch(poi, i, current_close, current_time, times):
                                    continue   # MITIGATED → sonraki mum temizlenir
                        # else: aynı temas devam ediyor — sayma

                    else:
                        if poi._price_inside:
                            # İçerideydi, şimdi dışarı çıktı → ön şart karşılandı
                            poi._price_inside     = False
                            poi.has_left_after_touch = True

                            # KURAL — 2. temas boş çıkarsa invalidate:
                            #   touch_count MAX_TOUCHES'a ulaştıysa ve CHoCH oluşmadıysa
                            #   (zaten ARMED'dan buraya gelinmez; burası ACTIVE'den çıkış),
                            #   alan geçersizleşir.
                            if poi.touch_count >= MAX_TOUCHES:
                                poi.status   = POIStatus.INVALIDATED
                                poi.end_time = current_time

                # ────────────────────────────────────────────────────────────
                # STATE: ARMED — CHoCH aranıyor
                # ────────────────────────────────────────────────────────────
                elif poi.status == POIStatus.ARMED:
                    if touching:
                        # Fitil hâlâ alanda → CHoCH ara.
                        # KURAL — Entry alan dışında da geçerli:
                        #   Onay mumunun kapanışı (current_close) alan sınırının
                        #   ötesinde olsa da geçerli CHoCH sayılır.
                        if self._try_choch(poi, i, current_close, current_time, times):
                            continue

                        # Temas devam ediyor ama CHoCH yok; _price_inside koru
                        poi._price_inside = True

                    else:
                        if poi._price_inside:
                            # KURAL — 2. temas boş çıkarsa invalidate:
                            #   Fitil alan sınırını kesmez hale geldi → temas bitti,
                            #   CHoCH oluşmadı → bu temas "boş" sayılır → INVALIDATED.
                            poi._price_inside = False
                            poi.status        = POIStatus.INVALIDATED
                            poi.end_time      = current_time

        print(f"Simulation Finished. Processed {len(self.trades)} trades.")
