# Run with: browser-harness < scripts/test-candle-watchlist-ui.py
# Isolated in-memory fixture: no production API calls, no Telegram, no real
# venue sockets. The favourite list is driven through its own WebSocket mock so
# subscriptions, pushes, venue rejections and socket lifetime are all observed.
begin_browser_task()
from pathlib import Path
import json
import re
import time

root = Path('/home/lepton/agentchatbox/public/experiments/candle-charts')
tab = new_tab('about:blank')
cdp('Page.bringToFront')
cdp('Emulation.setDeviceMetricsOverride', width=412, height=860, deviceScaleFactor=1, mobile=True)
cdp('Emulation.setTouchEmulationEnabled', enabled=True, maxTouchPoints=1)
mock = r'''
window.__ls = {};
Object.defineProperty(window, 'localStorage', {configurable:true, value:{
  getItem: (k) => (k in window.__ls ? window.__ls[k] : null),
  setItem: (k, v) => { window.__ls[k] = String(v); },
  removeItem: (k) => { delete window.__ls[k]; },
}});
// One Binance pin (no live feed here), live Hyperliquid markets on different
// DEXes (one with no candle history yet) and one id the venue will reject.
window.__ls['cc-settings-v1'] = JSON.stringify({
  source:'binance', symbol:'BTC', interval:'15m', symbolBySource:{},
  favourites:[
    {source:'binance', symbol:'BTC'},
    {source:'hyperliquid', symbol:'ETH'},
    {source:'hyperliquid', symbol:'SOL'},
    {source:'xyz', symbol:'xyz:SP500'},
    {source:'xyz', symbol:'xyz:GONE'},
  ],
  sortMode:'volume', view:'chart',
  indicators:{ema:true, rsi:true, vol:true, rsiLvls:true, rsiOB:70, rsiOS:30},
});
window.__vis = 'visible';
Object.defineProperty(document, 'visibilityState', {configurable:true, get: () => window.__vis});
window.__sockets = [];
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url; this.readyState = 1; this.sent = [];
    window.__sockets.push(this);
    setTimeout(() => { if (this.readyState === 1) this.dispatchEvent(new Event('open')); }, 0);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
};
// The list socket is the one carrying activeAssetCtx subscriptions; the chart
// opens its own socket to the same host for candle candles.
window.__watchSocket = () => window.__sockets.filter((s) =>
  s.readyState === 1 && s.sent.some((m) => m.subscription && m.subscription.type === 'activeAssetCtx')).at(-1);
window.__push = (coin, markPx, prevDayPx) => window.__watchSocket().dispatchEvent(new MessageEvent('message', {
  data: JSON.stringify({channel:'activeAssetCtx', data:{coin, ctx:{markPx:String(markPx), prevDayPx:String(prevDayPx), dayNtlVlm:'1000000'}}}),
}));
window.__reject = (coin) => window.__watchSocket().dispatchEvent(new MessageEvent('message', {
  data: JSON.stringify({channel:'error', data:'Invalid subscription {"type":"activeAssetCtx","coin":"' + coin + '"}'}),
}));
window.__bars = () => Array.from({length:100}, (_, i) => {
  const base = Math.floor(Date.now() / 900000) * 900000;
  return {t: base - (99 - i) * 900000, o:'2500', h:'2540', l:'2460', c:String(2500 + Math.sin(i) * 20), v:'100'};
});
window.__historyRequests = 0;
window.__candleRequests = [];
window.__realNow = Date.now;
window.__now = Date.now();
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  const send = (data) => new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
  if (url.includes('/api/alerts')) return send({alerts:[], feeds:[]});
  if (url.includes('/api/quote?')) return send({price:'2500', level:'2500', step:'0.01', event_at:Date.now()});
  if (url.includes('api.binance.com/api/v3/klines')) {
    window.__historyRequests++;
    return send(Array.from({length:100}, (_, i) => {
      const base = Math.floor(Date.now() / 900000) * 900000;
      return [base - (99 - i) * 900000, '2500', '2540', '2460', String(2500 + Math.sin(i) * 20), '100'];
    }));
  }
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'candleSnapshot') {
      window.__historyRequests++;
      const req = body.req;
      window.__candleRequests.push({coin:req.coin, interval:req.interval, span: window.__now - req.startTime});
      // A freshly listed market answers with no candles at all.
      if (req.coin === 'SOL') return send([]);
      if (req.interval === '1h') {
        const hour = Math.floor(window.__now / 3600000) * 3600000;
        return send(Array.from({length:26}, (_, i) => {
          const back = 25 - i;
          return {t: hour - back * 3600000, o:'1', h:'1', l:'1', c: back === 24 ? '2400' : '2500', v:'1'};
        }));
      }
      if (req.interval === '1d') {
        const day = Math.floor(window.__now / 86400000) * 86400000;
        return send(Array.from({length:33}, (_, i) => {
          const back = 32 - i;
          return {t: day - back * 86400000, o:'1', h:'1', l:'1', c: back === 7 ? '2000' : back === 30 ? '1250' : '2500', v:'1'};
        }));
      }
      return send(window.__bars());
    }
    if (body.type === 'metaAndAssetCtxs') {
      window.__rankFetches = (window.__rankFetches || 0) + 1;
      const xyz = body.dex === 'xyz';
      const names = xyz ? ['xyz:SP500', 'xyz:GOLD', 'xyz:GONE', 'xyz:TSLA'] : ['BTC', 'ETH', 'SOL'];
      const volumes = {'xyz:SP500':'5e8', 'xyz:GOLD':'2e8', 'xyz:TSLA':'1e8', BTC:'9e8', ETH:'5e8', SOL:'2e8'};
      // xyz:GONE is in the live universe but has traded nothing in the window.
      return send([{universe:names.map((name) => ({name}))},
        names.map((name) => ({dayNtlVlm: volumes[name] || '0', markPx:'100', prevDayPx:'99'}))]);
    }
    return send([]);
  }
  return send([]);
};
'''
html = root.joinpath('index.html').read_text()
import re as _re
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

