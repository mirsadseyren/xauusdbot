// State
const tzOffsetSeconds = new Date().getTimezoneOffset() * 60;
let currentTimeframe = '1h';
let chart = null;
let candlestickSeries = null;
let isDataLoading = false;
let earliestDataTime = null; 
let currentChartData = [];
let data4H = [];
let global4HAreas = [];

async function fetchRangeOHLC(tf, startTime, endTime = null) {
    let url = `/api/ohlc?timeframe=${tf}&start_time=${startTime}`;
    if (endTime) {
        url += `&end_time=${endTime}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    if (data && !data.error) {
        return data.map(d => ({...d, time: d.time - tzOffsetSeconds}));
    }
    return data;
}

function updatePrimitiveTimestamps() {
    if (!currentChartData || currentChartData.length === 0) return;
    
    if (global4HAreas) {
        global4HAreas.forEach(area => {
            let startIndex = currentChartData.findIndex(c => c.time >= area.box_start_time);
            if (startIndex !== -1) area.display_start_time = currentChartData[startIndex].time;
            
            if (area.end_time) {
                let endIndex = currentChartData.findIndex(c => c.time >= area.end_time);
                if (endIndex !== -1) area.display_end_time = currentChartData[endIndex].time;
            }
        });
    }
    
    if (window.globalTrades) {
        window.globalTrades.forEach(t => {
            if (t.entry_time) {
                let entryIndex = currentChartData.findIndex(c => c.time >= t.entry_time);
                if (entryIndex !== -1) t.display_entry_time = currentChartData[entryIndex].time;
            }
            if (t.close_time) {
                let closeIndex = currentChartData.findIndex(c => c.time >= t.close_time);
                if (closeIndex !== -1) t.display_close_time = currentChartData[closeIndex].time;
            }
        });
    }
}

async function recalc4HAreas() {
    try {
        const res = await fetch('/api/backtest-results');
        const data = await res.json();
        if (data && !data.error) {
            global4HAreas = data.pois.map(poi => ({
                type: poi.type,
                status: poi.status || 'unknown',
                box_start_time: poi.start_time - tzOffsetSeconds,
                end_time: poi.end_time ? poi.end_time - tzOffsetSeconds : null,
                top: poi.top,
                bottom: poi.bottom,
                confirmed_time: poi.confirm_time - tzOffsetSeconds,
                origin_time: poi.origin_time ? poi.origin_time - tzOffsetSeconds : null,
                origin_price: poi.origin_price,
                confirm_price: poi.confirm_price
            }));
            
            window.globalTrades = data.trades.map(t => ({
                entry_time: t.entry_time - tzOffsetSeconds,
                close_time: t.exit_time ? t.exit_time - tzOffsetSeconds : null,
                trade_entry: t.entry_price,
                trade_sl: t.sl_price,
                trade_tp: t.tp_price,
                status: t.status,
                direction: t.direction,
                choch_time: t.choch_time ? t.choch_time - tzOffsetSeconds : null,
                choch_price: t.choch_price,
                swing_time: t.swing_time ? t.swing_time - tzOffsetSeconds : null,
                swing_price: t.swing_price
            }));
            
            console.log(`Loaded ${global4HAreas.length} POIs and ${window.globalTrades.length} trades from backend.`);
            
            updatePrimitiveTimestamps();
            renderTradesList();
        }
    } catch(e) {
        console.error("Failed to load backtest results", e);
    }
}

function renderTradesList() {
    const listEl = document.getElementById('trades-list');
    const winRateEl = document.getElementById('win-rate');
    const totalEl = document.getElementById('total-trades');
    if (!listEl || !window.globalTrades) return;
    
    listEl.innerHTML = '';
    let wins = 0;
    
    window.globalTrades.forEach((t, index) => {
        if (t.status === 'win') wins++;
        
        const item = document.createElement('div');
        item.className = `trade-item ${t.status}`;
        
        // Add the tzOffsetSeconds back to get real UTC time, then format as UTC
        // This ensures the displayed string exactly matches the local time intended.
        const realUtcTime = (t.entry_time + tzOffsetSeconds) * 1000;
        const dateStr = new Date(realUtcTime).toLocaleString('tr-TR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        
        item.innerHTML = `
            <div class="trade-header">
                <span>#${index + 1} ${t.direction.toUpperCase()}</span>
                <span class="${t.status}-text">${t.status.toUpperCase()}</span>
            </div>
            <div class="trade-details">
                <span>Entry: ${t.trade_entry.toFixed(2)}</span>
                <span>Date: ${dateStr}</span>
                <span>TP: ${t.trade_tp.toFixed(2)}</span>
                <span>SL: ${t.trade_sl.toFixed(2)}</span>
            </div>
        `;
        
        item.addEventListener('click', () => jumpToTrade(t.entry_time));
        listEl.appendChild(item);
    });
    
    totalEl.textContent = `Total: ${window.globalTrades.length}`;
    if (window.globalTrades.length > 0) {
        winRateEl.textContent = `Win Rate: ${((wins / window.globalTrades.length) * 100).toFixed(1)}%`;
    }
}

async function jumpToTrade(time) {
    if (currentTimeframe !== '3m') {
        const btn = Array.from(document.querySelectorAll('.tf-btn')).find(b => b.getAttribute('data-tf') === '3m');
        if (btn) btn.click();
        
        // Wait for data to load
        await new Promise(r => setTimeout(r, 800));
    }
    
    if (!chart || !currentChartData || currentChartData.length === 0) return;
    
    let targetIndex = currentChartData.findIndex(c => c.time >= time);
    
    // If not in current data, we need to fetch historical data around that time
    if (targetIndex === -1 || targetIndex < 100) {
        showLoading(true);
        try {
            // Alanın tamamını (POI) görebilmek için işlemden 10 gün öncesine kadar veri çekiyoruz
            const data = await fetchRangeOHLC('3m', time - 10*24*60*60, time + 5*24*60*60);
            if (data && data.length > 0) {
                currentChartData = data;
                candlestickSeries.setData(currentChartData);
                earliestDataTime = currentChartData[0].time;
                
                // Wait for the chart to process the new data visually
                await new Promise(r => requestAnimationFrame(r));
                
                updatePrimitiveTimestamps(); // VERY IMPORTANT: Recalculate timestamps for new data
                updateIndicator();
                
                // Wait again for custom primitives to be added
                await new Promise(r => requestAnimationFrame(r));
                
                targetIndex = currentChartData.findIndex(c => c.time >= time);
            }
        } catch (e) {
            console.error("Failed to load historical data for trade jump", e);
        }
        showLoading(false);
    }
    
    if (targetIndex !== -1) {
        chart.timeScale().setVisibleLogicalRange({
            from: targetIndex - 50,
            to: targetIndex + 50
        });
        // Wait for time scale to update before autoscaling
        setTimeout(() => {
            chart.priceScale('right').applyOptions({ autoScale: true });
        }, 50);
    }
}

// Indicator State & Custom Primitive
const indicatorSettings = {
    enabled: false,
    showValidAreas: true,
    showInvalidAreas: true,
    showTrades: true,
    showChoch: true,
    showFormation: true,
    emaPeriod: 100,
    maxLookback: 6,
    maxPercent: 6
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
                                let endX = scope.bitmapSize.width;
                                if (area.end_time) {
                                    let displayEndTime = area.display_end_time || area.end_time;
                                    let rawEndX = timeScale.timeToCoordinate(displayEndTime);
                                    if (rawEndX !== null) {
                                        endX = rawEndX * scope.horizontalPixelRatio;
                                    } else {
                                        if (currentChartData.length > 0 && displayEndTime < currentChartData[0].time) {
                                            endX = -9999;
                                        }
                                    }
                                }
                                
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
                                    // Top border
                                    ctx.moveTo(x, y);
                                    ctx.lineTo(x + w, y);
                                    
                                    // Bottom border
                                    ctx.moveTo(x, y + h);
                                    ctx.lineTo(x + w, y + h);
                                    
                                    // Right border (if area has ended)
                                    if (area.end_time) {
                                        ctx.moveTo(x + w, y);
                                        ctx.lineTo(x + w, y + h);
                                    }
                                    
                                    // Left border
                                    ctx.moveTo(x, y);
                                    ctx.lineTo(x, y + h);
                                    
                                    ctx.stroke();
                                }
                                
                                // Draw formation impulse line (origin → area start)
                                if (indicatorSettings.showFormation && area.origin_price != null) {
                                    const originX_raw = timeScale.timeToCoordinate(area.origin_time);
                                    const startX_raw = timeScale.timeToCoordinate(area.display_start_time || area.box_start_time);
                                    
                                    if (originX_raw !== null && startX_raw !== null) {
                                        const oX = originX_raw * scope.horizontalPixelRatio;
                                        const sX = startX_raw * scope.horizontalPixelRatio;
                                        const oY = _this.series.priceToCoordinate(area.origin_price) * scope.verticalPixelRatio;
                                        // Area start price: SHORT = top (highest_high), LONG = bottom (lowest_low)
                                        const sY = _this.series.priceToCoordinate(
                                            area.type === 'long' ? area.bottom : area.top
                                        ) * scope.verticalPixelRatio;
                                        
                                        const lineColor = area.type === 'long'
                                            ? 'rgba(38, 166, 154, 0.9)'
                                            : 'rgba(239, 83, 80, 0.9)';
                                        
                                        ctx.beginPath();
                                        ctx.moveTo(oX, oY);
                                        ctx.lineTo(sX, sY);
                                        ctx.strokeStyle = lineColor;
                                        ctx.lineWidth = 2 * scope.horizontalPixelRatio;
                                        ctx.setLineDash([]);
                                        ctx.stroke();
                                        
                                        // Origin dot (start of impulse)
                                        ctx.beginPath();
                                        ctx.arc(oX, oY, 3 * scope.horizontalPixelRatio, 0, 2 * Math.PI);
                                        ctx.fillStyle = '#ffffff';
                                        ctx.fill();
                                        ctx.strokeStyle = lineColor;
                                        ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
                                        ctx.stroke();
                                        
                                        // Area start dot
                                        ctx.beginPath();
                                        ctx.arc(sX, sY, 3 * scope.horizontalPixelRatio, 0, 2 * Math.PI);
                                        ctx.fillStyle = lineColor;
                                        ctx.fill();
                                    }
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
                                    let displayEndTime = trade.display_close_time || trade.close_time;
                                    let rawEndX = timeScale.timeToCoordinate(displayEndTime);
                                    if (rawEndX !== null) {
                                        endX = rawEndX * scope.horizontalPixelRatio;
                                    } else {
                                        if (currentChartData.length > 0 && displayEndTime < currentChartData[0].time) {
                                            endX = -9999;
                                        }
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
                                
                                // Right vertical closing line for trade boxes
                                if (trade.close_time) {
                                    ctx.beginPath();
                                    ctx.moveTo(startX + w, Math.min(entryY, slY, tpY));
                                    ctx.lineTo(startX + w, Math.max(entryY, slY, tpY));
                                    ctx.strokeStyle = trade.status === 'win' ? 'rgba(38, 166, 154, 0.8)' : 'rgba(239, 83, 80, 0.8)';
                                    ctx.stroke();
                                }
                                
                                // Draw CHoCH and Swing Points if available
                                if (indicatorSettings.showChoch && trade.choch_time && trade.swing_time) {
                                    let chochX = timeScale.timeToCoordinate(trade.choch_time);
                                    let swingX = timeScale.timeToCoordinate(trade.swing_time);
                                    
                                    if (chochX !== null && swingX !== null) {
                                        chochX *= scope.horizontalPixelRatio;
                                        swingX *= scope.horizontalPixelRatio;
                                        
                                        const chochY = _this.series.priceToCoordinate(trade.choch_price) * scope.verticalPixelRatio;
                                        const swingY = _this.series.priceToCoordinate(trade.swing_price) * scope.verticalPixelRatio;
                                        
                                        // Draw Swing Point Dot
                                        ctx.beginPath();
                                        ctx.arc(swingX, swingY, 4 * scope.horizontalPixelRatio, 0, 2 * Math.PI);
                                        ctx.fillStyle = '#ff9800'; // Orange
                                        ctx.fill();
                                        
                                        // Draw CHoCH Point Dot
                                        ctx.beginPath();
                                        ctx.arc(chochX, chochY, 4 * scope.horizontalPixelRatio, 0, 2 * Math.PI);
                                        ctx.fillStyle = '#2196f3'; // Blue
                                        ctx.fill();
                                        
                                        // Draw dashed line between them
                                        ctx.beginPath();
                                        ctx.moveTo(swingX, swingY);
                                        ctx.lineTo(chochX, chochY);
                                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                                        ctx.setLineDash([5, 5]);
                                        ctx.stroke();
                                        ctx.setLineDash([]); // Reset
                                    }
                                }
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
    
    let areas = [];
    if (indicatorSettings.enabled) {
        areas = global4HAreas.filter(area => {
            if (area.status === 'invalidated') {
                return indicatorSettings.showInvalidAreas;
            } else if (area.status === 'mitigated') {
                return indicatorSettings.showValidAreas;
            } else {
                // Kullanıcının tanımına göre: "sadece işlem açmaya neden olan alanlar valid"
                // Bu yüzden henüz işlem görmemiş (ACTIVE/ARMED) alanlar hiçbir şekilde gösterilmeyecek.
                return false;
            }
        }).map(area => ({...area}));
    }
    
    areas.forEach(area => {
        let startIndex = currentChartData.findIndex(c => c.time >= area.box_start_time);
        if (startIndex !== -1) {
            area.display_start_time = currentChartData[startIndex].time;
        }
        if (area.end_time) {
            let endIndex = currentChartData.findIndex(c => c.time >= area.end_time);
            if (endIndex !== -1) {
                area.display_end_time = currentChartData[endIndex].time;
            }
        }
    });
    
    areaPrimitive.setAreas(areas);
    
    if (indicatorSettings.enabled && indicatorSettings.showTrades && window.globalTrades && currentTimeframe !== '4h' && currentTimeframe !== '1d') {
        let trades = window.globalTrades.map(t => ({...t}));
        trades.forEach(t => {
            let entryIndex = currentChartData.findIndex(c => c.time >= t.entry_time);
            if (entryIndex !== -1) t.display_entry_time = currentChartData[entryIndex].time;
            
            if (t.close_time) {
                let closeIndex = currentChartData.findIndex(c => c.time >= t.close_time);
                if (closeIndex !== -1) t.display_close_time = currentChartData[closeIndex].time;
            }
        });
        tradePrimitive.setTrades(trades);
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
    
    return data.map(d => ({...d, time: d.time - tzOffsetSeconds})) || [];
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
const toggleValidAreasInput = document.getElementById('toggle-valid-areas');
const toggleInvalidAreasInput = document.getElementById('toggle-invalid-areas');
const toggleTradesInput = document.getElementById('toggle-trades');
const toggleChochInput = document.getElementById('toggle-choch');
const toggleFormationInput = document.getElementById('toggle-formation');
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
    indicatorSettings.showValidAreas = toggleValidAreasInput ? toggleValidAreasInput.checked : true;
    indicatorSettings.showInvalidAreas = toggleInvalidAreasInput ? toggleInvalidAreasInput.checked : true;
    indicatorSettings.showTrades = toggleTradesInput ? toggleTradesInput.checked : true;
    indicatorSettings.showChoch = toggleChochInput ? toggleChochInput.checked : true;
    indicatorSettings.showFormation = toggleFormationInput ? toggleFormationInput.checked : true;
    indicatorSettings.emaPeriod = parseInt(emaPeriodInput.value) || 100;
    indicatorSettings.maxLookback = parseInt(maxLookbackInput.value) || 6;
    indicatorSettings.maxPercent = parseInt(maxPercentInput.value) || 6;
    updateIndicator();
}

if (toggleAreasInput) toggleAreasInput.addEventListener('change', applySettings);
if (toggleValidAreasInput) toggleValidAreasInput.addEventListener('change', applySettings);
if (toggleInvalidAreasInput) toggleInvalidAreasInput.addEventListener('change', applySettings);
if (toggleTradesInput) toggleTradesInput.addEventListener('change', applySettings);
if (toggleChochInput) toggleChochInput.addEventListener('change', applySettings);
if (toggleFormationInput) toggleFormationInput.addEventListener('change', applySettings);
// Parameters are now submitted via the Run Backtest button

const runBacktestBtn = document.getElementById('run-backtest-btn');
if (runBacktestBtn) {
    runBacktestBtn.addEventListener('click', async () => {
        indicatorMenu.classList.add('hidden');
        showLoading(true);
        try {
            const reqBody = {
                emaPeriod: parseInt(emaPeriodInput.value) || 100,
                maxLookback: parseInt(maxLookbackInput.value) || 6,
                maxPercent: parseFloat(maxPercentInput.value) || 6.0
            };
            
            const res = await fetch('/api/run-backtest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody)
            });
            
            const data = await res.json();
            if (data && !data.error) {
                global4HAreas = data.pois.map(poi => ({
                    type: poi.type,
                    status: poi.status || 'unknown',
                    box_start_time: poi.start_time - tzOffsetSeconds,
                    end_time: poi.end_time ? poi.end_time - tzOffsetSeconds : null,
                    top: poi.top,
                    bottom: poi.bottom,
                    confirmed_time: poi.confirm_time - tzOffsetSeconds,
                    origin_time: poi.origin_time ? poi.origin_time - tzOffsetSeconds : null,
                    origin_price: poi.origin_price,
                    confirm_price: poi.confirm_price
                }));
                
                window.globalTrades = data.trades.map(t => ({
                    entry_time: t.entry_time - tzOffsetSeconds,
                    close_time: t.exit_time ? t.exit_time - tzOffsetSeconds : null,
                    trade_entry: t.entry_price,
                    trade_sl: t.sl_price,
                    trade_tp: t.tp_price,
                    status: t.status,
                    direction: t.direction,
                    choch_time: t.choch_time ? t.choch_time - tzOffsetSeconds : null,
                    choch_price: t.choch_price,
                    swing_time: t.swing_time ? t.swing_time - tzOffsetSeconds : null,
                    swing_price: t.swing_price
                }));
                
                renderTradesList();
                updateIndicator();
            } else {
                alert("Error running backtest: " + (data.error || "Unknown"));
            }
        } catch (e) {
            console.error(e);
            alert("Network error running backtest.");
        }
        showLoading(false);
    });
}

