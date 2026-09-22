# Run with: browser-harness < scripts/test-candle-intervals-ui.py
# Isolated in-memory fixture: no production API calls. Both candle feeds are
# mocked so the 30m interval can be followed from the interval button through
# the REST request and the live socket on each source.
begin_browser_task()
from pathlib import Path
import json
import re

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
  source:'binance', symbol:'BTC', interval:'15m', symbolBySource:{},
  favourites:[], sortMode:'volume', view:'chart',
  indicators:{ema:true, rsi:true, vol:true, rsiLvls:true, rsiOB:70, rsiOS:30},
});
window.__klineRequests = [];  // Binance REST kline requests, in order
window.__snapshots = [];      // Hyperliquid candleSnapshot intervals, in order
window.__sockets = [];        // every socket opened
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url; this.readyState = 1; this.sent = [];
    window.__sockets.push(this);
    setTimeout(() => { if (this.readyState === 1) this.dispatchEvent(new Event('open')); }, 0);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
const STEP = {'1m':60000, '5m':300000, '15m':900000, '30m':1800000, '1h':3600000};
// Bar times are epoch milliseconds, the shape both feeds answer with (the
// Hyperliquid reader divides by 1000 and the Binance reader does too).
const bars = (interval, count) => {
  const step = STEP[interval], base = Math.floor(Date.now() / step) * step;
  return Array.from({length: count}, (_, i) => ({
    t: base - (count - 1 - i) * step, o:'2500', h:'2540', l:'2460',
    c:String(2500 + Math.sin(i) * 20), v:'100',
  }));
};
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  const send = (data) => new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
  if (url.includes('/api/alerts') || url.includes('/api/quote')) {
    return send({alerts:[], feeds:[], price:'2500', level:'2500', step:'0.01', event_at:Date.now()});
  }
  if (url.includes('api.binance.com')) {
    const q = new URL(url).searchParams, interval = q.get('interval');
    window.__klineRequests.push({interval, symbol:q.get('symbol'), limit:q.get('limit')});
    // Binance klines row: [openTime, o, h, l, c, volume, closeTime, ...]
    return send(bars(interval, 120).map(b => [b.t, b.o, b.h, b.l, b.c, b.v,
      b.t + STEP[interval] - 1, '1', 1, '1', '1', '0']));
  }
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'candleSnapshot') {
      window.__snapshots.push(body.req.interval);
      return send(bars(body.req.interval, 120).map(b => ({
        ...b, i: body.req.interval, s: body.req.coin,
      })));
    }
    if (body.type === 'metaAndAssetCtxs') return send([{universe: []}, []]);
  }
  return send([]);
};
'''
html = root.joinpath('index.html').read_text()
html = re.sub(r'<link rel="stylesheet"[^>]+>', '<style>' + root.joinpath('style.css').read_text() + '</style>', html)
html = re.sub(r'<script src="lwc[^>]+></script>', '', html)
html = re.sub(r'<script src="(?:alerts|watchlist|app)\.js[^>]+></script>', '', html)
html = html.replace('</body>', '<script>' + mock + '</script></body>')
frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
cdp('Page.setDocumentContent', frameId=frame, html=html)
for filename in ['lwc-4.0.1.js', 'alerts.js', 'watchlist.js', 'app.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset + 18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')

# The interval row carries 30m between its neighbours, in ascending order.
buttons = json.loads(js("JSON.stringify([...document.querySelectorAll('#intervals button')].map(b => b.dataset.iv))"))
assert buttons == ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w', '1M'], buttons
assert js("document.querySelector('#intervals button[data-iv=\"30m\"]').textContent") == '30m'
print('PASS: the interval row offers 30m between 15m and 1h.')

# The saved 15m market loads first, with no 30m request on the wire.
wait_until("window.__klineRequests.length >= 1 && document.querySelector('#last-price').textContent !== '—'")
assert js("window.__klineRequests.map(r => r.interval).join(',')") == '15m'
assert '15m' in js("document.querySelector('#legend').textContent")

# Tapping 30m re-requests the history at 30m and re-subscribes the live socket
# to the 30m candle stream, on the same market.
js("document.querySelector('#intervals button[data-iv=\"30m\"]').click(); void 0")
wait_until("window.__klineRequests.some(r => r.interval === '30m')"
           " && window.__sockets.some(s => s.url.includes('@kline_30m'))")
last = json.loads(js("JSON.stringify(window.__klineRequests[window.__klineRequests.length - 1])"))
assert last['interval'] == '30m' and last['symbol'] == 'BTCUSDT' and last['limit'] == '500', last
assert js("JSON.stringify(window.__sockets[window.__sockets.length - 1].url)") == '"wss://stream.binance.com/ws/btcusdt@kline_30m"'
assert js("document.querySelector('#intervals button.active').dataset.iv") == '30m'
saved = json.loads(js("JSON.stringify(JSON.parse(window.__ls['cc-settings-v1']).interval)"))
assert saved == '30m', saved
print('PASS: 30m on Binance Spot re-fetches history and re-subscribes the live kline stream.')

# The bar being charted is a 30m bar, so the close countdown counts down to it.
wait_until("(() => { const el = document.querySelector('.candle-countdown');"
           " return !!el && !el.hidden && /^30m closes in\\d+:\\d\\d$/.test(el.textContent); })()")
countdown = json.loads(js("JSON.stringify(document.querySelector('.candle-countdown').textContent)"))
assert re.fullmatch(r'30m closes in\d+:\d\d', countdown), countdown
print('PASS: the candle-close countdown tracks the 30m bar, not the old 15m one.')

# Hyperliquid serves 30m too: the snapshot request and the socket subscription
# both carry the interval.
js("document.querySelector('#source-toggle button[data-source=\"hyperliquid\"]').click(); void 0")
wait_until("window.__snapshots.includes('30m')"
           " && window.__sockets.some(s => s.url.includes('api.hyperliquid.xyz')"
           "   && s.sent.some(m => m.subscription && m.subscription.interval === '30m'))")
assert js("JSON.stringify(window.__snapshots)") == '["30m"]', js("JSON.stringify(window.__snapshots)")
subs = json.loads(js("JSON.stringify(window.__sockets.filter(s => s.url.includes('api.hyperliquid.xyz'))"
                     ".flatMap(s => s.sent.filter(m => m.subscription).map(m => m.subscription)))"))
assert subs and all(s['type'] == 'candle' and s['coin'] == 'BTC' and s['interval'] == '30m' for s in subs), subs
assert 'Error' not in js("document.querySelector('#legend').textContent")
print('PASS: 30m on Hyperliquid snapshots history and subscribes the 30m candle feed.')

capture_screenshot('/tmp/candle-30m.png', max_dim=1200)
cdp('Emulation.clearDeviceMetricsOverride')
finish_scope()
