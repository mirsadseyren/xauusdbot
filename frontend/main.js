// State
let currentTimeframe = '1h';
let chart = null;
let candlestickSeries = null;
let isDataLoading = false;
let earliestDataTime = null; 
let currentChartData = [];

// Indicator State & Custom Primitive
const indicatorSettings = {
    enabled: false,
    emaPeriod: 100,
    maxLookback: 6,
    maxPercent: 15
};

class AreaPrimitive {
    constructor() {
        this.areas = [];
        this.chart = null;
        this.series = null;
    }
    
    attached(params) {
        this.chart = params.chart;
        this.series = params.series;
        this.requestUpdate = params.requestUpdate;
    }
    
    detached() {
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
    }
    
    updateAllViews() {
        if (this.requestUpdate) this.requestUpdate();
    }
    
    setAreas(areas) {
        this.areas = areas;
        this.updateAllViews();
    }
    
    paneViews() {
        const _this = this;
        return [{
            update() {},
            renderer() {
                return {
                    draw(target) {
                        target.useBitmapCoordinateSpace((scope) => {
                            const ctx = scope.context;
                            if (!_this.series || !_this.chart) return;
                            
                            const timeScale = _this.chart.timeScale();
                            
                            _this.areas.forEach(area => {
                                const startX = timeScale.timeToCoordinate(area.box_start_time);
                                if (startX === null) return;
                                
                                const endX = scope.bitmapSize.width;
                                const topY = _this.series.priceToCoordinate(area.top);
                                const bottomY = _this.series.priceToCoordinate(area.bottom);
                                
                                if (topY !== null && bottomY !== null) {
                                    const pullbackStartX = timeScale.timeToCoordinate(area.pullback_start_time);
                                    const pullbackY = _this.series.priceToCoordinate(area.pullback_start_price);
                                    
                                    // Draw dotted line for the pullback movement
                                    if (pullbackStartX !== null && pullbackY !== null) {
                                        const extremumY = area.type === 'short' ? topY : bottomY;
                                        ctx.beginPath();
                                        ctx.setLineDash([5, 5]);
                                        ctx.moveTo(pullbackStartX * scope.horizontalPixelRatio, pullbackY * scope.verticalPixelRatio);
                                        ctx.lineTo(startX * scope.horizontalPixelRatio, extremumY * scope.verticalPixelRatio);
                                        ctx.strokeStyle = area.type === 'long' ? 'rgba(38, 166, 154, 0.8)' : 'rgba(239, 83, 80, 0.8)';
                                        ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
                                        ctx.stroke();
                                        ctx.setLineDash([]);
                                    }

                                    const x = Math.max(0, startX * scope.horizontalPixelRatio);
                                    const y = Math.min(topY, bottomY) * scope.verticalPixelRatio;
                                    const w = endX - x;
                                    const h = Math.abs(bottomY - topY) * scope.verticalPixelRatio;
                                    
                                    ctx.fillStyle = area.type === 'long' 
                                        ? 'rgba(38, 166, 154, 0.15)' 
                                        : 'rgba(239, 83, 80, 0.15)';
                                    
                                    ctx.fillRect(x, y, w, h);
                                    
                                    ctx.strokeStyle = area.type === 'long' 
                                        ? 'rgba(38, 166, 154, 0.5)' 
                                        : 'rgba(239, 83, 80, 0.5)';
                                    ctx.lineWidth = 1 * scope.horizontalPixelRatio;
                                    
                                    ctx.beginPath();
                                    ctx.moveTo(x, y);
                                    ctx.lineTo(x + w, y);
                                    ctx.stroke();
                                    
                                    ctx.beginPath();
                                    ctx.moveTo(x, y + h);
                                    ctx.lineTo(x + w, y + h);
                                    ctx.stroke();
                                }
                            });
                        });
                    }
                };
            }
        }];
    }
}

let areaPrimitive = new AreaPrimitive();

