# Run with: browser-harness < scripts/test-candle-measure-ui.py
# Isolated in-memory fixture: no production API calls, no venue sockets. The
# market feed is mocked with 100 candles so a measurement can be placed, then
# driven with synthetic pointer/mouse events the way a real gesture arrives.
#
# A placed measurement used to be display-only: any tap except the second
# placement click wiped it. It is now an object you can grab — the body slides
# the box, a corner/edge grip resizes it — and dragging the box must never pan
# the chart underneath it.
#
# The measurement itself is module-local, so the box is observed the way the
# user sees it: the app's hit map (published as the cursor on #main-chart) and
# the grip squares read back from the overlay canvas.
begin_browser_task()
from pathlib import Path
import json
import re as _re
import time

root = Path('/home/lepton/agentchatbox/public/experiments/candle-charts')
tab = new_tab('about:blank')
cdp('Page.bringToFront')
cdp('Emulation.setDeviceMetricsOverride', width=412, height=860, deviceScaleFactor=1, mobile=True)
mock = r'''
window.__ls = {};
Object.defineProperty(window, 'localStorage', {configurable:true, value:{
  getItem: (k) => (k in window.__ls ? window.__ls[k] : null),
  setItem: (k, v) => { window.__ls[k] = String(v); },
  removeItem: (k) => { delete window.__ls[k]; },
}});
window.__ls['cc-settings-v1'] = JSON.stringify({
  source:'hyperliquid', symbol:'P1', interval:'15m', symbolBySource:{hyperliquid:'P1'},
  favourites:[{source:'hyperliquid', symbol:'P1'}],
  sortMode:'volume', view:'chart',
  // rsiLvls stays off: those faint trigger curves are painted on the same
  // overlay canvas and would pollute the pixel read-backs below.
  indicators:{ema:true, rsi:true, vol:true, rsiLvls:false, rsiOB:70, rsiOS:30},
});
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url; this.readyState = 1;
    setTimeout(() => { if (this.readyState === 1) this.dispatchEvent(new Event('open')); }, 0);
  }
  send() {}
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
window.__bars = () => Array.from({length:100}, (_, i) => {
  const base = Math.floor(Date.now() / 900000) * 900000;
  return {t: base - (99 - i) * 900000, o:'2500', h:'2540', l:'2460', c:String(2500 + Math.sin(i) * 20), v:'100'};
});
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  const send = (data) => new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
  if (url.includes('/api/alerts')) return send({alerts:[], feeds:[]});
  if (url.includes('/api/quote?')) return send({price:'2500', level:'2500', step:'0.01', event_at:Date.now()});
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'candleSnapshot') return send(window.__bars());
    return send([{universe:[{name:'P1'}]}, [{dayNtlVlm:'1000000', markPx:'2500', prevDayPx:'2490'}]]);
  }
  return send({});
};

// ---- synthetic gesture plumbing (client coords -> #main-chart local coords) ----
// This shared Chrome window is occluded, and it throttles requestAnimationFrame
// to roughly two frames per second while reporting itself visible. The chart
// coalesces overlay paints behind a single pending frame, so route animation
// frames through timers: paints then land in milliseconds, as they do for a
// focused window, instead of ~600ms later than the assertions expect.
window.__rafSeq = 0;
window.__rafPending = new Set();
window.requestAnimationFrame = (cb) => {
  const id = 'raf' + (++window.__rafSeq);
  window.__rafPending.add(id);
  setTimeout(() => { if (window.__rafPending.delete(id)) cb(performance.now()); }, 0);
  return id;
};
window.cancelAnimationFrame = (id) => { window.__rafPending.delete(id); };
window.__chartEl = () => document.getElementById('main-chart');
window.__evTarget = () => window.__chartEl().querySelector('canvas');
window.__client = (x, y) => {
  const r = window.__chartEl().getBoundingClientRect();
  return {clientX: r.left + x, clientY: r.top + y};
};
window.__pev = (type, x, y, opts = {}) => {
  const {clientX, clientY} = window.__client(x, y);
  const button = opts.button !== undefined ? opts.button : (type === 'pointermove' ? -1 : 0);
  const buttons = opts.buttons !== undefined ? opts.buttons : (type === 'pointerup' ? 0 : 1);
  (opts.target || window.__evTarget()).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button, buttons, clientX, clientY,
  }));
};
// The browser emits mousedown/mousemove/mouseup alongside the pointer events,
// and lightweight-charts listens to those, so a faithful gesture sends both.
window.__mev = (type, x, y) => {
  const {clientX, clientY} = window.__client(x, y);
  window.__evTarget().dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX, clientY,
    button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1,
  }));
};
window.__hover = (x, y) => {
  window.__pev('pointermove', x, y, {buttons: 0});
  return window.__chartEl().style.cursor;
};
window.__drag = (fromX, fromY, toX, toY, steps = 6) => {
  window.__pev('pointerdown', fromX, fromY);
  window.__mev('mousedown', fromX, fromY);
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * i / steps;
    const y = fromY + (toY - fromY) * i / steps;
    window.__pev('pointermove', x, y);
    window.__mev('mousemove', x, y);
  }
  window.__pev('pointerup', toX, toY, {buttons: 0});
  window.__mev('mouseup', toX, toY);
};
window.__tap = (x, y) => {
  window.__pev('pointerdown', x, y);
  window.__pev('pointerup', x, y, {buttons: 0});
};
window.__place = (x1, y1, x2, y2) => {
  document.getElementById('btn-measure').click();
  window.__tap(x1, y1);
  window.__tap(x2, y2);
  return document.body.classList.contains('hline-mode');   // must be disarmed
};
// Overlay canvas = the one the app appends to #main-chart with z-index 5.
window.__overlay = () => [...window.__chartEl().querySelectorAll('canvas')].find((n) => n.style.zIndex === '5');
window.__px = (x, y) => {
  const d = window.__overlay().getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};
// The grips are the only opaque #0b0e11 pixels on the overlay, so their
// cluster centres give the box edges exactly as they are painted.
window.__boxFromGrips = () => {
  const c = window.__overlay();
  if (!c || !c.width) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const cols = new Set(), rows = new Set();
  let count = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i] === 11 && d[i + 1] === 14 && d[i + 2] === 17 && d[i + 3] === 255) {
        count++; cols.add(x); rows.add(y);
      }
    }
  }
  if (!count) return null;
  // A grip is a ~5px square of opaque fill inside a 1.5px stroke.
  const runs = (set) => {
    const out = [];
    for (const v of [...set].sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && v - last[1] <= 4) last[1] = v; else out.push([v, v]);
    }
    return out.map(([a, z]) => (a + z + 1) / 2);
  };
  const xs = runs(cols), ys = runs(rows);
  return JSON.stringify({
    left: xs[0], right: xs[xs.length - 1], top: ys[0], bot: ys[ys.length - 1],
    count,
  });
};
'''
html = root.joinpath('index.html').read_text()
html = _re.sub(r'<link rel="stylesheet"[^>]+>', '<style>' + root.joinpath('style.css').read_text() + '</style>', html)
html = _re.sub(r'<script src="lwc[^>]+></script>', '', html)
html = _re.sub(r'<script src="(?:alerts|watchlist|app)\.js[^>]+></script>', '', html)
html = html.replace('</body>', '<script>' + mock + '</script></body>')
frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
cdp('Page.setDocumentContent', frameId=frame, html=html)
for filename in ['lwc-4.0.1.js', 'alerts.js', 'watchlist.js', 'app.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset+18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')

