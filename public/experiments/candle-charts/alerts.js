"use strict";
// Chart UI only. All monitoring, persistence and Telegram delivery live in the
// independent candle-alerts service, never in this tab or a Pi session.
window.createCandleAlerts = function ({ chart, series, element, getMarket, canSelect, onSelectMarket }) {
  const $ = (id) => document.getElementById(id);
  const apiRoot = "/experiments/candle-charts/api";
  const button = $("btn-alerts");
  const dialog = $("alert-dialog");
  const manager = $("alerts-manager");
  const levelInput = $("alert-level");
  const submit = $("alert-create");
  const error = $("alert-error");
  const list = $("alerts-list");
  const status = $("alerts-status");
  const toast = $("alert-toast");
  const date = (ts) => new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(ts)) + " AEST";
  let selection = null, draft = null, alerts = [], feeds = [], lines = [];
  let refreshing = false, saving = false, quoteToken = 0, timer = null, toastTimer = null;
  let filter = "active";
  let signature = "";

  const selectedLine = document.createElement("div");
  selectedLine.className = "alert-selected-line";
  selectedLine.hidden = true;
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "alert-crosshair-plus";
  plus.hidden = true;
  plus.title = "Create alert at selected price";
  plus.setAttribute("aria-label", "Create alert at selected price");
  element.append(selectedLine, plus);

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(apiRoot + path, {
        credentials: "same-origin", cache: "no-store", redirect: "error", ...options,
        headers: { "Content-Type": "application/json", "X-Candle-Alerts": "1" }, signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Please refresh and sign in again to manage alerts.");
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Alert service unavailable");
      return data;
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError) {
        throw new Error("Could not reach the alert service. Check your connection and try again.");
      }
      throw e;
    } finally { clearTimeout(timeout); }
  }
  function notify(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }
  function clearSelection() {
    selection = null;
    plus.hidden = selectedLine.hidden = true;
  }
  function positionSelection() {
    if (!selection || !canSelect()) { clearSelection(); return; }
    const y = series.priceToCoordinate(Number(selection.level));
    if (y === null || y < 0 || y > element.clientHeight - 25) {
      plus.hidden = selectedLine.hidden = true;
      return;
    }
    selectedLine.style.top = y + "px";
    plus.style.top = Math.max(0, Math.min(element.clientHeight - 44, y - 22)) + "px";
    plus.textContent = "+ " + selection.level;
    plus.hidden = selectedLine.hidden = false;
  }
  function track(param) {
    if (!canSelect() || dialog.open || manager.open) return;
    // Normal (not magnet) crosshair: use the horizontal cursor coordinate,
    // never seriesData.close. Retain selection when touch tracking ends.
    if (!param.point || param.point.y < 0 || param.point.y > element.clientHeight - 25) return;
    const value = series.coordinateToPrice(param.point.y);
    if (!Number.isFinite(value) || value <= 0) return;
    const market = getMarket();
    selection = { ...market, level: Number(value.toPrecision(10)).toString() };
    positionSelection();
  }
  for (const event of ["pointerdown", "touchstart", "touchend"]) {
    plus.addEventListener(event, (e) => e.stopPropagation());
  }
  plus.addEventListener("click", (e) => { e.stopPropagation(); if (selection) openCreate({ ...selection }); });
  element.addEventListener("pointerdown", (e) => { if (!plus.contains(e.target)) clearSelection(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });
  new ResizeObserver(positionSelection).observe(element);

  async function openCreate(market) {
    if (saving) return;
    if (manager.open) manager.close();
    draft = { ...market, id: crypto.randomUUID() };
    const current = draft;
    const token = ++quoteToken;
    clearSelection();
    $("alert-market").textContent = `${market.label} · ${market.sourceLabel}`;
    $("alert-quote").textContent = "Checking market price and tick size…";
    error.textContent = "";
    levelInput.value = market.level || "";
    levelInput.disabled = submit.disabled = true;
    if (!dialog.open) dialog.showModal();
    try {
      const params = new URLSearchParams({ source: market.source, symbol: market.symbol });
      if (market.level) params.set("level", market.level);
      const q = await request("/quote?" + params);
      if (draft !== current || token !== quoteToken || !dialog.open) return;
      levelInput.value = q.level;
      levelInput.step = "any";
      levelInput.min = q.step;
      $("alert-quote").textContent = `Latest trade: ${q.price} · ${date(q.event_at)}. Level rounded to a valid market tick.`;
      levelInput.disabled = submit.disabled = false;
    } catch (e) {
      if (draft === current && token === quoteToken && dialog.open) {
        error.textContent = e.message + " Close and retry when connected.";
      }
    }
  }
  $("alert-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!draft || saving || submit.disabled) return;
    if (!levelInput.value.trim() || !Number.isFinite(Number(levelInput.value)) || Number(levelInput.value) <= 0) {
      error.textContent = "Enter a positive price.";
      return;
    }
    const level = levelInput.value.trim();
    // A retry of an ambiguous network failure reuses the exact request ID.
    if (draft.submittedLevel && draft.submittedLevel !== level) draft.id = crypto.randomUUID();
    draft.submittedLevel = level;
    saving = true;
    submit.disabled = levelInput.disabled = true;
    $("alert-cancel").disabled = true;
    submit.textContent = "Saving…";
    error.textContent = "";
    try {
      const saved = await request("/alerts", { method: "POST", body: JSON.stringify({
        id: draft.id, source: draft.source, symbol: draft.symbol, level,
      }) });
      dialog.close();
      notify(`Alert saved at ${saved.level} · Telegram · Expires ${date(saved.expires_at)}`);
      await refresh();
    } catch (e) {
      error.textContent = e.message + " If delivery of this request was interrupted, retry with the same price or check the alert list.";
    } finally {
      saving = false;
      submit.disabled = levelInput.disabled = false;
      $("alert-cancel").disabled = false;
      submit.textContent = "Create alert";
    }
  });
  dialog.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
  dialog.addEventListener("close", () => { ++quoteToken; draft = null; });
  $("alert-cancel").addEventListener("click", () => { if (!saving) dialog.close(); });
  $("alerts-close").addEventListener("click", () => manager.close());
  button.addEventListener("click", () => { clearSelection(); signature = ""; manager.showModal(); renderList(); refresh(); });
  $("alerts-new").addEventListener("click", () => openCreate(getMarket()));
  $("alerts-refresh").addEventListener("click", refresh);
  $("alerts-filter").addEventListener("change", (e) => { filter = e.target.value; signature = ""; renderList(); });

  function marketLabel(a) {
    const src = { binance: "Binance Spot", hyperliquid: "Hyperliquid", xyz: "xyz RWA", xyzStocks: "xyz Stocks" };
    const label = a.source === "binance" ? (a.symbol === "ETHBTC" ? "ETH/BTC" : a.symbol + "USDT") : a.symbol.replace("xyz:", "");
    return { ...a, label, sourceLabel: src[a.source] || a.source };
  }
  function renderLines() {
    for (const line of lines) series.removePriceLine(line);
    const m = getMarket();
    lines = alerts.filter((a) => a.status === "active" && a.source === m.source && a.symbol === m.symbol).map((a) => series.createPriceLine({
      price: Number(a.level), color: "#38bdf8", lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: "🔔", // Short enough to leave candle space on mobile.
    }));
  }
  function renderList() {
    if (!manager.open) return;
    const selected = alerts.filter((a) => filter === "all" || a.status === filter);
    const nextSignature = JSON.stringify(selected);
    if (nextSignature === signature) return;
    signature = nextSignature;
    list.replaceChildren();
    if (!selected.length) {
      const empty = document.createElement("p");
      empty.textContent = "No " + (filter === "all" ? "" : filter + " ") + "alerts. Long-press the chart and tap +, or use New alert.";
      list.append(empty);
    }
    for (const a of selected) {
      const m = marketLabel(a);
      const card = document.createElement("article");
      card.className = "alert-card";
      const heading = document.createElement("strong");
      heading.textContent = `${m.label} · ${a.level}`;
      const detail = document.createElement("p");
      detail.textContent = `${m.sourceLabel} · ${a.status} · Either direction · Once`;
      const timing = document.createElement("p");
      timing.textContent = a.status === "triggered" ? `Crossed ${a.direction} · ${date(a.triggered_at)} · Telegram ${a.delivery}` : `Expires ${date(a.expires_at)}`;
      card.append(heading, detail, timing);
      if (a.delivery_error || a.gap) {
        const warning = document.createElement("p");
        warning.className = "alert-warning";
        warning.textContent = a.delivery_error || "Observed/recovered after a monitoring interruption.";
        card.append(warning);
      }
      const actions = document.createElement("div");
      actions.className = "alert-actions";
      function action(text, callback) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = text;
        b.addEventListener("click", async () => {
          b.disabled = true;
          try { await callback(); } catch (e) { notify(e.message); }
          finally { b.disabled = false; }
        });
        actions.append(b);
      }
      action("Show chart", () => { manager.close(); onSelectMarket(a.source, a.symbol); });
      if (a.status === "active") {
        action("Cancel alert", async () => {
          await request(`/alerts/${a.id}/cancel`, { method: "POST", body: "{}" });
          await refresh();
        });
      } else {
        action("Create again", () => openCreate(m));
        if (a.delivery !== "pending") action("Delete", async () => {
          await request(`/alerts/${a.id}`, { method: "DELETE", body: "{}" });
          await refresh();
        });
      }
      card.append(actions);
      list.append(card);
    }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const result = await request("/alerts");
      const changed = JSON.stringify(alerts) !== JSON.stringify(result.alerts);
      alerts = result.alerts; feeds = result.feeds;
      const active = alerts.filter((a) => a.status === "active").length;
      const offline = feeds.some((f) => !f.connected);
      const gap = feeds.some((f) => f.incomplete);
      const pending = alerts.some((a) => a.delivery === "pending");
      button.textContent = `🔔 ${active}`;
      button.classList.toggle("alert-warning", offline || gap || pending);
      button.title = `${active} active alerts${offline ? " · Monitoring reconnecting" : ""}${pending ? " · Telegram pending" : ""}`;
      status.textContent = offline ? "Monitoring reconnecting. Crossings may be missed during interruptions." : gap ? "Monitoring is connected, but recent history recovery was incomplete. Some crossings may have been missed." : active ? "Server monitoring connected · Telegram only · One shot" : "No active alerts · Telegram only · One shot";
      if (pending) status.textContent += " · Telegram delivery pending (automatic retries).";
      if (changed) renderLines();
      renderList();
    } catch (e) {
      button.textContent = "🔔 !";
      button.classList.add("alert-warning");
      status.textContent = e.message + " Monitoring status cannot be verified from this browser.";
    } finally { refreshing = false; }
  }
  function schedule() {
    clearInterval(timer);
    if (document.visibilityState === "visible") timer = setInterval(refresh, 10000);
  }
  document.addEventListener("visibilitychange", () => { schedule(); if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("pagehide", () => { clearInterval(timer); });
  window.addEventListener("pageshow", () => { schedule(); refresh(); });
  schedule(); refresh();
  return { track, clearSelection, marketChanged() { clearSelection(); renderLines(); }, refresh };
};