function calculateEMA(data, period) {
    if (data.length < period) return Array(data.length).fill(null);
    let k = 2 / (period + 1);
    let ema = Array(data.length).fill(null);
    let sum = 0;
    
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            sum += data[i].close;
        } else if (i === period - 1) {
            sum += data[i].close;
            ema[i] = sum / period;
        } else {
            ema[i] = data[i].close * k + ema[i - 1] * (1 - k);
        }
    }
    return ema;
}

function detectAreas(data, ema, settings) {
    let areas = [];
    if (!settings.enabled || currentTimeframe !== '4h') return areas;
    
    for (let i = 1; i < data.length; i++) {
        let candle = data[i];
        let prevCandle = data[i-1];
        let currentEma = ema[i];
        if (currentEma === null) continue;
        
        let isDowntrend = candle.close < currentEma;
        let isUptrend = candle.close > currentEma;
        
        // Downtrend -> Looking for Pullback (Green) -> Results in SHORT AREA (Supply)
        if (isDowntrend) {
            let isGreen = candle.close > candle.open;
            if (isGreen && prevCandle.close <= prevCandle.open) {
                let lookbackStart = Math.max(0, i - settings.maxLookback);
                let lowestLow = candle.low;
                let lowestIndex = i;
                for (let j = i; j >= lookbackStart; j--) {
                    if (data[j].low < lowestLow) {
                        lowestLow = data[j].low;
                        lowestIndex = j;
                    }
                }
                
                let highestHigh = candle.high;
                let highestIndex = i;
                let k = i + 1;
                let counterMovementEnded = false;
                
                for (; k < data.length; k++) {
                    let nextCandle = data[k];
                    if (nextCandle.high > highestHigh) {
                        highestHigh = nextCandle.high;
                        highestIndex = k;
                    }
                    if (nextCandle.close < lowestLow) { // confirmed close below area bottom
                        counterMovementEnded = true;
                        break;
                    }
                }
                
                if (counterMovementEnded) {
                    let percentMovement = ((highestHigh - lowestLow) / lowestLow) * 100;
                    if (percentMovement <= settings.maxPercent) {
                        areas.push({
                            type: 'short', // Downtrend pullback creates a SHORT area
                            box_start_time: data[highestIndex].time, // Start at the extremum
                            top: highestHigh,
                            bottom: lowestLow,
                            pullback_start_time: data[lowestIndex].time,
                            pullback_start_price: lowestLow
                        });
                        i = k; // skip ahead
                    }
                }
            }
        }
        // Uptrend -> Looking for Pullback (Red) -> Results in LONG AREA (Demand)
        else if (isUptrend) {
            let isRed = candle.close < candle.open;
            if (isRed && prevCandle.close >= prevCandle.open) {
                let lookbackStart = Math.max(0, i - settings.maxLookback);
                let highestHigh = candle.high;
                let highestIndex = i;
                for (let j = i; j >= lookbackStart; j--) {
                    if (data[j].high > highestHigh) {
                        highestHigh = data[j].high;
                        highestIndex = j;
                    }
                }
                
                let lowestLow = candle.low;
                let lowestIndex = i;
                let k = i + 1;
                let counterMovementEnded = false;
                
                for (; k < data.length; k++) {
                    let nextCandle = data[k];
                    if (nextCandle.low < lowestLow) {
                        lowestLow = nextCandle.low;
                        lowestIndex = k;
                    }
                    if (nextCandle.close > highestHigh) { // confirmed close above area top
                        counterMovementEnded = true;
                        break;
                    }
                }
                
                if (counterMovementEnded) {
                    let percentMovement = ((highestHigh - lowestLow) / lowestLow) * 100;
                    if (percentMovement <= settings.maxPercent) {
                        areas.push({
                            type: 'long', // Uptrend pullback creates a LONG area
                            box_start_time: data[lowestIndex].time, // Start at the extremum
                            top: highestHigh,
                            bottom: lowestLow,
                            pullback_start_time: data[highestIndex].time,
                            pullback_start_price: highestHigh
                        });
                        i = k;
                    }
                }
            }
        }
    }
    
    return areas;
}