wait_until("document.querySelector('#legend').textContent.includes('P1')")

# ---------- wait for the header/chart layout to settle ----------
# The first quote and the RSI pane reflow the chart, which rescales both axes;
# a measurement placed mid-reflow is stored in data space and lands elsewhere.
def chart_size():
    return js("JSON.stringify([document.getElementById('main-chart').clientWidth, document.getElementById('main-chart').clientHeight])")

sizes = []
for _ in range(40):
    sizes.append(chart_size())
    if len(sizes) >= 4 and len(set(sizes[-4:])) == 1:
        break
    time.sleep(0.25)
assert len(set(sizes[-4:])) == 1, sizes[-6:]
W, H = json.loads(sizes[-1])
time.sleep(0.3)

# Keep clear of the right-hand price scale and of the RSI pane below the chart.
x1, x2 = round(W * 0.12), round(W * 0.60)
yt, yb = round(H * 0.25), round(H * 0.65)
shift, rise = 70, 60            # body drag: right and up
assert x1 > 20 and x2 + shift < W - 12 and yt - rise - 45 > 8 and yb + 45 < H, (W, H)

def box():
    raw = js("window.__boxFromGrips()")
    assert raw, 'no measurement grips painted on the overlay'
    return json.loads(raw)

def hover(x, y):
    return js(f"window.__hover({round(x)}, {round(y)})")

# ---------- place a measurement ----------
# a = bottom-left (lower price), b = top-right (higher) so the range is "up".
assert js(f"window.__place({x1}, {yb}, {x2}, {yt})") is False
time.sleep(0.4)
b = box()
assert b['count'] > 40, b            # eight grips, minus their stroke
tolerance = 3.5
for edge, want in (('left', x1), ('right', x2), ('top', yt), ('bot', yb)):
    assert abs(b[edge] - want) <= tolerance, (edge, b[edge], want, (W, H))
assert json.loads(js(f"JSON.stringify(window.__px({b['left']}, {b['top']}))")) == [11, 14, 17, 255], 'top-left grip'
fill = json.loads(js(f"JSON.stringify(window.__px({(b['left'] + b['right']) / 2}, {(b['top'] + b['bot']) / 2}))"))
assert 0 < fill[3] < 40 and fill[1] > fill[0], fill
print('PASS: a placed measurement draws its range box plus dark grips on every usable edge.')

