# Run with: browser-harness < scripts/test-candle-alerts-ui.py
# Isolated in-memory fixture: no production API calls or Telegram messages.
begin_browser_task()
from pathlib import Path
import json
import time

root = Path('/home/lepton/agentchatbox/public/experiments/candle-charts')
tab = new_tab('about:blank')
cdp('Page.bringToFront')
cdp('Emulation.setDeviceMetricsOverride', width=412, height=860, deviceScaleFactor=1, mobile=True)
cdp('Emulation.setTouchEmulationEnabled', enabled=True, maxTouchPoints=1)
mock = r'''
window.__alerts = [];
window.__failSave = false;
window.__savedBodies = [];
window.__now = Date.now();
Date.now = () => window.__now;
window.__historyMode = 'fail';
window.__historyRequests = [];
window.__sockets = [];
// Drive only the chart watchdog deterministically; keep real browser frames
// and all other timers so the actual chart/gesture rendering is exercised.
const realSetInterval = window.setInterval, realClearInterval = window.clearInterval;
window.setInterval = (fn, ms, ...args) => {
  if (ms === 3000) { window.__watchdog = fn; return -1; }
  return realSetInterval(fn, ms, ...args);
};
window.clearInterval = (id) => {
  if (id === -1) { window.__watchdog = null; return; }
  realClearInterval(id);
};
window.__tick = async (ms) => { window.__now += ms; await window.__watchdog?.(); };
if (!crypto.randomUUID) crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(Math.floor(Math.random()*1e12)).padStart(12, '0');
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  constructor(url) { super(); this.url = url; this.readyState = 1; window.__sockets.push(this); }
  send() {}
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  let data;
  if (url.includes('/api/quote?')) {
    const q = new URL(url, 'https://test.invalid').searchParams;
    data = {price:'2500', level:Number(q.get('level') || 2500).toFixed(2), step:'0.01', event_at:Date.now()};
  } else if (url.includes('/api/alerts') && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/cancel')) {
      window.__alerts = window.__alerts.map(a => url.includes(a.id) ? {...a, status:'cancelled'} : a);
      data = {ok:true};
    } else {
      window.__savedBodies.push(body);
      if (window.__failSave) throw new TypeError('Offline');
      data = {...body, status:'active', created_at:Date.now(), expires_at:Date.now()+31536000000};
      if (!window.__alerts.some(a => a.id === body.id)) window.__alerts.push(data);
    }
  } else if (url.includes('/api/alerts') && opts.method === 'DELETE') {
    window.__alerts = window.__alerts.filter(a => !url.includes(a.id)); data={ok:true};
  } else if (url.includes('/api/alerts')) {
    data = {alerts:window.__alerts, feeds:[]};
  } else if (url.includes('/klines?')) {
    window.__historyRequests.push({url, at:Date.now()});
    if (window.__historyMode === 'fail') return new Response('{}', {status:503});
    if (window.__historyMode === 'timeout') throw new DOMException('Timed out', 'AbortError');
    if (window.__historyMode === 'empty') return new Response('[]', {status:200});
    const base = Math.floor(Date.now()/900000)*900000;
    data = Array.from({length:100}, (_,i) => [base-(99-i)*900000,2500+Math.sin(i)*20,2540,2460,2500+Math.cos(i)*20,100]);
    window.__lastBars = data;
    if (window.__historyMode === 'hold') {
      // Deliberately ignore cancellation: stale-response tokens must still
      // prevent this old market response from replacing a newer chart.
      return new Promise(resolve => { window.__releaseHistory = () => resolve(new Response(JSON.stringify(data), {status:200})); });
    }
  } else {
    data = [];
  }
  return new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
};
'''
html = root.joinpath('index.html').read_text()
import re
html = re.sub(r'<link rel="stylesheet"[^>]+>', '<style>' + root.joinpath('style.css').read_text() + '</style>', html)
html = re.sub(r'<script src="lwc[^>]+></script>', '', html)
html = re.sub(r'<script src="(?:alerts|watchlist|app)\.js[^>]+></script>', '', html)
html = html.replace('</body>', '<script>' + mock + '</script></body>')
frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
cdp('Page.setDocumentContent', frameId=frame, html=html)
# Keep each harness protocol message below its line-size ceiling.
for filename in ['lwc-4.0.1.js', 'alerts.js', 'watchlist.js', 'app.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset+18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')
    if filename == 'alerts.js':
        js('''(() => {
          const create = window.createCandleAlerts;
          window.createCandleAlerts = (options) => {
            window.__chart = options.chart; window.__series = options.series;
            return create(options);
          };
        })(); void 0''')