# ---------------------------------------------------------------- boot
wait_until("document.querySelector('#last-price').textContent !== '—'")
assert js("document.body.classList.contains('list-view')") is False
assert js("getComputedStyle(document.querySelector('#watchlist')).display") == 'none'
assert js("document.querySelectorAll('.favourite-chip').length") == 5
# The chart's own socket is untouched by the list feature.
assert js("window.__sockets.length") == 1
assert js("window.__sockets[0].url.includes('stream.binance.com')") is True
assert js("window.__watchSocket()") is None
# The view toggle is the header's leftmost control in both views, clear of the
# favourite chips and inside the viewport.
assert js("document.querySelector('.topbar').firstElementChild.id") == 'btn-view'
assert js("document.querySelector('#btn-view').getBoundingClientRect().x") < js("document.querySelector('.favourites').getBoundingClientRect().x")
assert js("document.querySelector('#btn-view').getBoundingClientRect().x") >= 0
print('PASS: boot leaves the chart view in place, opens no list socket, and the view toggle leads the header.')

# ---------------------------------------------------------------- open the list
js("document.querySelector('#btn-view').click()")
wait_until("!!window.__watchSocket()")
assert js("document.body.classList.contains('list-view')") is True
assert js("getComputedStyle(document.querySelector('#main-chart')).display") == 'none'
assert js("getComputedStyle(document.querySelector('#rsi-chart')).display") == 'none'
assert js("getComputedStyle(document.querySelector('.legend')).display") == 'none'
assert js("getComputedStyle(document.querySelector('.intervals')).display") == 'none'
assert js("getComputedStyle(document.querySelector('.indicators')).display") == 'none'
assert js("getComputedStyle(document.querySelector('.tools')).display") == 'none'
assert js("getComputedStyle(document.querySelector('.favourites')).display") == 'none'
assert js("getComputedStyle(document.querySelector('#watchlist')).display") == 'block'
assert js("document.querySelector('#btn-view').textContent") == '\U0001F4C8 Chart'
assert js("getComputedStyle(document.querySelector('#btn-view')).display") != 'none'
assert js("document.querySelector('.topbar').firstElementChild.id") == 'btn-view'
assert js("document.querySelector('#btn-view').getBoundingClientRect().x") < js("document.querySelector('#source-toggle').getBoundingClientRect().x")
assert json.loads(js("window.__ls['cc-settings-v1']"))['view'] == 'list'
# One subscription per live market, none for the Binance pin, in star order.
subs = json.loads(js("JSON.stringify(window.__watchSocket().sent.map(m => m.subscription.coin))"))
assert subs == ['ETH', 'SOL', 'xyz:SP500', 'xyz:GONE'], subs
rows = json.loads(js("JSON.stringify([...document.querySelectorAll('.quote-row')].map(r => r.dataset.symbol))"))
assert rows == ['BTC', 'ETH', 'SOL', 'xyz:SP500', 'xyz:GONE'], rows
print('PASS: list view hides chart-only chrome, streams one subscription per live favourite and skips the Binance pin.')