# ---------- the published cursor proves the hit map ----------
mid = (b['left'] + b['right']) / 2
cy = (b['top'] + b['bot']) / 2
assert hover(mid, b['top']) == 'ns-resize', 'top edge grip'
assert hover(mid, b['bot']) == 'ns-resize', 'bottom edge grip'
assert hover(b['left'], cy) == 'ew-resize', 'left edge grip'
assert hover(b['right'], cy) == 'ew-resize', 'right edge grip'
assert hover(b['left'], b['top']) == 'nwse-resize', 'top-left corner'
assert hover(b['right'], b['bot']) == 'nwse-resize', 'bottom-right corner'
assert hover(b['left'], b['bot']) == 'nesw-resize', 'bottom-left corner'
assert hover(b['right'], b['top']) == 'nesw-resize', 'top-right corner'
assert hover(mid, cy) == 'move', 'body'
assert hover(mid + 10, b['top'] + 20) == 'move', 'body next to the top edge'
assert hover(b['left'] - 25, cy) == '', 'outside'
print('PASS: hovering a placed measurement reports move over the body and the right cursor on each grip.')

# ---------- drag the body ----------
js(f"window.__drag({round(mid)}, {round(cy)}, {round(mid) + shift}, {round(cy) - rise})")
time.sleep(0.4)
b2 = box()
for edge, want in (('left', b['left'] + shift), ('right', b['right'] + shift),
                   ('top', b['top'] - rise), ('bot', b['bot'] - rise)):
    assert abs(b2[edge] - want) <= 2.5, (edge, b2[edge], want, b)
assert hover(b['left'] + 30, cy) == '', 'old left edge vacated'
assert hover(b['right'] + 30, cy) == 'move', 'area right of the old box is inside now'
assert hover(mid, b['top']) == 'move', 'old top edge is body now'
assert json.loads(js(f"JSON.stringify(window.__px({b['left']}, {b['top']}))"))[3] < 40, 'old grip pixel left behind'
print('PASS: dragging the body slides the whole box, and the chart does not pan underneath it.')

# ---------- drag the top edge to grow the range ----------
mid2 = (b2['left'] + b2['right']) / 2
js(f"window.__drag({round(mid2)}, {round(b2['top'])}, {round(mid2)}, {round(b2['top']) - 40})")
time.sleep(0.4)
b3 = box()
assert abs(b3['top'] - (b2['top'] - 40)) <= 2.5, (b3, b2)
assert abs(b3['bot'] - b2['bot']) <= 2.5 and abs(b3['left'] - b2['left']) <= 2.5 and abs(b3['right'] - b2['right']) <= 2.5, (b3, b2)
assert hover(mid2, b3['top']) == 'ns-resize', 'new top grip'
assert hover(mid2, b2['top']) == 'move', 'old top edge is body now'
print('PASS: dragging the top grip upward grows the measurement box, leaving its time range alone.')

# ---------- drag the bottom edge downward ----------
js(f"window.__drag({round(mid2)}, {round(b3['bot'])}, {round(mid2)}, {round(b3['bot']) + 40})")
time.sleep(0.4)
b4 = box()
assert abs(b4['bot'] - (b3['bot'] + 40)) <= 2.5, (b4, b3)
assert abs(b4['top'] - b3['top']) <= 2.5, (b4, b3)
assert hover(mid2, b4['bot']) == 'ns-resize', 'new bottom grip'
assert hover(mid2, b3['bot']) == 'move', 'old bottom edge is body now'
assert json.loads(js(f"JSON.stringify(window.__px({round(mid2)}, {round(b4['bot'])}))")) == [11, 14, 17, 255], 'bottom grip pixel'
capture_screenshot('/tmp/candle-measure-placed.png', max_dim=1200)
print('PASS: dragging the bottom grip downward grows the measurement box.')

# ---------- a tap away still clears it, and so does Esc ----------
js(f"window.__tap({round(W * 0.5)}, {round(H * 0.9)})")
time.sleep(0.35)
assert js("window.__boxFromGrips()") is None, 'tap away should clear the measurement'
assert js(f"window.__px({round(mid2)}, {round(b4['bot'])})")[3] == 0, 'overlay not cleared'

js(f"window.__place({x1}, {yb}, {x2}, {yt})")
time.sleep(0.3)
assert js("window.__boxFromGrips()") is not None
js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); void 0")
time.sleep(0.35)
assert js("window.__boxFromGrips()") is None, 'Esc should clear the measurement'
print('PASS: a tap off the box, or Esc, still removes a placed measurement.')

# ---------- an armed tool keeps its own gesture ----------
js(f"window.__place({x1}, {yb}, {x2}, {yt})")
time.sleep(0.3)
assert js("window.__boxFromGrips()") is not None
js("document.getElementById('btn-hline').click(); void 0")
assert hover(mid, cy) == '', 'armed tool shows the crosshair, not the grab cursor'
js(f"window.__tap({round(mid)}, {round(cy)})")
time.sleep(0.35)
assert js("document.body.classList.contains('hline-mode')") is False, 'hline should have placed and disarmed'
assert js("window.__boxFromGrips()") is None, 'placing via a tool clears the old measurement'
print('PASS: an armed drawing tool still owns the gesture over a placed measurement.')

cdp('Emulation.clearDeviceMetricsOverride')
finish_scope()