# Failed initial loads retry without any candles or socket. Check every
# backoff boundary, including the 30-second ceiling and an empty response.
wait_until("document.querySelector('#legend').textContent.includes('Retrying automatically')")
assert js('window.__historyRequests.length') == 1
for attempt, delay in enumerate([1000, 2000, 4000, 8000, 16000, 30000, 30000], start=2):
    mode = 'timeout' if attempt == 3 else 'empty' if attempt == 4 else 'fail'
    js('window.__historyMode = ' + json.dumps(mode))
    js('void window.__tick(' + str(delay - 1) + ')')
    assert js('window.__historyRequests.length') == attempt - 1
    js('void window.__tick(1)')
    wait_until('window.__historyRequests.length === ' + str(attempt) + " && document.querySelector('#legend').textContent.includes('Retrying automatically')")
    if mode == 'timeout':
        assert 'request timed out' in js("document.querySelector('#legend').textContent")
    if mode == 'empty':
        assert 'No candle data' in js("document.querySelector('#legend').textContent")
js("window.__historyMode='success'; void window.__tick(30000)")
wait_until("document.querySelector('#last-price').textContent !== '—' && window.__sockets.length === 1")
assert js('window.__historyRequests.length') == 9

# The countdown to the current candle's close lives in the bottom-right gutter
# of the main chart, clear of the time axis. It renders on its own wall-clock
# tick, so wait for the first one after the load.
countdown = """(() => {
  const el = document.querySelector('.candle-countdown');
  if (!el) return JSON.stringify({missing:true});
  const r = el.getBoundingClientRect(), m = document.querySelector('#main-chart').getBoundingClientRect();
  return JSON.stringify({hidden:el.hidden, text:el.textContent, right:r.right, bottom:r.bottom,
    mainRight:m.right, mainBottom:m.bottom});
})()"""
wait_until("(() => { const el = document.querySelector('.candle-countdown');"
           " return !!el && !el.hidden && /^15m closes in\\d+:\\d\\d$/.test(el.textContent); })()")
cd = json.loads(js(countdown))
assert cd.get('hidden') is False, cd
assert re.fullmatch(r'15m closes in\d+:\d\d', cd['text']), cd
assert cd['right'] <= cd['mainRight'] and cd['bottom'] <= cd['mainBottom'] - 20, cd
assert js("!!document.querySelector('#main-chart > .candle-countdown')") is True
print('PASS: candle-close countdown renders in the bottom-right gutter and tracks the 15m bar.')