# ------------------------------------------------------- live figures
def candle_requests(coin=None):
    """History fetches the list made; the chart's own snapshots are not it."""
    reqs = [r for r in json.loads(js("JSON.stringify(window.__candleRequests)")) if r['interval'] in ('1h', '1d')]
    return [r for r in reqs if coin is None or r['coin'] == coin]


def row(symbol):
    return f"document.querySelector('.quote-row[data-symbol=\"{symbol}\"]')"

js("window.__push('ETH', 2457.0, 2447.28)")
js("window.__push('xyz:SP500', 7627.8, 7597.4)")
js("window.__push('BTC', 76736.7, 76188.0)")   # a pin with no feed cannot paint
wait_until(f"{row('ETH')}.querySelector('.quote-price').textContent === '2,457.00'")
assert js(f"{row('ETH')}.querySelector('.quote-change').textContent") == '+9.72 +0.40%'
assert js(f"{row('ETH')}.querySelector('.quote-change').className") == 'quote-change pos'
assert js(f"{row('xyz:SP500')}.querySelector('.quote-price').textContent") == '7,627.80'
assert js(f"{row('xyz:SP500')}.querySelector('.quote-change').textContent") == '+30.40 +0.40%'
assert js(f"{row('BTC')}.querySelector('.quote-price').textContent") == '—'
assert js(f"{row('BTC')}.classList.contains('unsupported')") is True
assert js(f"{row('BTC')}.querySelector('.quote-change').textContent") == 'no live feed here'
assert 'Live' in js("document.querySelector('.quote-status-text').textContent")
assert js("document.querySelector('.quote-status .live-dot').classList.contains('off')") is False
# A lower tick repaints, recolours and flashes.
js("window.__push('ETH', 2440.5, 2447.28)")
wait_until(f"{row('ETH')}.querySelector('.quote-price').textContent === '2,440.50'")
assert js(f"{row('ETH')}.querySelector('.quote-change').textContent") == '-6.78 -0.28%'
assert js(f"{row('ETH')}.querySelector('.quote-change').className") == 'quote-change neg'
assert js(f"{row('ETH')}.querySelector('.quote-price').getAnimations().length") >= 1
assert js("document.querySelector('.quote-rows').children[1] === " + row('ETH')) is True
js("window.__push('xyz:GOLD', 4350.02, 4341.84)")
js("window.__push('xyz:TSLA', 336.34, 330.1)")
wait_until(f"{row('xyz:GONE')}.querySelector('.quote-change').textContent === 'waiting for the venue'")
# A market that is not a favourite has no row and no figures here.
assert js("document.querySelectorAll('.quote-row').length") == 5
assert js("document.querySelector('.quote-row[data-symbol=\"xyz:GOLD\"]')") is None
# Rolling windows are the venue's own candle closes, re-percentaged against the
# live price: 1h bars for 24h, 1d bars for 7d and 1M. One fetch per window per
# market, none for the Binance pin.
requests = candle_requests()
asked = {}
for request in requests:
    asked.setdefault(request['coin'], []).append(request['interval'])
assert {coin: sorted(iv) for coin, iv in asked.items()} == {
    'ETH': ['1d', '1h'], 'SOL': ['1d', '1h'], 'xyz:SP500': ['1d', '1h'], 'xyz:GONE': ['1d', '1h']}, asked