function updateIndicator() {
    if (!indicatorSettings.enabled || currentTimeframe !== '4h' || currentChartData.length === 0) {
        areaPrimitive.setAreas([]);
        return;
    }
    
    const ema = calculateEMA(currentChartData, indicatorSettings.emaPeriod);
    const areas = detectAreas(currentChartData, ema, indicatorSettings);
    areaPrimitive.setAreas(areas);
}


// DOM Elements
const loadingOverlay = document.getElementById('loading');
const tfButtons = document.querySelectorAll('.tf-btn');
const chartContainer = document.getElementById('chart');

// Chart initialization
function initChart() {
    try {
        if (typeof LightweightCharts === 'undefined') {
            throw new Error("LightweightCharts kütüphanesi yüklenemedi. Lütfen sayfayı yenileyin.");
        }
        const chartOptions = {
            layout: {
                textColor: '#d1d4dc',
                background: { type: 'solid', color: '#0a0e17' },
            },
            grid: {
                vertLines: { color: '#1e222d' },
                horzLines: { color: '#1e222d' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: '#2b2b43',
            },
            rightPriceScale: {
                borderColor: '#2b2b43',
            }
        };
        
        // Ensure container has dimensions
        const rect = chartContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            chartContainer.style.height = '500px'; // fallback
        }
        
        chart = LightweightCharts.createChart(chartContainer, chartOptions);
        
        candlestickSeries = chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350'
        });
        
        candlestickSeries.attachPrimitive(areaPrimitive);

        window.addEventListener('resize', () => {
            if (chart && chartContainer) {
                chart.resize(chartContainer.clientWidth, chartContainer.clientHeight);
            }
        });

        chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChanged);
        console.log("Chart initialized successfully.");
    } catch (e) {
        console.error("Error in initChart:", e);
        throw e;
    }
}

