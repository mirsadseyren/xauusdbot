import uuid
from enum import Enum
from typing import Optional

class POIType(Enum):
    LONG  = "LONG"   # Demand (Support)
    SHORT = "SHORT"  # Supply (Resistance)

class POIStatus(Enum):
    ACTIVE          = "ACTIVE"
    ARMED           = "ARMED"
    CHOCH_CONFIRMED = "CHOCH_CONFIRMED"
    LEFT_AREA       = "LEFT_AREA"
    MITIGATED       = "MITIGATED"
    INVALIDATED     = "INVALIDATED"

class TradeStatus(Enum):
    ACTIVE = "ACTIVE"
    WIN    = "WIN"
    LOSS   = "LOSS"


class POI:
    def __init__(self, start_time, confirm_time, top: float, bottom: float, poi_type: POIType):
        self.id           = str(uuid.uuid4())
        self.start_time   = start_time
        self.confirm_time = confirm_time
        self.top          = top
        self.bottom       = bottom
        self.poi_type     = poi_type
        self.status       = POIStatus.ACTIVE
        self.end_time     = None
        self.choch_sl_price = None
        self.origin_time  = None   # Signal candle time
        self.origin_price = None   # Price at signal candle
        self.confirm_price = None  # Close of confirmation candle

        # ── Temas & CHoCH ön şart takibi ─────────────────────────────────
        self.touch_count:         int  = 0
        self.has_left_after_touch: bool = False
        self._price_inside:        bool = False

    def is_valid_size(self, max_percent: float = 6.0) -> bool:
        """
        KURAL — Genişlik sınırı %6, referans = onay mumunun kapanışı:
          (High - Low) / ConfirmationClose × 100 ≤ max_percent

        Onay kapanışı yoksa (geriye dönük veri eksikliği) bottom baz alınır.
        """
        ref = self.confirm_price if self.confirm_price else self.bottom
        if ref == 0:
            return False
        size_pct = (self.top - self.bottom) / ref * 100
        return size_pct <= max_percent

    def is_price_inside(self, price: float) -> bool:
        return self.bottom <= price <= self.top

    def check_invalidation(self, current_high: float, current_low: float, current_time) -> bool:
        """
        Fitil karşı yönden geçişi → INVALIDATED.
        LONG: low < bottom  |  SHORT: high > top
        """
        if self.poi_type == POIType.LONG and current_low < self.bottom:
            self.status   = POIStatus.INVALIDATED
            self.end_time = current_time
            return True
        if self.poi_type == POIType.SHORT and current_high > self.top:
            self.status   = POIStatus.INVALIDATED
            self.end_time = current_time
            return True
        return False

    def __repr__(self):
        return (f"POI({self.poi_type.name}, "
                f"Top:{self.top:.2f}, Bottom:{self.bottom:.2f}, "
                f"Status:{self.status.name})")


class Trade:
    def __init__(self, poi: POI, entry_price: float, entry_time, sl_price: float):
        """
        sl_price: CHoCH'u oluşturan hareketin son Swing Low (LONG) veya
                  Swing High (SHORT) fiyatı. Buradan SL ve 1R TP hesaplanır.
        """
        self.poi          = poi
        self.entry_price  = entry_price
        self.entry_time   = entry_time
        self.direction    = poi.poi_type
        self.status       = TradeStatus.ACTIVE
        self.exit_time    = None
        self.choch_time   = None
        self.choch_price  = None
        self.swing_time   = None
        self.swing_price  = None

        self.sl_price = sl_price

        # TP = 1R (risk eşit ödül)
        risk = abs(entry_price - sl_price)
        if self.direction == POIType.LONG:
            self.tp_price = entry_price + risk
        else:
            self.tp_price = entry_price - risk

    def is_risk_valid(self) -> bool:
        return self.sl_price != self.entry_price  # sıfır-risk koruması

    def check_exit(self, high: float, low: float, current_time) -> bool:
        """TP veya SL'ye ulaşıldıysa True döner ve işlemi kapatır."""
        if self.direction == POIType.LONG:
            if low <= self.sl_price:
                self.status    = TradeStatus.LOSS
                self.exit_time = current_time
                return True
            if high >= self.tp_price:
                self.status    = TradeStatus.WIN
                self.exit_time = current_time
                return True
        else:  # SHORT
            if high >= self.sl_price:
                self.status    = TradeStatus.LOSS
                self.exit_time = current_time
                return True
            if low <= self.tp_price:
                self.status    = TradeStatus.WIN
                self.exit_time = current_time
                return True
        return False

    def __repr__(self):
        return (f"Trade({self.direction.name}, "
                f"Entry:{self.entry_price:.2f}, "
                f"SL:{self.sl_price:.2f}, TP:{self.tp_price:.2f}, "
                f"Status:{self.status.name})")
