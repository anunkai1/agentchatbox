"use strict";
// Live favourites list for the candle chart. Every figure here is the venue's
// own stream: Hyperliquid `activeAssetCtx`, one subscription per market on a
// single socket, pushed about once a second with the venue's mark price, its
// day-change baseline and its volume. Nothing in this file polls, and nothing
// here is a trading control — a row only selects a market for the chart.
//
// Binance Spot has no live quote feed in this experiment, so markets pinned
// there stay selectable but carry no figures. Change is the venue's own day
// change (Hyperliquid resets at 00:00 UTC), never a chart interval.
window.createCandleWatchlist = function ({ element, getMarkets, getCurrent, onSelect, onRemove }) {
  const SOCKET_URL = "wss://api.hyperliquid.xyz/ws";
  const RETRY_CAP_MS = 15000;
  const RETRY_BASE_MS = 1000;
  const SILENT_MS = 30000;   // connected but silent: say so instead of looking live
  const STATUS_MS = 4000;
  const OPEN_STATE = 1;

  const status = document.createElement("div");
  status.className = "quote-status";
  const dot = document.createElement("span");
  dot.className = "live-dot off";
  dot.textContent = "●";
  const statusText = document.createElement("span");
  statusText.className = "quote-status-text";
  const statusNote = document.createElement("span");
  statusNote.className = "quote-status-note";
  status.append(dot, statusText, statusNote);

  const list = document.createElement("ul");
  list.className = "quote-rows";

  const empty = document.createElement("p");
  empty.className = "quote-empty";
  empty.hidden = true;
  empty.textContent = "No favourites yet. Star a market on the chart and it appears here with live prices.";
  element.append(status, list, empty);

  const formatters = new Map();
  let markets = [];                 // current favourites, in star order
  let marketByKey = new Map();
  let liveBySymbol = new Map();
  const rows = new Map();           // market key -> row elements
  const quotes = new Map();         // market key -> figures seen this session
  let socket = null;
  let socketToken = 0;
  let subscriptionKey = "";
  let retryTimer = null;
  let retryAttempt = 0;
  let lastPushAt = 0;
  let statusTimer = null;
  let open = false;

  const keyOf = (market) => `${market.source}|${market.symbol}`;

  function numberText(value, decimals) {
    let format = formatters.get(decimals);
    if (!format) {
      format = new Intl.NumberFormat("en-AU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      formatters.set(decimals, format);
    }
    let text = format.format(value);
    // About six significant digits, but drop the padding zeros they produce
    // (2.45710 -> 2.4571) while keeping the two decimals every venue quotes.
    if (decimals > 2) text = text.replace(/(\.\d{2}\d*?)0+$/, "$1");
    return text;
  }

  // 76736.7 -> 2dp, 7627.8 -> 2dp, 336.34 -> 2dp, 1.4045 -> 4dp, 0.032010 -> 5dp.
  function decimalsFor(price) {
    if (!Number.isFinite(price) || price <= 0) return 2;
    return Math.max(2, Math.min(6, 5 - Math.floor(Math.log10(price))));
  }

  function formatPrice(price) {
    return Number.isFinite(price) && price > 0 ? numberText(price, decimalsFor(price)) : "—";
  }

  // "76,736.70" with "+548.70 +0.72%" under it, the way a watchlist reads.
  function changeFigures(price, prevDay) {
    if (!Number.isFinite(price) || !Number.isFinite(prevDay) || prevDay <= 0) return { text: "—", dir: 0 };
    const diff = price - prevDay;
    const pct = (diff / prevDay) * 100;
    const sign = diff >= 0 ? "+" : "-";
    return {
      text: `${sign}${numberText(Math.abs(diff), decimalsFor(price))} ${sign}${Math.abs(pct).toFixed(2)}%`,
      dir: Math.sign(diff),
    };
  }

  function monogram(label) {
    const letters = ((label.match(/[A-Za-z0-9]/g) || []).join("").slice(0, 2) || "?").toUpperCase();
    let hue = 0;
    for (const char of label) hue = (hue * 31 + char.codePointAt(0)) % 360;
    return { letters, hue };
  }

  // A price that moves flashes green or red, the way a live watchlist reads.
  function flash(node, up) {
    if (node.getAnimations().length) return;   // one pulse per move, not one per tick
    node.animate([
      { backgroundColor: up ? "rgba(14,203,81,.34)" : "rgba(246,70,93,.34)" },
      { backgroundColor: "rgba(14,203,81,0)" },
    ], { duration: 420, easing: "ease-out" });
  }

  function buildRow(market) {
    const node = document.createElement("li");
    node.className = "quote-row";
    node.dataset.source = market.source;
    node.dataset.symbol = market.symbol;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "quote-main";
    const badge = document.createElement("span");
    badge.className = "quote-badge";
    const { letters, hue } = monogram(market.label);
    badge.textContent = letters;
    badge.style.background = `hsl(${hue} 52% 62%)`;
    const id = document.createElement("span");
    id.className = "quote-id";
    const symbolEl = document.createElement("span");
    symbolEl.className = "quote-symbol";
    symbolEl.textContent = market.label;
    const venueEl = document.createElement("span");
    venueEl.className = "quote-venue";
    venueEl.textContent = market.venue;
    id.append(symbolEl, venueEl);
    const figures = document.createElement("span");
    figures.className = "quote-figs";
    const priceEl = document.createElement("span");
    priceEl.className = "quote-price";
    priceEl.textContent = "—";
    const changeEl = document.createElement("span");
    changeEl.className = "quote-change";
    changeEl.textContent = "—";
    figures.append(priceEl, changeEl);
    main.append(badge, id, figures);
    main.title = market.live
      ? `${market.label} · ${market.venue} · show it on the chart`
      : `${market.label} · ${market.venue} · no live feed here · show it on the chart`;
    main.setAttribute("aria-label", main.title);
    main.addEventListener("click", () => onSelect(market.source, market.symbol));
    const star = document.createElement("button");
    star.type = "button";
    star.className = "quote-star";
    star.textContent = "★";
    star.title = `Remove ${market.label} from favourites`;
    star.setAttribute("aria-label", star.title);
    star.addEventListener("click", () => onRemove(market.source, market.symbol));
    node.append(main, star);
    return { node, priceEl, changeEl, key: keyOf(market) };
  }

  function paint(row, market) {
    const quote = quotes.get(row.key);
    const usable = market.live && quote && !quote.invalid && Number.isFinite(quote.price);
    if (!usable) {
      row.node.classList.toggle("rejected", !!(market.live && quote && quote.invalid));
      if (row.priceEl.textContent !== "—") row.priceEl.textContent = "—";
      const note = !market.live
        ? "no live feed here"
        : quote && quote.invalid ? "not trading on the venue" : "waiting for the venue";
      if (row.changeEl.textContent !== note) {
        row.changeEl.textContent = note;
        row.changeEl.className = "quote-change";
      }
      return;
    }
    row.node.classList.remove("rejected");
    const priceText = formatPrice(quote.price);
    if (row.priceEl.textContent !== priceText) {
      row.priceEl.textContent = priceText;
      if (Number.isFinite(quote.lastTick) && quote.price !== quote.lastTick) flash(row.priceEl, quote.price > quote.lastTick);
    }
    const change = changeFigures(quote.price, quote.prevDay);
    if (row.changeEl.textContent !== change.text) {
      row.changeEl.textContent = change.text;
      row.changeEl.className = "quote-change" + (change.dir > 0 ? " pos" : change.dir < 0 ? " neg" : "");
    }
  }

  function repaint() {
    for (const [key, row] of rows) {
      const market = marketByKey.get(key);
      if (market) paint(row, market);
    }
  }

  function updateStatus() {
    const live = markets.filter((market) => market.live);
    const connected = !!socket && socket.readyState === OPEN_STATE;
    const fresh = connected && Date.now() - lastPushAt < SILENT_MS;
    dot.classList.toggle("off", !fresh);
    if (!live.length) statusText.textContent = "No live feed for these markets";
    else if (fresh) statusText.textContent = `Live · ${live.length} market${live.length === 1 ? "" : "s"}`;
    else if (connected) statusText.textContent = "Connected, but the venue has sent nothing for 30s";
    else statusText.textContent = "Connecting to the live feed…";
    const rejected = live.filter((market) => quotes.get(keyOf(market))?.invalid).length;
    statusNote.textContent = rejected ? `${rejected} not trading here` : "";
  }

  function render() {
    const current = getCurrent() || {};
    const wanted = new Set(markets.map(keyOf));
    for (const [key, row] of rows) {
      if (!wanted.has(key)) { row.node.remove(); rows.delete(key); }
    }
    marketByKey = new Map(markets.map((market) => [keyOf(market), market]));
    liveBySymbol = new Map(markets.filter((market) => market.live).map((market) => [market.symbol, market]));
    markets.forEach((market, index) => {
      const key = keyOf(market);
      let row = rows.get(key);
      if (!row) { row = buildRow(market); rows.set(key, row); }
      row.node.classList.toggle("active", market.source === current.source && market.symbol === current.symbol);
      row.node.classList.toggle("unsupported", !market.live);
      if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] || null);
      paint(row, market);
    });
    empty.hidden = markets.length > 0;
    list.hidden = markets.length === 0;
    updateStatus();
  }

  function desiredSubscription() {
    return markets.filter((market) => market.live).map((market) => market.symbol).sort().join(",");
  }

  function applyCtx(coin, ctx) {
    const market = liveBySymbol.get(coin);
    if (!market) return;
    const price = Number(ctx.markPx);
    if (!Number.isFinite(price) || price <= 0) return;
    const key = keyOf(market);
    const previous = quotes.get(key);
    quotes.set(key, {
      price,
      prevDay: Number(ctx.prevDayPx),
      lastTick: previous && Number.isFinite(previous.price) ? previous.price : null,
      invalid: false,
    });
    lastPushAt = Date.now();
    const row = rows.get(key);
    if (row) paint(row, market);
    updateStatus();
  }

  // The venue answers a subscription for a market it does not have with
  // "Invalid subscription {...}", which is how a stale pin is told apart from
  // one that simply has not ticked yet.
  function markInvalid(text) {
    const match = /Invalid subscription (\{.*\})/.exec(text);
    if (!match) return;
    let coin = null;
    try { coin = JSON.parse(match[1]).coin; } catch (_) { return; }
    const market = liveBySymbol.get(coin);
    if (!market) return;
    const key = keyOf(market);
    quotes.set(key, { invalid: true });
    const row = rows.get(key);
    if (row) paint(row, market);
    updateStatus();
  }

  function handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!message || typeof message !== "object") return;
    if (message.channel === "activeAssetCtx" && message.data && message.data.ctx) {
      applyCtx(message.data.coin, message.data.ctx);
    } else if (message.channel === "error" && typeof message.data === "string") {
      markInvalid(message.data);
    }
  }

  function scheduleRetry() {
    if (retryTimer || !open || document.visibilityState !== "visible") return;
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retryAttempt);
    retryAttempt++;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  function connect() {
    if (socket || !open || document.visibilityState !== "visible") return;
    const live = markets.filter((market) => market.live);
    if (!live.length) { updateStatus(); return; }
    const token = ++socketToken;
    let ws;
    try { ws = new WebSocket(SOCKET_URL); } catch (_) { scheduleRetry(); return; }
    socket = ws;
    ws.addEventListener("open", () => {
      if (token !== socketToken) return;
      retryAttempt = 0;
      subscriptionKey = live.map((market) => market.symbol).sort().join(",");
      for (const market of live) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: market.symbol } }));
      }
      updateStatus();
    });
    ws.addEventListener("message", (event) => {
      if (token !== socketToken) return;
      handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      if (token !== socketToken) return;
      socket = null;
      updateStatus();
      scheduleRetry();
    });
    // "error" is always followed by "close"; the retry lives there.
    ws.addEventListener("error", () => {});
  }

  function disconnect() {
    socketToken++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (socket) { const ws = socket; socket = null; try { ws.close(); } catch (_) {} }
    retryAttempt = 0;
    subscriptionKey = "";
    lastPushAt = 0;
    // Drop the figures rather than leave a frozen number sitting there looking
    // live: the venue re-sends a snapshot the moment the list is opened again.
    quotes.clear();
    repaint();
    updateStatus();
  }

  function setOpen(next) {
    open = !!next;
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (!open) { disconnect(); return; }
    render();
    connect();
    statusTimer = setInterval(updateStatus, STATUS_MS);
  }

  function refresh() {
    markets = getMarkets() || [];
    render();
    if (!open) return;
    const wanted = desiredSubscription();
    if (!socket) connect();
    else if (socket.readyState === OPEN_STATE && wanted !== subscriptionKey) {
      // Favourites changed under a live socket: re-subscribing is cheaper to
      // reason about than tracking per-coin subscribe/unsubscribe bookkeeping.
      disconnect();
      connect();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") { disconnect(); return; }
    if (open) { connect(); updateStatus(); }
  });
  window.addEventListener("pagehide", () => { disconnect(); });
  window.addEventListener("pageshow", () => { if (open) { connect(); updateStatus(); } });

  refresh();
  return { setOpen, refresh };
};
