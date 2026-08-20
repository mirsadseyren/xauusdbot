// State
let currentTimeframe = '1h';
let chart = null;
let candlestickSeries = null;
let isDataLoading = false;
let earliestDataTime = null; 
let currentChartData = [];

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