assert all(23 * 3600000 <= r['span'] <= 26 * 3600000 for r in requests if r['interval'] == '1h'), requests
assert all(31 * 86400000 <= r['span'] <= 33 * 86400000 for r in requests if r['interval'] == '1d'), requests
wait_until(f"{row('ETH')}.querySelectorAll('.quote-window b.pos').length === 3")
windows = json.loads(js(f"JSON.stringify([...{row('ETH')}.querySelectorAll('.quote-window')].map(w => w.querySelector('i').textContent + w.querySelector('b').textContent))"))
# Against the 2,440.50 last pushed, and the fixture closes 2400 / 2000 / 1250.
assert windows == ['24h+1.69%', '7d+22.02%', '1M+95.24%'], windows
assert js(f"{row('BTC')}.querySelector('.quote-windows').hidden") is True
assert js(f"getComputedStyle({row('BTC')}.querySelector('.quote-windows')).display") == 'none'
assert js(f"getComputedStyle({row('ETH')}.querySelector('.quote-windows')).display") == 'flex'
# A market with no candle history shows no window rather than a guess.
assert js(f"{row('SOL')}.querySelectorAll('.quote-window b')[0].textContent") == '—'
assert js(f"{row('SOL')}.querySelector('.quote-price').textContent") == '—'
js("window.__push('SOL', 150.0, 148.0)")
wait_until(f"{row('SOL')}.querySelector('.quote-price').textContent === '150.00'")
assert js(f"{row('SOL')}.querySelectorAll('.quote-window b')[0].textContent") == '—'
# The windows follow the live price, not the fetch.
js("window.__push('ETH', 2400.0, 2447.28)")
wait_until(f"{row('ETH')}.querySelector('.quote-window b').textContent === '+0.00%'")
windows = json.loads(js(f"JSON.stringify([...{row('ETH')}.querySelectorAll('.quote-window b')].map(b => b.textContent))"))
assert windows == ['+0.00%', '+20.00%', '+92.00%'], windows
# A flat window is neither green nor red; the other two still are.
assert js(f"{row('ETH')}.querySelectorAll('.quote-window b.pos').length") == 2
assert js(f"{row('ETH')}.querySelector('.quote-window b').className") == ''
# Each window carries its own direction, so a mixed row reads correctly.
js("window.__push('ETH', 1900.0, 2447.28)")
wait_until(f"{row('ETH')}.querySelector('.quote-window b').textContent === '-20.83%'")
windows = json.loads(js(f"JSON.stringify([...{row('ETH')}.querySelectorAll('.quote-window b')].map(b => b.className + ' ' + b.textContent))"))
assert windows == ['neg -20.83%', 'neg -5.00%', 'pos +52.00%'], windows
print('PASS: pushes paint price and day change, colour direction, flash, and leave unsupported pins blank.')
print('PASS: rolling 24h/7d/1M windows come from one venue history fetch per market and track every tick.')
capture_screenshot('/tmp/candle-watchlist-mobile.png', max_dim=1200)

# ------------------------------------------------- a venue-rejected market
js("window.__reject('xyz:GONE')")
wait_until("document.querySelector('.quote-status-note').textContent === '1 not trading here'")
assert js(f"{row('xyz:GONE')}.querySelector('.quote-price').textContent") == '—'
assert js(f"{row('xyz:GONE')}.querySelector('.quote-change').textContent") == 'not trading on the venue'
assert js(f"{row('xyz:GONE')}.classList.contains('rejected')") is True
assert js(f"{row('ETH')}.classList.contains('rejected')") is False
print('PASS: a market the venue refuses is reported instead of showing nothing forever.')

# ------------------------------------------------------- row opens the chart
js("document.querySelector('.quote-row[data-symbol=\"xyz:SP500\"] .quote-main').click()")
wait_until("!document.body.classList.contains('list-view')")
assert js("document.querySelector('#symbol').value") == 'xyz:SP500'
assert js("window.__watchSocket()") is None, 'the list socket must close when the list does'
assert js("window.__sockets.filter(s => s.sent.some(m => m.subscription && m.subscription.type === 'activeAssetCtx')).every(s => s.readyState === 3)") is True
wait_until("document.querySelector('#legend').textContent.includes('SP500')")
assert 'Error' not in js("document.querySelector('#legend').textContent")
assert js("window.__rankFetches") >= 1
print('PASS: tapping a row charts that market, closes the list socket and leaves the chart rendering.')
capture_screenshot('/tmp/candle-watchlist-chart-return.png', max_dim=1200)