# Explicit market changes reset backoff and cancel pending retries.
js("window.__historyMode='fail'; document.querySelector('#symbol').value='ETH'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until("window.__historyRequests.length === 10 && document.querySelector('#legend').textContent.includes('Retrying automatically')")
js('void window.__tick(999)')
assert js('window.__historyRequests.length') == 10
js("window.__historyMode='success'; void window.__tick(1)")
wait_until("document.querySelector('#legend').textContent.includes('ETHUSDT') && document.querySelector('#last-price').textContent !== '—'")
assert js('window.__historyRequests.length') == 11
js("window.__historyMode='fail'; document.querySelector('#symbol').value='SOL'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until("window.__historyRequests.length === 12 && document.querySelector('#legend').textContent.includes('Retrying automatically')")
js("window.__historyMode='success'; document.querySelector('#symbol').value='BTC'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until("window.__historyRequests.length === 13 && document.querySelector('#last-price').textContent !== '—'")
js('void window.__tick(1000)')
assert js('window.__historyRequests.length') == 13

# A superseded request cannot overwrite the latest symbol, even if it
# finishes after the replacement request and ignores its AbortSignal.
js("window.__historyMode='hold'; document.querySelector('#symbol').value='ETH'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until('typeof window.__releaseHistory === "function"')
js('void window.__tick(0)')
assert js('window.__historyRequests.length') == 14  # no duplicate while loading
js("window.__historyMode='success'; document.querySelector('#symbol').value='BTC'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until("document.querySelector('#last-price').textContent !== '—' && window.__sockets.at(-1).url.includes('btcusdt')")
js('window.__releaseHistory(); void 0')
wait_until("document.querySelector('#legend').textContent.includes('BTCUSDT') && !document.querySelector('#legend').textContent.includes('Loading')")
assert js('window.__historyRequests.length') == 15
print('PASS: initial failure, timeout and empty-history retries; exponential backoff capped at 30 seconds; recovery, market-switch reset, cancelled retry and stale-response isolation.')
capture_screenshot('/tmp/candle-alert-mobile-chart.png', max_dim=1200)
rect = js("JSON.stringify(document.querySelector('#main-chart').getBoundingClientRect().toJSON())")
rect = json.loads(rect)
x, y = 180, rect['top'] + rect['height'] * .5
# Real touch sequence drives the library's long-press tracking, not a synthetic
# call into the alert UI. The hold duration is the gesture being tested.
cdp('Input.dispatchTouchEvent', type='touchStart', touchPoints=[{'x':x,'y':y}])
time.sleep(.65)
cdp('Input.dispatchTouchEvent', type='touchMove', touchPoints=[{'x':x,'y':y-35}])
cdp('Input.dispatchTouchEvent', type='touchEnd', touchPoints=[])
wait_until("!document.querySelector('.alert-crosshair-plus').hidden")
chosen = js("document.querySelector('.alert-crosshair-plus').textContent")
assert chosen.startswith('+ '), chosen
# The chip stays compact: two decimals, not the raw 10-significant-digit level.
assert re.fullmatch(r'\+ \d+\.\d{2}', chosen), chosen
# A real socket candle changes autoscaling without a pointer move or resize.
# The selected price must stay fixed while BOTH overlays follow its new y.
js('window.__chosenPrice = ' + json.dumps(float(chosen[2:])))
old_y = js("parseFloat(document.querySelector('.alert-selected-line').style.top)")
js('''window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', {data:JSON.stringify({
  e:'kline', k:{t:window.__lastBars.at(-1)[0], o:'2500', h:'2700', l:'2460', c:'2600', v:'100'}
})})); void 0''')
wait_until("document.querySelector('#last-price').textContent === '2600.00'")
aligned = """(() => {
  const line = document.querySelector('.alert-selected-line'), plus = document.querySelector('.alert-crosshair-plus');
  const y = window.__series.priceToCoordinate(window.__chosenPrice);
  const h = plus.offsetHeight || 30;
  const buttonY = Math.max(0, Math.min(document.querySelector('#main-chart').clientHeight - h, y - h / 2));
  return !plus.hidden && Math.abs(parseFloat(line.style.top) - y) < .01 && Math.abs(parseFloat(plus.style.top) - buttonY) < .01;
})()"""
wait_until(aligned)
assert js("document.querySelector('.alert-crosshair-plus').textContent") == chosen
assert abs(js("parseFloat(document.querySelector('.alert-selected-line').style.top)") - old_y) > 1
# Programmatic price-scale changes have no pointer/resize event either.
js("window.__series.priceScale().applyOptions({scaleMargins:{top:.3,bottom:.3}}); void 0")
wait_until(aligned)
assert js("document.querySelector('.alert-crosshair-plus').textContent") == chosen
print('PASS: retained selection keeps its price and follows live autoscaling and programmatic price-scale changes.')
capture_screenshot('/tmp/candle-alert-mobile-selection.png', max_dim=1200)
plus_rect = json.loads(js("JSON.stringify(document.querySelector('.alert-crosshair-plus').getBoundingClientRect().toJSON())"))
px, py = plus_rect['x'] + plus_rect['width']/2, plus_rect['y'] + plus_rect['height']/2
cdp('Input.dispatchTouchEvent', type='touchStart', touchPoints=[{'x':px,'y':py}])
cdp('Input.dispatchTouchEvent', type='touchEnd', touchPoints=[])
wait_until("document.querySelector('#alert-dialog').open && !document.querySelector('#alert-create').disabled")
assert abs(float(js("document.querySelector('#alert-level').value")) - float(chosen[2:])) < .011
capture_screenshot('/tmp/candle-alert-mobile-create.png', max_dim=1200)
# Failed request never claims success; retry reuses its idempotency key.
js("window.__failSave=true; document.querySelector('#alert-create').click()")
wait_until("document.querySelector('#alert-error').textContent.includes('Could not reach')")
assert js("window.__alerts.length") == 0
js("window.__failSave=false; document.querySelector('#alert-create').click()")
wait_until("!document.querySelector('#alert-dialog').open && window.__alerts.length===1")
assert js("window.__savedBodies[0].id===window.__savedBodies[1].id") is True
js("document.querySelector('#btn-alerts').click()")
wait_until("document.querySelectorAll('.alert-card').length===1")
capture_screenshot('/tmp/candle-alert-mobile-list.png', max_dim=1200)
js("[...document.querySelectorAll('.alert-card button')].find(b=>b.textContent==='Cancel alert').click()")
wait_until("window.__alerts[0].status==='cancelled' && document.querySelectorAll('.alert-card').length===0")
assert js("document.documentElement.scrollWidth<=innerWidth") is True
print('PASS: Android-size real touch crosshair, retained selection, plus tap, editable confirmation, offline error, idempotent retry, list, cancellation; no page overflow.')
# A pending retry cannot outlive pagehide; a BFCache restore starts a fresh
# load for the current timeframe and restores the watchdog.
js("document.querySelector('#alerts-close').click(); window.__historyMode='fail'; document.querySelector('[data-iv=\"5m\"]').click()")
wait_until("document.querySelector('#legend').textContent.includes('Retrying automatically')")
requests_before_hide = js('window.__historyRequests.length')
js("window.dispatchEvent(new PageTransitionEvent('pagehide')); void window.__tick(30000)")
assert js('window.__watchdog === null') is True
assert js('window.__historyRequests.length') == requests_before_hide
js("window.__historyMode='success'; window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
wait_until("document.querySelector('#last-price').textContent !== '—' && typeof window.__watchdog === 'function'")
assert js('window.__historyRequests.length') == requests_before_hide + 1
assert 'interval=5m' in js('window.__historyRequests.at(-1).url')
print('PASS: pagehide stops retry polling and BFCache restore reloads the current timeframe.')
cdp('Emulation.clearDeviceMetricsOverride')
cdp('Emulation.setTouchEmulationEnabled', enabled=False)
finish_scope()