// Fetch data from API
async function fetchOHLC(timeframe, endTime = null) {
    let url = `/api/ohlc?timeframe=${timeframe}`;
    
    const secondsToFetchMap = {
        '1m': 10 * 24 * 60 * 60,  // 10 days
        '3m': 30 * 24 * 60 * 60,  // 30 days
        '5m': 60 * 24 * 60 * 60,  // 60 days
        '10m': 120 * 24 * 60 * 60,
        '15m': 180 * 24 * 60 * 60,
        '1h': 365 * 24 * 60 * 60, // 1 year
        '4h': 5 * 365 * 24 * 60 * 60, // 5 years
        '1d': 25 * 365 * 24 * 60 * 60 // all data
    };
    
    const secondsToFetch = secondsToFetchMap[timeframe] || 30 * 24 * 60 * 60;
    
    let startTs = 0;
    if (!endTime) {
         // Şu anki zamandan geriye git
         const latestTs = Math.floor(Date.now() / 1000);
         startTs = latestTs - secondsToFetch;
         url += `&start_time=${startTs}`;
    } else {
         startTs = Math.floor(endTime - secondsToFetch);
         url += `&start_time=${startTs}&end_time=${Math.floor(endTime)}`;
    }
    
    console.log("Fetching from URL:", url);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Sunucu Hatası: ${response.status}`);
    }
    
    const data = await response.json();
    if (data && data.error) {
        throw new Error(data.error);
    }
    
    return data || [];
}

// Load initial data
async function loadChartData(timeframe) {
    if (!candlestickSeries) {
        console.error("Cannot load data because chart is not initialized properly.");
        loadingOverlay.innerHTML = `<p style="color:#ef5350; background:#151a24; padding:15px; border:1px solid #ef5350; border-radius:5px;">Grafik başlatılamadığı için veri çekilemiyor.</p>`;
        showLoading(true);
        return;
    }

    showLoading(true);
    try {
        earliestDataTime = null;
        currentChartData = [];
        candlestickSeries.setData([]); 
        
        const data = await fetchOHLC(timeframe);
        if (data && data.length > 0) {
            currentChartData = data;
            candlestickSeries.setData(currentChartData);
            earliestDataTime = currentChartData[0].time;
            updateIndicator();
        } else {
            console.warn("Veri bulunamadı.");
        }
    } catch (e) {
        console.error("Hata:", e);
        loadingOverlay.innerHTML = `<p style="color:#ef5350; background:#151a24; padding:15px; border:1px solid #ef5350; border-radius:5px;">Veri Çekilemedi: ${e.message}</p>`;
        showLoading(true);
        return;
    }
    showLoading(false);
}

// Lazy loading on scroll left
async function onVisibleLogicalRangeChanged(newVisibleLogicalRange) {
    if (!newVisibleLogicalRange || isDataLoading || !earliestDataTime) {
        return;
    }

    if (newVisibleLogicalRange.from < 100) {
        isDataLoading = true;
        showLoading(true); 
        
        try {
            const oldData = await fetchOHLC(currentTimeframe, earliestDataTime);
            
            if (oldData && oldData.length > 0) {
                if (oldData[oldData.length - 1].time >= earliestDataTime) {
                    oldData.pop();
                }
                
                if (oldData.length > 0) {
                    currentChartData = [...oldData, ...currentChartData];
                    candlestickSeries.setData(currentChartData);
                    earliestDataTime = currentChartData[0].time;
                    updateIndicator();
                }
            }
        } catch (e) {
            console.error("Geçmiş veri yüklenirken hata:", e);
        }
        
        isDataLoading = false;
        showLoading(false);
    }
}

function showLoading(show) {
    if (show) {
        loadingOverlay.classList.remove('hidden');
    } else {
        loadingOverlay.classList.add('hidden');
    }
}

tfButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
        tfButtons.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        
        const newTf = e.target.getAttribute('data-tf');
        if (newTf !== currentTimeframe) {
            currentTimeframe = newTf;
            loadChartData(currentTimeframe);
        }
    });
});

// Application startup
(async function startup() {
    try {
        console.log("Starting application...");
        initChart();
        await loadChartData(currentTimeframe);
    } catch (e) {
        console.error("Başlatma hatası:", e);
        loadingOverlay.innerHTML = `<p style="color:#ef5350; background:#151a24; padding:15px; border:1px solid #ef5350; border-radius:5px; text-align:center;">Hata: ${e.message}<br><br>Lütfen sayfayı yenileyin.</p>`;
        showLoading(true);
    }
})();

// UI Setup for Indicator Menu
const indicatorBtn = document.getElementById('indicator-btn');
const indicatorMenu = document.getElementById('indicator-menu');
const closeMenuBtn = document.getElementById('close-menu-btn');
const toggleAreasInput = document.getElementById('toggle-areas');
const emaPeriodInput = document.getElementById('ema-period');
const maxLookbackInput = document.getElementById('max-lookback');
const maxPercentInput = document.getElementById('max-percent');

if (indicatorBtn) {
    indicatorBtn.addEventListener('click', () => {
        indicatorMenu.classList.toggle('hidden');
    });
}
if (closeMenuBtn) {
    closeMenuBtn.addEventListener('click', () => {
        indicatorMenu.classList.add('hidden');
    });
}

function applySettings() {
    indicatorSettings.enabled = toggleAreasInput.checked;
    indicatorSettings.emaPeriod = parseInt(emaPeriodInput.value) || 100;
    indicatorSettings.maxLookback = parseInt(maxLookbackInput.value) || 6;
    indicatorSettings.maxPercent = parseInt(maxPercentInput.value) || 15;
    updateIndicator();
}

if (toggleAreasInput) toggleAreasInput.addEventListener('change', applySettings);
if (emaPeriodInput) emaPeriodInput.addEventListener('change', applySettings);
if (maxLookbackInput) maxLookbackInput.addEventListener('change', applySettings);
if (maxPercentInput) maxPercentInput.addEventListener('change', applySettings);

