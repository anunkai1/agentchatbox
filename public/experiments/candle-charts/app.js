"use strict";
(function () {
  // ============================== config ==============================
  const INTERVALS = [
    ["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600],
    ["4h", 14400], ["12h", 43200], ["1d", 86400], ["1w", 604800],
    ["1M", 2629800],
  ];
  const INTERVAL_SEC = Object.fromEntries(INTERVALS);
  const SPOT_SYMBOLS = ["BTC", "ETH", "SOL", "DOGE", "BNB", "ADA", "LINK"];
  const HYPERLIQUID_SYMBOLS = [...SPOT_SYMBOLS, "VVV"];
  const BINANCE_SYMBOLS = [...SPOT_SYMBOLS, "ETHBTC"];
  const binancePair = (symbol) => symbol === "ETHBTC" ? symbol : `${symbol}USDT`;
  // Hyperliquid "xyz" builder DEX (HIP-3): tokenised commodities / RWA.
  // Delisted markets (URANIUM, ALUMINIUM) return no candles — excluded.
  const XYZ_SYMBOLS = [
    "xyz:GOLD", "xyz:SILVER", "xyz:PLATINUM", "xyz:PALLADIUM",
    "xyz:COPPER", "xyz:BRENTOIL", "xyz:CL", "xyz:NATGAS",
  ];
  // top 15 xyz markets by 24h notional volume (measured 04/09/2026),
  // excluding commodities already in the RWA tab
  const XYZ_STOCKS = [
    "xyz:SP500", "xyz:XYZ100", "xyz:NVDA", "xyz:HOOD", "xyz:TSLA",
    "xyz:MSTR", "xyz:META", "xyz:GOOGL", "xyz:INTC", "xyz:AAPL",
    "xyz:SOXL", "xyz:AVGO", "xyz:COIN", "xyz:DELL", "xyz:AMZN",
  ];

  async function hlFetch(coin, interval, limit, signal) {
    const lim = limit || REST_LIMIT;
    const ivMs = INTERVAL_SEC[interval] * 1000;
    const body = {
      type: "candleSnapshot",
      req: {
        coin,
        interval,
        startTime: Date.now() - lim * ivMs,
        endTime: Date.now(),
      },
    };
    const rows = await fetchJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return rows.map((r) => ({
      time: Math.floor(+r.t / 1000),
      open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v,
    }));
  }

  function hlSocket(coin, interval, onKline) {
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "candle", coin, interval },
      }));
      ws._ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"method":"ping"}');
      }, 30000);
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.channel === "candle" && msg.data) {
          const d = msg.data;
          onKline({
            time: Math.floor(+d.t / 1000),
            open: +d.o, high: +d.h, low: +d.l, close: +d.c, volume: +d.v,
          });
        }
      } catch (_) { /* ignore malformed */ }
    });
    return ws;
  }
  const REST_LIMIT = 500;
  const EMA_PERIOD = 8;
  const RSI_PERIOD = 14;
  const LS_SETTINGS = "cc-settings-v1";
  const LS_DRAWINGS = "cc-drawings-v1";

  const SOURCES = {
    binance: {
      label: "Binance Spot",
      symbols: BINANCE_SYMBOLS,
      display: (s) => s === "ETHBTC" ? "ETH/BTC" : s + "USDT",
      fetchKlines: async (symbol, interval, limit, signal) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${binancePair(symbol)}&interval=${interval}&limit=${limit || REST_LIMIT}`;
        const rows = await fetchJson(url, { signal });
        return rows.map((r) => ({
          time: Math.floor(r[0] / 1000),
          open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
        }));
      },
      openSocket: (symbol, interval, onKline) => {
        const ws = new WebSocket(`wss://stream.binance.com/ws/${binancePair(symbol).toLowerCase()}@kline_${interval}`);
        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.e === "kline" && msg.k) {
              onKline({
                time: Math.floor(msg.k.t / 1000),
                open: +msg.k.o, high: +msg.k.h, low: +msg.k.l,
                close: +msg.k.c, volume: +msg.k.v,
              });
            }
          } catch (_) { /* ignore malformed */ }
        });
        return ws;
      },
      pollStaleMs: 6000, // spot WS streams fine; poll only covers dead connections
    },
    hyperliquid: {
      label: "Hyperliquid",
      symbols: HYPERLIQUID_SYMBOLS,
      display: (s) => s,
      fetchKlines: hlFetch,
      openSocket: hlSocket,
      pollStaleMs: 25000,
    },
    xyz: {
      label: "xyz RWA",
      symbols: XYZ_SYMBOLS,
      display: (s) => s.replace("xyz:", ""),
      fetchKlines: hlFetch,
      openSocket: hlSocket,
      pollStaleMs: 25000,
    },
    xyzStocks: {
      label: "xyz Stocks",
      symbols: XYZ_STOCKS,
      display: (s) => s.replace("xyz:", ""),
      fetchKlines: hlFetch,
      openSocket: hlSocket,
      pollStaleMs: 25000,
    },
  };

  // ============================== state ==============================
  const settings = loadSettings();
  // Telegram chart links select an allowlisted market without changing alerts.
  const chartLink = new URLSearchParams(location.search);
  const linkedSource = chartLink.get("source"), linkedSymbol = chartLink.get("symbol");
  if (Object.hasOwn(SOURCES, linkedSource) && SOURCES[linkedSource].symbols.includes(linkedSymbol)) {
    settings.source = linkedSource;
    settings.symbol = linkedSymbol;
    settings.symbolBySource[linkedSource] = linkedSymbol;
  }
  let alertUI = null;
  let candles = [];              // sorted, de-duplicated, valid bars
  let emaValues = [];            // aligned with candles (null until index 7)
  let rsiValues = [];            // aligned with candles (null until index 14)
  let rsiStates = [];            // per-bar Wilder {avgG, avgL} state for trigger curves
  let obTriggerPoints = [], osTriggerPoints = [];
  let currentPrecision = 2;
  let liveSocket = null;
  let retryTimer = null;
  let watchdogTimer = null;
  let retryAttempt = 0;
  let socketToken = 0;           // invalidates stale socket callbacks/retries
  let loadToken = 0;             // latest history request wins
  let historyController = null;
  let historyRetryAt = 0;
  let historyRetryAttempt = 0;
  let lastTickTs = 0;
  let lastLoadTs = 0;
  let loading = false;
  let polling = false;
  let tool = null;               // 'hline' | 'trend' | 'measure'
  let anchor = null;             // first placed point while drawing
  let cursorXY = null;           // preview cursor position
  let drawings = loadDrawings(); // { "source|symbol": [ {id,type,points,color} ] }
  let needOverlayDraw = false;
  let needRSIDraw = false;
  let drawFrame = 0;
  let drawFrameIsTimeout = false;
  let hover = null;              // {x, time} while the crosshair is over the chart
  let measure = null;            // {a:{time,price}, b:{time,price}} measurement box
  let favouriteGesture = null;   // pointer state for favourite scrolling/reordering
  let favouriteMomentumFrame = 0;
  let suppressFavouriteClick = false;

  // ============================== dom ==============================
  const $ = (id) => document.getElementById(id);
  const elSymbol = $("symbol");
  const elIntervals = $("intervals");
  const elLegend = $("legend");
  const elLastPrice = $("last-price");
  const elMain = $("main-chart");
  const elRsi = $("rsi-chart");
  const elFavourites = $("favourites");
  const elFavouriteToggle = $("btn-favourite");
  let lastLegendHtml = "";

  function setLegendText(text) {
    lastLegendHtml = "";
    elLegend.textContent = text;
  }

  function reportError(reason) {
    const message = reason && reason.message ? reason.message : String(reason || "unknown error");
    setLegendText(`Error: ${message}`);
  }
  window.addEventListener("error", (e) => reportError(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

  // ============================== chart ==============================
  const timeFormatters = {
    intraday: new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    date: new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "2-digit" }),
    month: new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", month: "short", year: "2-digit" }),
    full: new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
  function dateForChartTime(time) {
    if (typeof time === "number") return new Date(time * 1000);
    return new Date(Date.UTC(time.year, time.month - 1, time.day));
  }
  function formatTimeTick(time) {
    const d = dateForChartTime(time);
    if (settings.interval === "1M") return timeFormatters.month.format(d);
    if (settings.interval === "1d" || settings.interval === "1w") return timeFormatters.date.format(d);
    return timeFormatters.intraday.format(d);
  }

  const chartOpts = () => ({
    layout: { background: { type: "solid", color: "#0b0e11" }, textColor: "#848e9c", fontSize: 11 },
    grid: {
      vertLines: { color: "#161b22" },
      horzLines: { color: "#161b22" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#5d6876", width: 1, style: 3, labelBackgroundColor: "#1e2329" },
      horzLine: { color: "#5d6876", width: 1, style: 3, labelBackgroundColor: "#1e2329" },
    },
    rightPriceScale: { borderColor: "#1e2329" },
    timeScale: {
      borderColor: "#1e2329", timeVisible: true, secondsVisible: false,
      rightOffset: 8, barSpacing: 8, tickMarkFormatter: formatTimeTick,
    },
    localization: { locale: "en-AU", timeFormatter: (time) => timeFormatters.full.format(dateForChartTime(time)) },
  });

  const chart = LightweightCharts.createChart(elMain, chartOpts());
  const candleSeries = chart.addCandlestickSeries({
    upColor: "#0ecb81", downColor: "#f6465d",
    borderUpColor: "#0ecb81", borderDownColor: "#f6465d",
    wickUpColor: "#0ecb81", wickDownColor: "#f6465d",
  });
  // candles occupy the upper part; legend headroom at top, volume strip at the bottom
  candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.16 } });
  const volumeSeries = chart.addHistogramSeries({
    priceScaleId: "vol",
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, visible: false });
  const emaSeries = chart.addLineSeries({
    color: "#f0b90b", lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    invalidateOverlay();
    invalidateRSI();
  });

  // ============================== overlay canvas (drawings) ==============================
  const overlay = document.createElement("canvas");
  overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;";
  elMain.style.position = "relative";
  elMain.appendChild(overlay);
  const octx = overlay.getContext("2d");

  const DRAW_COLORS = ["#f0b90b", "#38bdf8", "#a78bfa", "#fb7185", "#34d399", "#fbbf24"];

  function key() { return `${settings.source}|${settings.symbol}`; }
  function drawingsFor() {
    if (!drawings[key()]) drawings[key()] = [];
    return drawings[key()];
  }
  function saveDrawings() {
    try { localStorage.setItem(LS_DRAWINGS, JSON.stringify(drawings)); } catch (_) {}
  }

  // Map times through actual candle indexes, not fixed elapsed seconds. This
  // keeps overlays aligned across missing bars and variable-length months.
  function logicalForTime(t) {
    if (!candles.length || !Number.isFinite(t)) return null;
    let lo = 0, hi = candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time === t) return mid;
      if (candles[mid].time < t) lo = mid + 1; else hi = mid - 1;
    }
    const nominal = INTERVAL_SEC[settings.interval];
    if (lo === 0) return (t - candles[0].time) / nominal;
    if (lo >= candles.length) return candles.length - 1 + (t - candles[candles.length - 1].time) / nominal;
    const before = candles[lo - 1].time, after = candles[lo].time;
    return lo - 1 + (t - before) / (after - before);
  }
  function timeForLogical(l) {
    if (!candles.length || !Number.isFinite(l)) return null;
    const nominal = INTERVAL_SEC[settings.interval];
    if (l <= 0) return Math.round(candles[0].time + l * nominal);
    if (l >= candles.length - 1) {
      return Math.round(candles[candles.length - 1].time + (l - candles.length + 1) * nominal);
    }
    const left = Math.floor(l), fraction = l - left;
    return Math.round(candles[left].time + fraction * (candles[left + 1].time - candles[left].time));
  }
  function xForTime(t) {
    const l = logicalForTime(t);
    if (l === null) return null;
    return chart.timeScale().logicalToCoordinate(l);
  }
  function visibleIndexBounds(padding = 1) {
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range || !candles.length) return [0, candles.length - 1];
    return [
      Math.max(0, Math.floor(range.from) - padding),
      Math.min(candles.length - 1, Math.ceil(range.to) + padding),
    ];
  }
  function timeForX(x) {
    const l = chart.timeScale().coordinateToLogical(x);
    if (l === null || !candles.length) return null;
    return timeForLogical(l);
  }
  function priceForY(y) { return candleSeries.coordinateToPrice(y); }
  function yForPrice(p) { return candleSeries.priceToCoordinate(p); }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // ============================== RSI pane ==============================
  // The RSI gets its own field below the main chart. It is drawn on our own
  // canvas using the MAIN chart's time scale (xForTime), so its x positions
  // always line up exactly with the candles regardless of axis widths.
  const rsiCanvas = document.createElement("canvas");
  rsiCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;";
  elRsi.style.position = "relative";
  elRsi.appendChild(rsiCanvas);
  const rctx = rsiCanvas.getContext("2d");

  function sizeCanvas(canvas, ctx, width, height) {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function scheduleDraw() {
    if (drawFrame) return;
    const draw = () => {
      drawFrame = 0;
      if (needOverlayDraw) { needOverlayDraw = false; drawOverlay(); }
      if (needRSIDraw) { needRSIDraw = false; drawRSIPane(); }
    };
    // Coalesce rapid crosshair/pan events to one paint per display frame. A
    // timeout is retained for hidden tabs because their animation frames can
    // be suspended; pageshow/visibility handlers then resynchronise normally.
    drawFrameIsTimeout = document.visibilityState !== "visible";
    drawFrame = drawFrameIsTimeout ? setTimeout(draw, 0) : requestAnimationFrame(draw);
  }
  function invalidateOverlay() { needOverlayDraw = true; scheduleDraw(); }
  function invalidateRSI() {
    if (!settings.indicators.rsi) return;
    needRSIDraw = true;
    scheduleDraw();
  }

  function drawRSIPane() {
    const w = elRsi.clientWidth, h = elRsi.clientHeight;
    sizeCanvas(rsiCanvas, rctx, w, h);
    rctx.clearRect(0, 0, w, h);
    if (!settings.indicators.rsi) return;
    const pad = 12;
    const top = pad, bot = h - pad;
    const yOf = (v) => bot - (v / 100) * (bot - top);
    rctx.strokeStyle = "#262c35";
    rctx.lineWidth = 1;
    rctx.setLineDash([4, 4]);
    for (const lvl of [30, 50, 70]) {
      const y = yOf(lvl);
      rctx.beginPath(); rctx.moveTo(0, y); rctx.lineTo(w, y); rctx.stroke();
    }
    rctx.setLineDash([]);
    rctx.strokeStyle = "#a78bfa";
    rctx.lineWidth = 1.5;
    rctx.beginPath();
    let started = false;
    const [firstVisible, lastVisible] = visibleIndexBounds();
    for (let i = firstVisible; i <= lastVisible; i++) {
      const v = rsiValues[i];
      if (v === null || v === undefined) continue;
      // RSI points correspond exactly to candle indexes, so bypass the
      // binary time lookup used by arbitrary drawing anchors.
      const x = chart.timeScale().logicalToCoordinate(i);
      if (x === null) { started = false; continue; }
      const y = yOf(v);
      if (!started) { rctx.moveTo(x, y); started = true; }
      else rctx.lineTo(x, y);
    }
    if (started) {
      rctx.stroke();
      let showVal = null, showY = null;
      if (hover && hover.time !== null) {
        const hv = rsiAtTime(hover.time);
        if (hv !== null && hv !== undefined) {
          rctx.strokeStyle = "#5d6876";
          rctx.lineWidth = 1;
          rctx.setLineDash([3, 3]);
          rctx.beginPath(); rctx.moveTo(hover.x, 0); rctx.lineTo(hover.x, h); rctx.stroke();
          rctx.setLineDash([]);
          rctx.fillStyle = "#a78bfa";
          rctx.beginPath(); rctx.arc(hover.x, yOf(hv), 3, 0, Math.PI * 2); rctx.fill();
          showVal = hv.toFixed(2); showY = yOf(hv);
        }
      } else {
        const latest = rsiValues[rsiValues.length - 1];
        if (latest !== null && latest !== undefined) {
          showVal = latest.toFixed(2); showY = yOf(latest);
        }
      }
      if (showVal !== null) pill(rctx, w, showY, showVal, "#a78bfa");
    }
    rctx.font = "10px sans-serif";
    rctx.fillStyle = "#848e9c";
    rctx.fillText("RSI", 8, 12);
  }

  function pill(ctx, w, y, text, color) {
    ctx.font = "10px sans-serif";
    const tw = ctx.measureText(text).width;
    const px = w - tw - 12;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.roundRect(px, y - 8, tw + 10, 16, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b0e11";
    ctx.fillText(text, px + 5, y + 3);
  }

  // ============================== RSI OB/OS trigger curves ==============================
  // TradingView "RSI Levels" style: two faint jagged lines FOLLOWING the chart.
  // For every bar, the curve shows the price at which RSI would hit the OB /
  // OS threshold — computed from the exact Wilder smoothing state at that bar.
  // The right end of each curve is the live trigger price for the next tick.
  function rsiTriggerPoint(index, target, ratio = target / (100 - target)) {
    const st = rsiStates[index - 1];
    if (!st || !candles[index - 1] || !candles[index]) return null;
    const prevClose = candles[index - 1].close;
    const g = (RSI_PERIOD - 1) * (ratio * st.avgL - st.avgG);
    let price;
    if (g >= 0) {
      price = prevClose + g;
    } else {
      const loss = ((RSI_PERIOD - 1) * st.avgG) / ratio - (RSI_PERIOD - 1) * st.avgL;
      if (loss < 0) return null;
      price = prevClose - loss;
    }
    return price > 0 ? { index, time: candles[index].time, price } : null;
  }

  function rsiTriggerCurve(target) {
    const pts = [];
    const ratio = target / (100 - target);
    for (let i = 1; i < candles.length; i++) {
      const point = rsiTriggerPoint(i, target, ratio);
      if (point) pts.push(point);
    }
    return pts;
  }

  function drawTriggerCurve(pts, col, tag) {
    if (!pts.length) return;
    octx.strokeStyle = col;
    octx.lineWidth = 1;
    octx.beginPath();
    let started = false;
    const [firstVisible, lastVisible] = visibleIndexBounds();
    for (const pt of pts) {
      if (pt.index < firstVisible) continue;
      if (pt.index > lastVisible) break;
      const x = chart.timeScale().logicalToCoordinate(pt.index);
      const y = yForPrice(pt.price);
      if (x === null || y === null) { started = false; continue; }
      if (!started) { octx.moveTo(x, y); started = true; }
      else octx.lineTo(x, y);
    }
    if (started) octx.stroke();
    const latest = pts[pts.length - 1];
    const latestY = yForPrice(latest.price);
    if (latestY !== null) label(octx, elMain.clientWidth, latestY, `${tag} ${fmtPrice(latest.price)}`, col);
  }

  function drawRSILevels() {
    if (!settings.indicators.rsiLvls || !candles.length) return;
    drawTriggerCurve(obTriggerPoints, "rgba(226,88,68,0.45)", "OB");
    drawTriggerCurve(osTriggerPoints, "rgba(212,164,74,0.45)", "OS");
  }

  function refreshTriggerCurves() {
    if (!settings.indicators.rsiLvls || !candles.length) {
      obTriggerPoints = []; osTriggerPoints = [];
      return;
    }
    obTriggerPoints = rsiTriggerCurve(settings.indicators.rsiOB);
    osTriggerPoints = rsiTriggerCurve(settings.indicators.rsiOS);
  }

  function updateTailTriggerCurves(index) {
    if (!settings.indicators.rsiLvls) return;
    const replaceTail = (points, target) => {
      while (points.length && points[points.length - 1].index >= index) points.pop();
      const point = rsiTriggerPoint(index, target);
      if (point) points.push(point);
    };
    replaceTail(obTriggerPoints, settings.indicators.rsiOB);
    replaceTail(osTriggerPoints, settings.indicators.rsiOS);
  }

  // ============================== measure tool ==============================
  function humanDuration(secs) {
    if (secs < 3600) return Math.round(secs / 60) + "m";
    if (secs < 86400) {
      const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
      return h + "h" + (m ? " " + m + "m" : "");
    }
    const d = Math.floor(secs / 86400);
    const h = Math.round((secs % 86400) / 3600);
    return d + "d" + (h ? " " + h + "h" : "");
  }

  function drawMeasure(w, h) {
    if (!measure) return;
    const x1 = xForTime(measure.a.time), x2 = xForTime(measure.b.time);
    const y1 = yForPrice(measure.a.price), y2 = yForPrice(measure.b.price);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;
    const up = measure.b.price >= measure.a.price;
    const col = up ? "#0ecb81" : "#f6465d";
    const left = Math.min(x1, x2), right = Math.max(x1, x2);
    const top = Math.min(y1, y2), bot = Math.max(y1, y2);

    // shaded range box + dashed border
    octx.fillStyle = up ? "rgba(14,203,129,0.07)" : "rgba(246,70,93,0.07)";
    octx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bot - top));
    octx.strokeStyle = col;
    octx.lineWidth = 1;
    octx.setLineDash([3, 3]);
    octx.strokeRect(left, top, Math.max(1, right - left), Math.max(1, bot - top));
    octx.setLineDash([]);

    // stats
    const dPrice = measure.b.price - measure.a.price;
    const pct = (dPrice / measure.a.price) * 100;
    const l1 = logicalForTime(measure.a.time), l2 = logicalForTime(measure.b.time);
    const bars = Math.abs(Math.round(l2 - l1));
    const secs = Math.abs(measure.b.time - measure.a.time);
    const dur = settings.interval === "1M" ? bars + " months" : humanDuration(secs);
    const sign = dPrice > 0 ? "+" : dPrice < 0 ? "−" : "";
    const lines = [
      sign + fmtPrice(Math.abs(dPrice)) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)",
      bars + " bars · " + dur,
    ];

    octx.font = "11px sans-serif";
    const tw = Math.max(...lines.map((s) => octx.measureText(s).width));
    const bw = tw + 16, bh = lines.length * 15 + 10;
    const bx = Math.min(w - bw - 6, Math.max(6, right + 8));
    const by = Math.max(6, Math.min(h - bh - 6, top - bh - 8));
    octx.fillStyle = "#1e2329";
    octx.globalAlpha = 0.95;
    octx.beginPath();
    octx.roundRect(bx, by, bw, bh, 4);
    octx.fill();
    octx.globalAlpha = 1;
    octx.strokeStyle = col;
    octx.strokeRect(bx, by, bw, bh);
    octx.fillStyle = col;
    lines.forEach((s, i) => octx.fillText(s, bx + 8, by + 17 + i * 15));
  }

  function drawOverlay() {
    const w = elMain.clientWidth, h = elMain.clientHeight;
    sizeCanvas(overlay, octx, w, h);
    octx.clearRect(0, 0, w, h);
    drawRSILevels();
    drawMeasure(w, h);
    const list = drawingsFor();

    for (const d of list) {
      octx.strokeStyle = d.color;
      octx.lineWidth = 1.5;
      octx.setLineDash([]);
      if (d.type === "hline") {
        const y = yForPrice(d.points[0].price);
        if (y === null) continue;
        octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke();
        label(octx, w, y, fmtPrice(d.points[0].price), d.color);
      } else {
        const [p1, p2] = d.points;
        const x1 = xForTime(p1.time), y1 = yForPrice(p1.price);
        const x2 = xForTime(p2.time), y2 = yForPrice(p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
        octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke();
        dot(octx, x1, y1, d.color); dot(octx, x2, y2, d.color);
      }
    }

    // preview while drawing
    if (tool && tool !== "hline" && anchor && cursorXY) {
      const ax = xForTime(anchor.time), ay = yForPrice(anchor.price);
      if (ax !== null && ay !== null) {
        octx.strokeStyle = "#ffffffaa";
        octx.lineWidth = 1.5;
        octx.setLineDash([5, 4]);
        octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(cursorXY.x, cursorXY.y); octx.stroke();
        octx.setLineDash([]);
        dot(octx, ax, ay, "#ffffff");
      }
    }
    if (tool === "hline" && cursorXY && anchor === null) {
      const p = priceForY(cursorXY.y);
      if (p !== null) {
        octx.strokeStyle = "#ffffffaa";
        octx.lineWidth = 1.5;
        octx.setLineDash([5, 4]);
        octx.beginPath(); octx.moveTo(0, cursorXY.y); octx.lineTo(w, cursorXY.y); octx.stroke();
        octx.setLineDash([]);
      }
    }
  }

  function label(ctx, w, y, text, color) {
    ctx.font = "10px sans-serif";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(w - tw - 10, y - 8, tw + 8, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b0e11";
    ctx.fillText(text, w - tw - 6, y + 3);
  }
  function dot(ctx, x, y, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#0b0e11"; ctx.lineWidth = 1; ctx.stroke();
  }
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }



  // ============================== indicators ==============================
  function computeEMA(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let prev = sum / period;
    out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function computeRSI(closes, period) {
    const out = new Array(closes.length).fill(null);
    const states = new Array(closes.length).fill(null);
    if (closes.length <= period) return { values: out, states, avgG: 0, avgL: 0 };
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gain += ch; else loss -= ch;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    states[period] = { avgG, avgL };
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
      states[i] = { avgG, avgL };
    }
    return { values: out, states, avgG, avgL };
  }

  function recomputeIndicators() {
    const closes = candles.map((c) => c.close);
    emaValues = computeEMA(closes, EMA_PERIOD);
    emaSeries.setData(
      candles.map((c, i) => ({ time: c.time, value: emaValues[i] })).filter((p) => p.value !== null)
    );
    const st = computeRSI(closes, RSI_PERIOD);
    rsiValues = st.values;
    rsiStates = st.states;
    refreshTriggerCurves();
    invalidateOverlay();
    invalidateRSI();
  }

  // ============================== formatting ==============================
  async function fetchJson(url, opts = {}) {
    const controller = new AbortController();
    const upstream = opts.signal;
    const abort = () => controller.abort();
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else upstream.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener("abort", abort);
    }
  }

  function priceDecimals(p) {
    if (p >= 100) return 2;
    if (p >= 10) return 3;
    if (p >= 1) return 4;
    return 6;
  }
  const fmtPrice = (p) => Number.isFinite(p) ? p.toFixed(currentPrecision) : "—";
  const fmtVol = (v) =>
    !Number.isFinite(v) ? "—" :
    v >= 1e9 ? (v / 1e9).toFixed(2) + "B" :
    v >= 1e6 ? (v / 1e6).toFixed(2) + "M" :
    v >= 1e3 ? (v / 1e3).toFixed(2) + "K" : v.toFixed(2);

  function normaliseCandle(raw) {
    const c = {
      time: Math.floor(Number(raw.time)),
      open: Number(raw.open), high: Number(raw.high), low: Number(raw.low),
      close: Number(raw.close), volume: Number(raw.volume),
    };
    if (!Number.isFinite(c.time) || c.time <= 0 ||
        !Number.isFinite(c.open) || !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) || !Number.isFinite(c.close) ||
        c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0 ||
        !Number.isFinite(c.volume) || c.volume < 0 || c.high < c.low ||
        c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) return null;
    return c;
  }

  function normaliseCandles(rows) {
    if (!Array.isArray(rows)) return [];
    const byTime = new Map();
    for (const row of rows) {
      const c = normaliseCandle(row);
      if (c) byTime.set(c.time, c);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function clearChartData() {
    candles = []; emaValues = []; rsiValues = []; rsiStates = [];
    obTriggerPoints = []; osTriggerPoints = [];
    candleSeries.setData([]); volumeSeries.setData([]); emaSeries.setData([]);
    elLastPrice.textContent = "—";
    delete elLastPrice.dataset.v;
    invalidateOverlay(); invalidateRSI();
  }

  // ============================== data ==============================
  function scheduleHistoryRetry(message) {
    // The watchdog owns retries even when there are no candles/socket yet.
    // Cap the exponent too, so a long outage cannot overflow it.
    const delay = Math.min(30000, 1000 * 2 ** historyRetryAttempt);
    historyRetryAttempt = Math.min(5, historyRetryAttempt + 1);
    historyRetryAt = Date.now() + delay;
    setLegendText(`${message}. Retrying automatically…`);
  }

  async function loadHistory(isRetry = false) {
    historyRetryAt = 0;
    // Explicit reloads (including market/timeframe changes) start fresh;
    // automatic retries keep their backoff until a successful response.
    if (!isRetry) historyRetryAttempt = 0;
    alertUI?.marketChanged();
    const token = ++loadToken;
    if (historyController) historyController.abort();
    historyController = new AbortController();
    loading = true;
    stopSocket();
    disarm();
    measure = null; hover = null;
    const sourceKey = settings.source;
    const symbol = settings.symbol;
    const interval = settings.interval;
    const src = SOURCES[sourceKey];
    clearChartData();
    setLegendText(`Loading ${src.display(symbol)} ${interval}…`);

    let rows;
    try {
      rows = await src.fetchKlines(symbol, interval, REST_LIMIT, historyController.signal);
    } catch (err) {
      if (token !== loadToken) return;
      loading = false;
      historyController = null;
      const message = err && err.name === "AbortError" ? "request timed out" : (err && err.message) || "unknown error";
      scheduleHistoryRetry(`Load failed: ${message}`);
      return;
    }
    if (token !== loadToken) return;
    loading = false;
    historyController = null;
    candles = normaliseCandles(rows);
    if (!candles.length) {
      scheduleHistoryRetry("No candle data for this market/timeframe");
      return;
    }
    historyRetryAttempt = 0;

    currentPrecision = priceDecimals(candles[candles.length - 1].close);
    candleSeries.applyOptions({
      priceFormat: { type: "price", precision: currentPrecision, minMove: Math.pow(10, -currentPrecision) },
    });
    candleSeries.setData(candles);
    volumeSeries.setData(candles.map(volumePoint));
    recomputeIndicators();
    chart.timeScale().scrollToRealTime();
    updateLegend();
    const last = candles[candles.length - 1];
    setLastPrice(last.close, last.close >= last.open);
    lastTickTs = Date.now();
    lastLoadTs = Date.now();
    startSocket({ loadToken: token, sourceKey, symbol, interval, src });
  }

  function volumePoint(c) {
    return {
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)",
    };
  }

  function applyLive(raw, token = loadToken) {
    if (token !== loadToken) return;
    const k = normaliseCandle(raw);
    if (!k) return;
    lastTickTs = Date.now();
    const last = candles[candles.length - 1];
    let resetSeries = false, newBar = false;
    if (last && k.time === last.time) {
      candles[candles.length - 1] = k;
    } else if (!last || k.time > last.time) {
      const iv = INTERVAL_SEC[settings.interval];
      if (last && k.time - last.time > 2 * iv) { loadHistory(); return; }
      candles.push(k);
      newBar = true;
      if (candles.length > 1500) {
        candles = candles.slice(-1000);
        resetSeries = true;
      }
    } else {
      return;
    }

    if (resetSeries) {
      candleSeries.setData(candles);
      volumeSeries.setData(candles.map(volumePoint));
      recomputeIndicators();
    } else {
      candleSeries.update(k);
      volumeSeries.update(volumePoint(k));
      updateTailIndicators(newBar);
    }
    updateLegend();
    setLastPrice(k.close);
    invalidateOverlay();
    invalidateRSI();
  }

  function updateTailIndicators(newBar) {
    const index = candles.length - 1;
    if (index < 0) return;

    // A live update can only change the newest indicator point. Rebuilding
    // all 500–1,000 EMA/RSI/trigger points on every WebSocket tick wastes CPU
    // and battery, especially on mobile.
    emaValues.length = candles.length;
    let ema = null;
    if (index === EMA_PERIOD - 1) {
      let sum = 0;
      for (let i = 0; i < EMA_PERIOD; i++) sum += candles[i].close;
      ema = sum / EMA_PERIOD;
    } else if (index >= EMA_PERIOD) {
      const previous = emaValues[index - 1];
      if (!Number.isFinite(previous)) { recomputeIndicators(); return; }
      const factor = 2 / (EMA_PERIOD + 1);
      ema = candles[index].close * factor + previous * (1 - factor);
    }
    emaValues[index] = ema;
    if (ema !== null) emaSeries.update({ time: candles[index].time, value: ema });

    rsiValues.length = candles.length;
    rsiStates.length = candles.length;
    if (index < RSI_PERIOD) {
      rsiValues[index] = null;
      rsiStates[index] = null;
    } else if (index === RSI_PERIOD) {
      let gain = 0, loss = 0;
      for (let i = 1; i <= RSI_PERIOD; i++) {
        const change = candles[i].close - candles[i - 1].close;
        if (change > 0) gain += change; else loss -= change;
      }
      const avgG = gain / RSI_PERIOD, avgL = loss / RSI_PERIOD;
      rsiStates[index] = { avgG, avgL };
      rsiValues[index] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    } else {
      const previous = rsiStates[index - 1];
      if (!previous) { recomputeIndicators(); return; }
      const change = candles[index].close - candles[index - 1].close;
      const gain = change > 0 ? change : 0, loss = change < 0 ? -change : 0;
      const avgG = (previous.avgG * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      const avgL = (previous.avgL * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
      rsiStates[index] = { avgG, avgL };
      rsiValues[index] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    // The trigger at the current candle depends on the previous candle's
    // closed state, so it only changes when a new candle is appended.
    if (newBar) updateTailTriggerCurves(index);
  }

  // ---- liveness: reconnect dead sockets + REST polling fallback ----
  function startSocket(context) {
    stopSocket();
    const token = ++socketToken;
    retryAttempt = 0;
    const valid = () => token === socketToken && context.loadToken === loadToken;

    function tryConnect() {
      if (!valid()) return;
      let ws;
      try {
        ws = context.src.openSocket(context.symbol, context.interval, (k) => {
          if (!valid() || liveSocket !== ws) return;
          setLive(true);
          applyLive(k, context.loadToken);
        });
        liveSocket = ws;
      } catch (_) {
        liveSocket = null;
        scheduleRetry();
        return;
      }
      ws.addEventListener("open", () => {
        if (!valid() || liveSocket !== ws) return;
        setLive(true);
        retryAttempt = 0;
      });
      ws.addEventListener("error", () => {
        if (valid() && liveSocket === ws) setLive(false);
      });
      ws.addEventListener("close", () => {
        if (ws._ping) clearInterval(ws._ping);
        if (!valid() || liveSocket !== ws) return;
        liveSocket = null;
        setLive(false);
        scheduleRetry();
      });
    }
    function scheduleRetry() {
      if (!valid() || retryTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, retryAttempt++));
      retryTimer = setTimeout(() => { retryTimer = null; tryConnect(); }, delay);
    }
    tryConnect();
  }

  function stopSocket() {
    socketToken++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (liveSocket) {
      const ws = liveSocket;
      liveSocket = null;
      if (ws._ping) clearInterval(ws._ping);
      try { ws.close(); } catch (_) {}
    }
    setLive(false);
  }
  function setLive(ok) {
    const dot = $("live-dot");
    if (dot) dot.classList.toggle("off", !ok);
  }

  // Poll via REST only when the socket is quiet. Captured tokens prevent a
  // response for an old symbol/source from ever touching the current chart.
  async function pollFallback() {
    if (loading) return;
    if (historyRetryAt) {
      if (Date.now() >= historyRetryAt) await loadHistory(true);
      return;
    }
    if (polling || !candles.length) return;
    const stale = Date.now() - lastTickTs;
    if (stale > 120000) { loadHistory(); return; }
    const token = loadToken;
    const sourceKey = settings.source, symbol = settings.symbol, interval = settings.interval;
    const src = SOURCES[sourceKey];
    if (stale <= src.pollStaleMs) return;
    polling = true;
    try {
      const rows = await src.fetchKlines(symbol, interval, 3);
      if (token !== loadToken || sourceKey !== settings.source || symbol !== settings.symbol || interval !== settings.interval) return;
      for (const k of normaliseCandles(rows)) applyLive(k, token);
    } catch (_) { /* offline; retry next watchdog tick */ }
    finally { polling = false; }
  }
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(pollFallback, 3000);
  }
  function stopWatchdog() {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") { stopWatchdog(); return; }
    startWatchdog();
    invalidateOverlay();
    invalidateRSI();
    if (!loading && (historyRetryAt || Date.now() - lastLoadTs > 20000)) loadHistory();
  });
  window.addEventListener("online", () => {
    if (!loading && (historyRetryAt || Date.now() - lastLoadTs > 5000)) loadHistory();
  });
  window.addEventListener("pagehide", () => {
    loadToken++;
    stopWatchdog();
    if (historyController) historyController.abort();
    stopSocket();
    if (drawFrame) {
      if (drawFrameIsTimeout) clearTimeout(drawFrame);
      else cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }
  });
  window.addEventListener("pageshow", (e) => {
    startWatchdog();
    if (e.persisted) loadHistory();
  });

  function setLastPrice(p, initialDirection) {
    const prev = Number(elLastPrice.dataset.v);
    if (p === prev && typeof initialDirection !== "boolean") return;
    elLastPrice.dataset.v = p;
    elLastPrice.textContent = fmtPrice(p);
    const up = typeof initialDirection === "boolean" ? initialDirection : (!Number.isFinite(prev) || p >= prev);
    elLastPrice.style.color = up ? "var(--up)" : "var(--down)";
  }

  // ============================== legend ==============================
  function indexAtTime(t) {
    let lo = 0, hi = candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time === t) return mid;
      if (candles[mid].time < t) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
  function rsiAtTime(t) {
    const i = indexAtTime(t);
    return i >= 0 ? rsiValues[i] : null;
  }
  function emaAtTime(t) {
    const i = indexAtTime(t);
    return i >= 0 ? emaValues[i] : null;
  }
  function candleAtTime(t) {
    const i = indexAtTime(t);
    return i >= 0 ? candles[i] : null;
  }

  function updateLegend(bar) {
    const c = bar || candles[candles.length - 1];
    if (!c) return;
    const chg = ((c.close - c.open) / c.open) * 100;
    const cls = c.close >= c.open ? "pos" : "neg";
    let ind = "";
    if (settings.indicators.ema) {
      const emaV = bar ? emaAtTime(bar.time) : emaValues[emaValues.length - 1];
      if (emaV != null) ind += `<span class="ind">EMA8 <b style="color:#f0b90b">${fmtPrice(emaV)}</b></span> · `;
    }
    if (settings.indicators.rsi) {
      const rsi = bar ? rsiAtTime(bar.time) : (rsiValues.length ? rsiValues[rsiValues.length - 1] : null);
      if (rsi != null) ind += `<span class="ind">RSI <b style="color:#a78bfa">${rsi.toFixed(1)}</b></span> · `;
    }
    // volume always comes from our own candle array — crosshair payloads lack it
    const vc = bar ? candleAtTime(bar.time) : c;
    ind += `<span class="ind">Vol <b>${fmtVol(vc ? vc.volume : null)}</b></span>`;
    const html =
      `<span class="ohlc">${SOURCES[settings.source].display(settings.symbol)} · ${settings.interval} · <span class="src">${SOURCES[settings.source].label} ·</span> &nbsp; ` +
      `O <span class="${cls}">${fmtPrice(c.open)}</span> ` +
      `H <span class="${cls}">${fmtPrice(c.high)}</span> ` +
      `L <span class="${cls}">${fmtPrice(c.low)}</span> ` +
      `C <span class="${cls}">${fmtPrice(c.close)}</span> ` +
      `<span class="${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></span><br>` +
      `<span class="ind">${ind}</span>`;
    // Crosshair events fire for every pixel, often several times over the
    // same candle. Avoid reparsing/replacing identical legend DOM.
    if (html !== lastLegendHtml) {
      lastLegendHtml = html;
      elLegend.innerHTML = html;
    }
  }

  chart.subscribeCrosshairMove((param) => {
    alertUI?.track(param);
    hover = param.time && param.point ? { x: param.point.x, time: param.time } : null;
    invalidateRSI();
    if (!param.time || !param.seriesData.has(candleSeries)) { updateLegend(); return; }
    const c = param.seriesData.get(candleSeries);
    updateLegend({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  });

  // ============================== tools / drawings ==============================
  function armTool(t) {
    alertUI?.clearSelection();
    tool = t === tool ? null : t;
    anchor = null;
    document.body.classList.toggle("hline-mode", !!tool);
    for (const b of document.querySelectorAll(".tools button[data-tool]")) {
      const active = b.dataset.tool === tool;
      b.classList.toggle("armed", active);
      b.setAttribute("aria-pressed", String(active));
    }
    // dedicate touch to the tool: no chart pan/zoom while a drawing tool is armed
    chart.applyOptions({ handleScroll: !tool, handleScale: !tool, kineticScroll: { touch: !tool } });
  }
  function disarm() {
    tool = null; anchor = null;
    document.body.classList.remove("hline-mode");
    for (const b of document.querySelectorAll(".tools button[data-tool]")) {
      b.classList.remove("armed"); b.setAttribute("aria-pressed", "false");
    }
    chart.applyOptions({ handleScroll: true, handleScale: true, kineticScroll: { touch: true } });
  }

  elMain.addEventListener("pointermove", (e) => {
    if (e.isPrimary === false || !tool) return;
    const r = elMain.getBoundingClientRect();
    cursorXY = { x: e.clientX - r.left, y: e.clientY - r.top };
    // live preview while measuring (first click done, second pending)
    if (tool === "measure" && measure) {
      const t = timeForX(cursorXY.x), p = priceForY(cursorXY.y);
      if (t !== null && p !== null) { measure.b = { time: t, price: p }; }
    }
    invalidateOverlay();
  });

  // Placement happens on POINTERDOWN, not click: on touch, fingers always
  // drift a few px before lifting, which the chart consumes as a pan and no
  // click event ever fires — pointerdown lands exactly where the finger did.
  // While a tool is armed, chart pan/zoom is disabled (see armTool) so the
  // whole gesture belongs to the tool, TradingView-style.
  elMain.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    // a tap clears a completed measurement (TV behaviour)
    if (measure && tool !== "measure") { measure = null; invalidateOverlay(); }
    if (e.altKey && !tool) { deleteNearest(e); return; }
    if (!tool) return;
    e.preventDefault();
    const r = elMain.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = timeForX(x), p = priceForY(y);
    if (t === null || p === null) return;

    if (tool === "measure") {
      if (!measure) {
        measure = { a: { time: t, price: p }, b: { time: t, price: p } };
      } else {
        measure.b = { time: t, price: p };
        disarm(); // box stays visible until the next tap / Esc
      }
      invalidateOverlay();
      return;
    }

    if (tool === "hline") {
      drawingsFor().push({
        id: Date.now() + Math.random(),
        type: "hline",
        points: [{ time: t, price: p }],
        color: DRAW_COLORS[drawingsFor().length % DRAW_COLORS.length],
      });
      saveDrawings();
      disarm();
      invalidateOverlay();
      return;
    }
    if (!anchor) {
      anchor = { time: t, price: p };
    } else {
      if (anchor.time === t && anchor.price === p) { anchor = null; return; }
      drawingsFor().push({
        id: Date.now() + Math.random(),
        type: tool,
        points: [anchor, { time: t, price: p }],
        color: DRAW_COLORS[drawingsFor().length % DRAW_COLORS.length],
      });
      saveDrawings();
      anchor = null;
      disarm();
    }
    invalidateOverlay();
  });

  function deleteNearest(e) {
    const r = elMain.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const list = drawingsFor();
    let best = -1, bestD = 9;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      let dist = Infinity;
      if (d.type === "hline") {
        const py = yForPrice(d.points[0].price);
        if (py !== null) dist = Math.abs(py - y);
      } else {
        const x1 = xForTime(d.points[0].time), y1 = yForPrice(d.points[0].price);
        const x2 = xForTime(d.points[1].time), y2 = yForPrice(d.points[1].price);
        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          dist = distToSegment(x, y, x1, y1, x2, y2);
        }
      }
      if (dist < bestD) { bestD = dist; best = i; }
    }
    if (best >= 0) {
      list.splice(best, 1);
      saveDrawings();
      invalidateOverlay();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { disarm(); measure = null; invalidateOverlay(); }
  });

  $("btn-hline").addEventListener("click", () => armTool("hline"));
  $("btn-trend").addEventListener("click", () => armTool("trend"));
  $("btn-hline").dataset.tool = "hline";
  $("btn-trend").dataset.tool = "trend";
  $("btn-measure").addEventListener("click", () => { measure = null; armTool("measure"); });
  $("btn-measure").dataset.tool = "measure";
  $("btn-clear").addEventListener("click", () => {
    drawings[key()] = [];
    saveDrawings();
    invalidateOverlay();
  });

  // ============================== controls ==============================
  INTERVALS.forEach(([iv]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = iv;
    b.dataset.iv = iv;
    b.addEventListener("click", () => {
      settings.interval = iv;
      saveSettings();
      renderIntervals();
      loadHistory();
    });
    elIntervals.appendChild(b);
  });

  function renderIntervals() {
    for (const b of elIntervals.children) {
      const active = b.dataset.iv === settings.interval;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
  }

  function favouriteIndex(source = settings.source, symbol = settings.symbol) {
    return settings.favourites.findIndex((f) => f.source === source && f.symbol === symbol);
  }
  function renderFavouriteToggle() {
    const active = favouriteIndex() >= 0;
    elFavouriteToggle.textContent = active ? "★" : "☆";
    elFavouriteToggle.classList.toggle("active", active);
    elFavouriteToggle.setAttribute("aria-pressed", String(active));
    elFavouriteToggle.title = active ? "Remove current ticker from favourites" : "Add current ticker to favourites";
    elFavouriteToggle.setAttribute("aria-label", elFavouriteToggle.title);
  }
  function renderFavourites() {
    elFavourites.parentElement.hidden = settings.favourites.length === 0;
    elFavourites.replaceChildren();
    settings.favourites.forEach((f) => {
      const src = SOURCES[f.source];
      const chip = document.createElement("button");
      const active = f.source === settings.source && f.symbol === settings.symbol;
      chip.type = "button";
      chip.className = "favourite-chip" + (active ? " active" : "");
      chip.dataset.source = f.source;
      chip.dataset.symbol = f.symbol;
      chip.textContent = src.display(f.symbol);
      chip.title = `Show ${src.display(f.symbol)} on ${src.label}. Long-press and drag to reorder.`;
      chip.setAttribute("aria-label", chip.title);
      chip.setAttribute("aria-pressed", String(active));
      chip.addEventListener("click", () => {
        if (suppressFavouriteClick) return;
        selectTicker(f.source, f.symbol);
      });
      elFavourites.appendChild(chip);
    });
    renderFavouriteToggle();
  }
  function saveFavouriteOrderFromDom() {
    settings.favourites = [...elFavourites.children].map((chip) => ({
      source: chip.dataset.source,
      symbol: chip.dataset.symbol,
    }));
    saveSettings();
  }
  function stopFavouriteMomentum() {
    if (favouriteMomentumFrame) cancelAnimationFrame(favouriteMomentumFrame);
    favouriteMomentumFrame = 0;
  }
  function startFavouriteMomentum(initialVelocity) {
    stopFavouriteMomentum();
    let velocity = initialVelocity;
    let lastTime = performance.now();
    const step = (now) => {
      const elapsed = Math.min(32, now - lastTime);
      lastTime = now;
      const before = elFavourites.scrollLeft;
      const max = Math.max(0, elFavourites.scrollWidth - elFavourites.clientWidth);
      elFavourites.scrollLeft = Math.max(0, Math.min(max, before + velocity * elapsed));
      if (elFavourites.scrollLeft === before || Math.abs(velocity) < 0.015) {
        favouriteMomentumFrame = 0;
        return;
      }
      // Exponential decay keeps the post-swipe glide responsive rather than
      // mechanical, while naturally stopping at either end of the strip.
      velocity *= Math.pow(0.94, elapsed / 16.67);
      favouriteMomentumFrame = requestAnimationFrame(step);
    };
    if (Math.abs(velocity) >= 0.015) favouriteMomentumFrame = requestAnimationFrame(step);
  }
  function clearFavouriteGesture() {
    const gesture = favouriteGesture;
    if (!gesture) return;
    clearTimeout(gesture.pressTimer);
    gesture.chip.classList.remove("dragging");
    elFavourites.classList.remove("reordering");
    try { gesture.chip.releasePointerCapture(gesture.pointerId); } catch (_) {}
    favouriteGesture = null;
  }
  function startFavouriteDrag() {
    const gesture = favouriteGesture;
    if (!gesture || gesture.dragging || gesture.scrolling) return;
    gesture.dragging = true;
    gesture.chip.classList.add("dragging");
    elFavourites.classList.add("reordering");
    if (navigator.vibrate) navigator.vibrate(12);
  }
  function moveFavouriteChip(clientX) {
    const gesture = favouriteGesture;
    if (!gesture || !gesture.dragging) return;
    const chips = [...elFavourites.querySelectorAll(".favourite-chip")];
    const others = chips.filter((chip) => chip !== gesture.chip);
    if (!others.length) return;
    const strip = elFavourites.getBoundingClientRect();
    if (clientX < strip.left + 28) elFavourites.scrollLeft -= 10;
    else if (clientX > strip.right - 28) elFavourites.scrollLeft += 10;
    let target = others[0];
    let distance = Infinity;
    for (const chip of others) {
      const rect = chip.getBoundingClientRect();
      const d = Math.abs(clientX - (rect.left + rect.width / 2));
      if (d < distance) { target = chip; distance = d; }
    }
    const targetRect = target.getBoundingClientRect();
    if (clientX < targetRect.left + targetRect.width / 2) target.before(gesture.chip);
    else target.after(gesture.chip);
  }
  function toggleFavourite() {
    const index = favouriteIndex();
    if (index >= 0) settings.favourites.splice(index, 1);
    else settings.favourites.push({ source: settings.source, symbol: settings.symbol });
    saveSettings();
    renderFavourites();
  }
  function selectTicker(sourceKey, symbol) {
    const src = SOURCES[sourceKey];
    if (!src || !src.symbols.includes(symbol)) return;
    if (sourceKey === settings.source && symbol === settings.symbol) return;
    settings.symbolBySource[settings.source] = settings.symbol;
    settings.source = sourceKey;
    settings.symbol = symbol;
    settings.symbolBySource[sourceKey] = symbol;
    saveSettings();
    renderSource();
    renderSymbols();
    renderFavourites();
    loadHistory();
  }

  // A short swipe scrolls the strip with kinetic momentum. A long press (or
  // mouse drag) picks up a chip for reordering without desktop-only HTML drag
  // and drop.
  elFavourites.addEventListener("pointerdown", (event) => {
    const chip = event.target.closest(".favourite-chip");
    if (!chip || event.button !== 0 || favouriteGesture) return;
    const pointerId = event.pointerId;
    stopFavouriteMomentum();
    favouriteGesture = {
      chip, pointerId, startX: event.clientX, startY: event.clientY,
      startScroll: elFavourites.scrollLeft, lastScroll: elFavourites.scrollLeft,
      lastMoveAt: performance.now(), velocity: 0,
      dragging: false, scrolling: false, pressTimer: null,
    };
    chip.setPointerCapture(pointerId);
    if (event.pointerType === "mouse") return;
    favouriteGesture.pressTimer = setTimeout(startFavouriteDrag, 350);
  });
  elFavourites.addEventListener("pointermove", (event) => {
    const gesture = favouriteGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (event.pointerType === "mouse" && Math.hypot(dx, dy) > 5) startFavouriteDrag();
      else if (Math.hypot(dx, dy) > 8) {
        clearTimeout(gesture.pressTimer);
        gesture.scrolling = true;
      }
      if (gesture.scrolling) {
        const now = performance.now();
        elFavourites.scrollLeft = gesture.startScroll - dx;
        const elapsed = Math.max(1, now - gesture.lastMoveAt);
        gesture.velocity = (elFavourites.scrollLeft - gesture.lastScroll) / elapsed;
        gesture.lastScroll = elFavourites.scrollLeft;
        gesture.lastMoveAt = now;
      }
    }
    if (gesture.dragging) moveFavouriteChip(event.clientX);
    event.preventDefault();
  });
  function finishFavouriteGesture(event) {
    const gesture = favouriteGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const changed = gesture.dragging || gesture.scrolling;
    if (gesture.dragging) saveFavouriteOrderFromDom();
    else if (gesture.scrolling) startFavouriteMomentum(gesture.velocity);
    clearFavouriteGesture();
    if (changed) {
      suppressFavouriteClick = true;
      setTimeout(() => { suppressFavouriteClick = false; }, 0);
    }
  }
  elFavourites.addEventListener("pointerup", finishFavouriteGesture);
  elFavourites.addEventListener("pointercancel", finishFavouriteGesture);

  elSymbol.addEventListener("change", () => {
    settings.symbol = elSymbol.value;
    settings.symbolBySource[settings.source] = elSymbol.value;
    saveSettings();
    renderFavourites();
    loadHistory();
  });
  elFavouriteToggle.addEventListener("click", toggleFavourite);

  for (const btn of document.querySelectorAll("#source-toggle button")) {
    btn.addEventListener("click", () => {
      const nextSource = btn.dataset.source;
      if (nextSource === settings.source) return;
      const src = SOURCES[nextSource];
      const nextSymbol = settings.symbolBySource[nextSource] || (src.symbols.includes(settings.symbol) ? settings.symbol : src.symbols[0]);
      selectTicker(nextSource, nextSymbol);
    });
  }
  function renderSource() {
    for (const btn of document.querySelectorAll("#source-toggle button")) {
      const active = btn.dataset.source === settings.source;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }
  function renderSymbols() {
    elSymbol.innerHTML = "";
    const src = SOURCES[settings.source];
    src.symbols.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = src.display(s);
      opt.selected = s === settings.symbol;
      elSymbol.appendChild(opt);
    });
  }

  const cbEma = $("cb-ema"), cbRsi = $("cb-rsi"), cbVol = $("cb-vol"), cbRsiLv = $("cb-rsilv");
  const inOb = $("in-ob"), inOs = $("in-os");
  cbEma.checked = settings.indicators.ema;
  cbRsi.checked = settings.indicators.rsi;
  cbVol.checked = settings.indicators.vol;
  cbRsiLv.checked = settings.indicators.rsiLvls;
  inOb.value = settings.indicators.rsiOB;
  inOs.value = settings.indicators.rsiOS;
  function applyIndicatorVis() {
    emaSeries.applyOptions({ visible: settings.indicators.ema });
    volumeSeries.applyOptions({ visible: settings.indicators.vol });
    elRsi.classList.toggle("hidden", !settings.indicators.rsi);
    refreshTriggerCurves();
    invalidateOverlay();
    invalidateRSI();
  }
  cbEma.addEventListener("change", () => { settings.indicators.ema = cbEma.checked; saveSettings(); applyIndicatorVis(); });
  cbRsi.addEventListener("change", () => { settings.indicators.rsi = cbRsi.checked; saveSettings(); applyIndicatorVis(); });
  cbVol.addEventListener("change", () => { settings.indicators.vol = cbVol.checked; saveSettings(); applyIndicatorVis(); });
  cbRsiLv.addEventListener("change", () => { settings.indicators.rsiLvls = cbRsiLv.checked; saveSettings(); applyIndicatorVis(); });
  function lvlChanged(e) {
    let ob = Math.max(50, Math.min(95, +inOb.value || 70));
    let os = Math.max(5, Math.min(50, +inOs.value || 30));
    if (os >= ob) {
      if (e && e.target === inOb) os = Math.max(5, ob - 1);
      else ob = Math.min(95, os + 1);
    }
    settings.indicators.rsiOB = ob;
    settings.indicators.rsiOS = os;
    inOb.value = ob; inOs.value = os;
    saveSettings();
    applyIndicatorVis();
  }
  inOb.addEventListener("change", lvlChanged);
  inOs.addEventListener("change", lvlChanged);

  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (_) {}
  }
  function loadSettings() {
    const d = {
      source: "binance", symbol: "BTC", interval: "15m", symbolBySource: {}, favourites: [],
      indicators: { ema: true, rsi: true, vol: true, rsiLvls: true, rsiOB: 70, rsiOS: 30 },
    };
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); } catch (_) {}
    if (!s || typeof s !== "object") return d;
    d.source = SOURCES[s.source] ? s.source : "binance";
    d.interval = INTERVAL_SEC[s.interval] ? s.interval : "15m";
    if (s.symbolBySource && typeof s.symbolBySource === "object") {
      for (const [sourceKey, src] of Object.entries(SOURCES)) {
        if (src.symbols.includes(s.symbolBySource[sourceKey])) d.symbolBySource[sourceKey] = s.symbolBySource[sourceKey];
      }
    }
    const src = SOURCES[d.source];
    d.symbol = src.symbols.includes(s.symbol) ? s.symbol : (d.symbolBySource[d.source] || src.symbols[0]);
    const si = s.indicators && typeof s.indicators === "object" ? s.indicators : {};
    for (const key of ["ema", "rsi", "vol", "rsiLvls"]) {
      if (typeof si[key] === "boolean") d.indicators[key] = si[key];
    }
    const ob = Number(si.rsiOB), os = Number(si.rsiOS);
    if (Number.isFinite(ob)) d.indicators.rsiOB = Math.max(50, Math.min(95, ob));
    if (Number.isFinite(os)) d.indicators.rsiOS = Math.max(5, Math.min(50, os));
    if (d.indicators.rsiOS >= d.indicators.rsiOB) {
      d.indicators.rsiOB = 70; d.indicators.rsiOS = 30;
    }
    d.symbolBySource[d.source] = d.symbol;
    if (Array.isArray(s.favourites)) {
      for (const favourite of s.favourites) {
        if (!favourite || !SOURCES[favourite.source] || !SOURCES[favourite.source].symbols.includes(favourite.symbol)) continue;
        if (!d.favourites.some((f) => f.source === favourite.source && f.symbol === favourite.symbol)) {
          d.favourites.push({ source: favourite.source, symbol: favourite.symbol });
        }
      }
    } else {
      // Give existing installations a useful first chip without overwriting a
      // deliberate empty list saved by the new favourites control.
      d.favourites.push({ source: d.source, symbol: d.symbol });
    }
    return d;
  }
  function loadDrawings() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(LS_DRAWINGS) || "{}"); }
    catch (_) { return {}; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const clean = {};
    const types = new Set(["hline", "trend"]);
    for (const [drawingKey, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      clean[drawingKey] = list.flatMap((d) => {
        if (!d || !types.has(d.type) || !Array.isArray(d.points)) return [];
        const needed = d.type === "hline" ? 1 : 2;
        if (d.points.length !== needed) return [];
        const points = d.points.map((p) => ({ time: Number(p.time), price: Number(p.price) }));
        if (points.some((p) => !Number.isFinite(p.time) || !Number.isFinite(p.price) || p.time <= 0 || p.price <= 0)) return [];
        const color = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#f0b90b";
        return [{ id: Number.isFinite(Number(d.id)) ? Number(d.id) : Date.now() + Math.random(), type: d.type, points, color }];
      });
    }
    return clean;
  }

  // ============================== candle close countdown ==============================
  // Time left on the newest bar. It is derived from that bar's own open time
  // (not from when the page loaded), so interval switches, market closures and
  // irregular monthly bars all stay correct. It lives in the empty right-hand
  // gutter just above the time axis, clear of candles and the price scale.
  const elCountdown = document.createElement("div");
  elCountdown.className = "candle-countdown";
  elCountdown.title = "Time until the current candle closes";
  elCountdown.hidden = true;
  elCountdown.innerHTML = '<span class="cd-what"></span><span class="cd-left"></span>';
  elMain.appendChild(elCountdown);
  const elCdWhat = elCountdown.firstElementChild, elCdLeft = elCountdown.lastElementChild;
  let countdownTick = null, countdownOffset = "", countdownText = "", countdownLabel = "";

  function barCloseMs() {
    const last = candles[candles.length - 1];
    if (!last || !Number.isFinite(last.time)) return null;
    const openMs = last.time * 1000;
    if (settings.interval === "1M") {
      const d = new Date(openMs);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return openMs + INTERVAL_SEC[settings.interval] * 1000;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(total % 60)}`;
    if (hours) return `${hours}:${pad(mins)}:${pad(total % 60)}`;
    return `${mins}:${pad(total % 60)}`;
  }

  // Keep clear of the price scale (its width tracks the printed precision) and
  // of the time axis.
  function placeCountdown() {
    let scale = 0, axis = 0;
    try { scale = chart.priceScale("right").width() || 0; } catch (_) { /* older library */ }
    try { axis = chart.timeScale().height() || 0; } catch (_) { /* older library */ }
    const right = `${Math.round(Math.max(scale, 56) + 10)}px`;
    const bottom = `${Math.round(Math.max(axis, 26) + 6)}px`;
    if (`${right}|${bottom}` === countdownOffset) return;
    countdownOffset = `${right}|${bottom}`;
    elCountdown.style.right = right;
    elCountdown.style.bottom = bottom;
  }

  function renderCountdown() {
    const close = barCloseMs();
    // A bar older than one interval means the market itself is closed, so a
    // countdown there would only ever read zero.
    if (close === null || Date.now() - close > INTERVAL_SEC[settings.interval] * 1000) {
      if (!elCountdown.hidden) elCountdown.hidden = true;
      return;
    }
    elCountdown.hidden = false;
    placeCountdown();
    const left = close - Date.now();
    const text = formatCountdown(left);
    if (text !== countdownText) { countdownText = text; elCdLeft.textContent = text; }
    const label = `${settings.interval} closes in`;
    if (label !== countdownLabel) { countdownLabel = label; elCdWhat.textContent = label; }
    elCountdown.classList.toggle("closing", left <= 10000);
  }

  function stopCountdown() {
    if (countdownTick) clearTimeout(countdownTick);
    countdownTick = null;
  }

  function startCountdown() {
    stopCountdown();
    renderCountdown();
    // Re-align to the wall clock every tick so the digits never skip.
    const arm = () => {
      countdownTick = setTimeout(() => { renderCountdown(); arm(); }, 1000 - (Date.now() % 1000) + 5);
    };
    arm();
  }

  // ============================== resize ==============================
  const roMain = new ResizeObserver(() => {
    chart.applyOptions({ width: elMain.clientWidth, height: elMain.clientHeight });
    placeCountdown();
    invalidateOverlay();
    invalidateRSI();
  });
  roMain.observe(elMain);
  const roRsi = new ResizeObserver(() => {
    invalidateRSI();
  });
  roRsi.observe(elRsi);

  // ============================== boot ==============================
  alertUI = window.createCandleAlerts({
    chart, series: candleSeries, element: elMain,
    canSelect: () => !tool && !loading && candles.length > 0,
    getMarket: () => ({ source: settings.source, symbol: settings.symbol,
      label: SOURCES[settings.source].display(settings.symbol), sourceLabel: SOURCES[settings.source].label }),
    onSelectMarket: selectTicker,
  });
  renderSource();
  renderSymbols();
  renderFavourites();
  renderIntervals();
  applyIndicatorVis();
  chart.applyOptions({ width: elMain.clientWidth, height: elMain.clientHeight });
  startWatchdog();
  startCountdown();
  loadHistory();
})();
