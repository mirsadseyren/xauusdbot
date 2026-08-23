import uuid
from enum import Enum
from typing import Optional

class POIType(Enum):
    LONG = "LONG"   # Demand (Support)
    SHORT = "SHORT" # Supply (Resistance)

class POIStatus(Enum):
    ACTIVE = "ACTIVE"
    ARMED = "ARMED"
    CHOCH_CONFIRMED = "CHOCH_CONFIRMED"
    LEFT_AREA = "LEFT_AREA"
    MITIGATED = "MITIGATED"
    INVALIDATED = "INVALIDATED"

class TradeStatus(Enum):
    ACTIVE = "ACTIVE"
    WIN = "WIN"
    LOSS = "LOSS"

class POI:
    def __init__(self, start_time, confirm_time, top: float, bottom: float, poi_type: POIType):
        self.id = str(uuid.uuid4())
        self.start_time = start_time
        self.confirm_time = confirm_time
        self.top = top
        self.bottom = bottom
        self.poi_type = poi_type
        self.status = POIStatus.ACTIVE
        self.end_time = None
        self.choch_sl_price = None
        self.origin_time = None    # Signal candle time (where the pattern was first detected)
        self.origin_price = None   # Price at origin (start of the impulse move)
        self.confirm_price = None  # Close price at confirmation candle
        
    def is_valid_size(self, max_percent: float = 5.0) -> bool:
        """KURAL 1 - Maksimum Alan Boyutu Kuralı"""
        size_pct = ((self.top - self.bottom) / self.bottom) * 100
        return size_pct <= max_percent
        
    def is_price_inside(self, price: float) -> bool:
        return self.bottom <= price <= self.top
        
    def check_invalidation(self, current_high: float, current_low: float, current_time) -> bool:
        """
        Alanın içinde hiç işlem vermeden komple alanın içinden geçilip ihlal edilirse de alan geçersizleşir.
        İhlal kontrolünde fitiller (high/low) baz alınır.
        """
        if self.poi_type == POIType.LONG and current_low < self.bottom:
            self.status = POIStatus.INVALIDATED
            self.end_time = current_time
            return True
        if self.poi_type == POIType.SHORT and current_high > self.top:
            self.status = POIStatus.INVALIDATED
            self.end_time = current_time
            return True
        return False
        
    def __repr__(self):
        return f"POI({self.poi_type.name}, Top:{self.top:.2f}, Bottom:{self.bottom:.2f}, Status:{self.status.name})"


class Trade:
    def __init__(self, poi: POI, entry_price: float, entry_time):
        self.poi = poi
        self.entry_price = entry_price
        self.entry_time = entry_time
        self.direction = poi.poi_type
        self.status = TradeStatus.ACTIVE
        self.exit_time = None
        self.choch_time = None
        self.choch_price = None
        self.swing_time = None
        self.swing_price = None
        
        # Sabit %1 SL ve %1 TP
        if self.direction == POIType.LONG:
            self.sl_price = self.entry_price * 0.99
            self.tp_price = self.entry_price * 1.01
        else:
            self.sl_price = self.entry_price * 1.01
            self.tp_price = self.entry_price * 0.99
            
    def is_risk_valid(self) -> bool:
        """Maksimum Stop-Loss Sınırı (Statik %1 olduğu için hep geçerli)"""
        return True
        
    def check_exit(self, high: float, low: float, current_time) -> bool:
        """
        İşlemin TP veya SL olup olmadığını kontrol eder.
        True dönerse işlem kapanmıştır.
        """
        if self.direction == POIType.LONG:
            if low <= self.sl_price:
                self.status = TradeStatus.LOSS
                self.exit_time = current_time
                return True
            elif high >= self.tp_price:
                self.status = TradeStatus.WIN
                self.exit_time = current_time
                return True
        else: # SHORT
            if high >= self.sl_price:
                self.status = TradeStatus.LOSS
                self.exit_time = current_time
                return True
            elif low <= self.tp_price:
                self.status = TradeStatus.WIN
                self.exit_time = current_time
                return True
        return False
        
    def __repr__(self):
        return f"Trade({self.direction.name}, Entry:{self.entry_price:.2f}, SL:{self.sl_price:.2f}, TP:{self.tp_price:.2f}, Status:{self.status.name})"
