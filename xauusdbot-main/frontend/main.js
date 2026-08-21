// State
let currentTimeframe = '1h';
let chart = null;
let candlestickSeries = null;
let isDataLoading = false;
let earliestDataTime = null; 
let currentChartData = [];
let data4H = [];
let global4HAreas = [];

async function recalc4HAreas() {
    try {
        const res = await fetch('/api/backtest-results');
        const data = await res.json();
        if (data && !data.error) {
            global4HAreas = data.pois.map(poi => ({
                type: poi.type,
                box_start_time: poi.start_time,
                top: poi.top,
                bottom: poi.bottom,
                confirmed_time: poi.confirm_time
            }));
            
            window.globalTrades = data.trades.map(t => ({
                entry_time: t.entry_time,
                close_time: t.exit_time,
                trade_entry: t.entry_price,
                trade_sl: t.sl_price,
                trade_tp: t.tp_price,
                status: t.status,
                direction: t.direction
            }));
            console.log(`Loaded ${global4HAreas.length} POIs and ${window.globalTrades.length} trades from backend.`);
        }
    } catch(e) {
        console.error("Failed to load backtest results", e);
    }
}

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
                                let startTime = area.display_start_time || area.box_start_time;
                                let startX = timeScale.timeToCoordinate(startTime);
                                if (startX === null) {
                                    if (currentChartData.length > 0 && startTime < currentChartData[0].time) {
                                        startX = -9999;
                                    } else {
                                        return;
                                    }
                                }
                                
                                const endX = scope.bitmapSize.width;
                                const topY = _this.series.priceToCoordinate(area.top);
                                const bottomY = _this.series.priceToCoordinate(area.bottom);
                                
                                if (topY !== null && bottomY !== null) {
                                    // Dotted line logic removed as pbTime is not provided by backend

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

class TradePrimitive {
    constructor() {
        this.trades = [];
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
    
    setTrades(trades) {
        this.trades = trades;
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
                            
                            _this.trades.forEach(trade => {
                                let startX = timeScale.timeToCoordinate(trade.entry_time);
                                if (startX === null) {
                                    if (currentChartData.length > 0 && trade.entry_time < currentChartData[0].time) {
                                        startX = -9999;
                                    } else {
                                        return;
                                    }
                                } else {
                                    startX *= scope.horizontalPixelRatio;
                                }
                                
                                let endX = scope.bitmapSize.width;
                                if (trade.close_time) {
                                    let rawEndX = timeScale.timeToCoordinate(trade.close_time);
                                    if (rawEndX !== null) {
                                        endX = rawEndX * scope.horizontalPixelRatio;
                                    }
                                }
                                
                                const entryY = _this.series.priceToCoordinate(trade.trade_entry) * scope.verticalPixelRatio;
                                const slY = _this.series.priceToCoordinate(trade.trade_sl) * scope.verticalPixelRatio;
                                const tpY = _this.series.priceToCoordinate(trade.trade_tp) * scope.verticalPixelRatio;
                                
                                const w = endX - startX;
                                
                                // Draw Risk Box (Red)
                                ctx.fillStyle = 'rgba(239, 83, 80, 0.2)';
                                ctx.fillRect(startX, Math.min(entryY, slY), w, Math.abs(entryY - slY));
                                
                                // Draw Reward Box (Green)
                                ctx.fillStyle = 'rgba(38, 166, 154, 0.2)';
                                ctx.fillRect(startX, Math.min(entryY, tpY), w, Math.abs(entryY - tpY));
                                
                                // SL Line
                                ctx.beginPath();
                                ctx.moveTo(startX, slY);
                                ctx.lineTo(startX + w, slY);
                                ctx.strokeStyle = 'rgba(239, 83, 80, 1)';
                                ctx.lineWidth = 1 * scope.horizontalPixelRatio;
                                ctx.stroke();
                                
                                // TP Line
                                ctx.beginPath();
                                ctx.moveTo(startX, tpY);
                                ctx.lineTo(startX + w, tpY);
                                ctx.strokeStyle = 'rgba(38, 166, 154, 1)';
                                ctx.lineWidth = 1 * scope.horizontalPixelRatio;
                                ctx.stroke();
                            });
                        });
                    }
                };
            }
        }];
    }
}

let tradePrimitive = new TradePrimitive();



function updateIndicator() {
    if (!indicatorSettings.enabled || currentChartData.length === 0 || !global4HAreas) {
        areaPrimitive.setAreas([]);
        tradePrimitive.setTrades([]);
        return;
    }
    
    // Yalnızca ekranda görünen alandaki POI'leri filtrele veya hepsini gönder
    // Burada 1h/3m ayırt etmeksizin POI'leri ve işlemleri çizebiliriz.
    // İsterseniz sadece belirli timeframelerde çizebilirsiniz.
    areaPrimitive.setAreas(global4HAreas);
    
    if (window.globalTrades && currentTimeframe !== '4h' && currentTimeframe !== '1d') {
        tradePrimitive.setTrades(window.globalTrades);
    } else {
        tradePrimitive.setTrades([]);
    }
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
        candlestickSeries.attachPrimitive(tradePrimitive);
        
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
        await recalc4HAreas();
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
    recalc4HAreas();
    updateIndicator();
}

if (toggleAreasInput) toggleAreasInput.addEventListener('change', applySettings);
if (emaPeriodInput) emaPeriodInput.addEventListener('change', applySettings);
if (maxLookbackInput) maxLookbackInput.addEventListener('change', applySettings);
if (maxPercentInput) maxPercentInput.addEventListener('change', applySettings);