# ------------------------------------------------- reopening resumes cleanly
js("document.querySelector('#btn-view').click()")
wait_until("!!window.__watchSocket()")
assert js("window.__sockets.filter(s => s.readyState === 1).length") == 2, 'chart socket plus list socket'
assert js(f"{row('ETH')}.querySelector('.quote-price').textContent") == '—', 'stale figures must not survive a reopen'
js("window.__push('ETH', 2500.0, 2447.28)")
wait_until(f"{row('ETH')}.querySelector('.quote-price').textContent === '2,500.00'")
assert js(f"{row('xyz:SP500')}.classList.contains('active')") is True
assert js(f"{row('BTC')}.classList.contains('active')") is False
print('PASS: reopening the list re-subscribes, refuses to show stale numbers, and marks the charted market.')

# History is reused rather than re-fetched while it is fresh, and re-read from
# the venue once it is older than the reuse window.
assert len(candle_requests()) == 8, candle_requests()
js("Date.now = () => window.__now; void 0")
js("window.__now += 16 * 60 * 1000; void 0")
js("document.querySelector('#btn-view').click()")
wait_until("!document.body.classList.contains('list-view')")
js("document.querySelector('#btn-view').click()")
wait_until("!!window.__watchSocket()")
wait_until("window.__candleRequests.length >= 16")
assert len(candle_requests()) == 16, candle_requests()
js("Date.now = window.__realNow; void 0")
print('PASS: fresh window history is reused, and a stale list re-reads it from the venue.')

# -------------------------------------------- backgrounding pauses the feed
js("window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))")
wait_until("!!window.__watchSocket() === false")
assert js("window.__sockets.filter(s => s.readyState === 1).length") == 1, 'the chart socket stays up'
js("window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'))")
wait_until("!!window.__watchSocket()")
print('PASS: backgrounding drops the list socket and returning reconnects it.')

# ------------------------------------------- leave, switch market, return
js("document.querySelector('#btn-view').click()")
wait_until("!document.body.classList.contains('list-view')")
# The chip strip is chart-view chrome, so a market switch from the chart must
# leave the list's subscription set alone.
js("document.querySelector('.favourite-chip[data-symbol=\"ETH\"]').click()")
wait_until("document.querySelector('#symbol').value === 'ETH'")
js("document.querySelector('#btn-view').click()")
wait_until("!!window.__watchSocket()")
subs = json.loads(js("JSON.stringify(window.__watchSocket().sent.map(m => m.subscription.coin))"))
assert subs == ['ETH', 'SOL', 'xyz:SP500', 'xyz:GONE'], subs
assert js(f"{row('ETH')}.classList.contains('active')") is True
print('PASS: leaving through the header and returning via a favourite chip keeps the live subscription set.')

# --------------------------------------------------------- remove a row
js(f"{row('xyz:SP500')}.querySelector('.quote-star').click()")
wait_until(f"{row('xyz:SP500')} === null")
assert json.loads(js("JSON.stringify(JSON.parse(window.__ls['cc-settings-v1']).favourites.map(f => f.symbol))")) == ['BTC', 'ETH', 'SOL', 'xyz:GONE']
assert js("document.querySelectorAll('.quote-row').length") == 4
assert js("document.querySelectorAll('.favourite-chip').length") == 4
assert js("document.querySelector('#btn-favourite').getAttribute('aria-pressed')") == 'true'
print('PASS: the row star removes the pin from the list, the chip strip and storage together.')

# ------------------------------------------------------- socket retry path
js("window.__watchSocket().close()")
wait_until("document.querySelector('.quote-status-text').textContent === 'Connecting to the live feed…'")
wait_until("!!window.__watchSocket()", timeout=15)
print('PASS: a dropped feed reports itself and reconnects.')

# ------------------------------------------------------------ empty state
for _ in range(4):
    js("document.querySelector('.quote-star').click()")
wait_until("document.querySelectorAll('.quote-row').length === 0")
assert js("document.querySelector('.quote-empty').hidden") is False
assert js("document.querySelector('.quote-empty').textContent.includes('No favourites yet')") is True
assert js("document.querySelector('.quote-status-text').textContent") == 'No live feed for these markets'
assert js("window.__watchSocket()") is None
assert js("document.documentElement.scrollWidth <= innerWidth") is True
assert 'Error' not in js("document.querySelector('#legend').textContent")
print('PASS: an empty list explains itself, stops the feed and does not overflow the page.')

cdp('Emulation.clearDeviceMetricsOverride')
cdp('Emulation.setTouchEmulationEnabled', enabled=False)
finish_scope()
