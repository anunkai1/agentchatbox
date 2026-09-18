# Run with: browser-harness < scripts/test-candle-charts-ranking-ui.py
# Isolated in-memory fixture: no production API calls. The Hyperliquid volume
# feed is mocked with more markets than the picker shows, so the cap, the
# volume ordering and the two keep rules are all observable.
begin_browser_task()
from pathlib import Path
import json
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
// P1..P40 trade with rising volume, so volume order is P40..P1. P41 is a real
// market with nothing traded in the window and is the tab's saved market. P42
// is delisted and must disappear from both the picker and the favourite chips.
window.__ls['cc-settings-v1'] = JSON.stringify({
  source:'hyperliquid', symbol:'P41', interval:'15m', symbolBySource:{hyperliquid:'P41'},
  favourites:[{source:'hyperliquid', symbol:'P40'}, {source:'hyperliquid', symbol:'P42'}],
  sortMode:'volume', view:'chart',
  indicators:{ema:true, rsi:true, vol:true, rsiLvls:true, rsiOB:70, rsiOS:30},
});
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
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
window.__bars = () => Array.from({length:100}, (_, i) => {
  const base = Math.floor(Date.now() / 900000) * 900000;
  return {t: base - (99 - i) * 900000, o:'2500', h:'2540', l:'2460', c:String(2500 + Math.sin(i) * 20), v:'100'};
});
window.__volumeFetches = 0;
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  const send = (data) => new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
  if (url.includes('/api/alerts')) return send({alerts:[], feeds:[]});
  if (url.includes('/api/quote?')) return send({price:'2500', level:'2500', step:'0.01', event_at:Date.now()});
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'candleSnapshot') return send(window.__bars());
    if (body.type === 'metaAndAssetCtxs') {
      window.__volumeFetches++;
      const names = [];
      for (let n = 1; n <= 42; n++) names.push('P' + n);
      return send([
        {universe: names.map((name) => ({name, isDelisted: name === 'P42'}))},
        names.map((name) => ({
          // P41 has no trades in the window, P42 is delisted but loud.
          dayNtlVlm: name === 'P41' ? '0' : name === 'P42' ? '500000000' : String(Number(name.slice(1)) * 1e6),
          markPx:'100', prevDayPx:'99',
        })),
      ]);
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

wait_until("window.__volumeFetches >= 1 && document.querySelector('#symbol').options.length > 1")
time.sleep(0.5)

options = json.loads(js("JSON.stringify([...document.querySelector('#symbol').options].map(o => o.value))"))
labels = json.loads(js("JSON.stringify([...document.querySelector('#symbol').options].map(o => o.textContent))"))

# TOP_N is 30, so exactly the thirty busiest markets, in volume order.
assert len(options) == 31, options
assert options[:30] == ['P' + str(n) for n in range(40, 10, -1)], options[:30]
assert js("document.querySelector('#symbol').value") == 'P41'
# The saved market is kept even though it has traded nothing in the window,
# because the feed's universe (not its volume map) decides what is real.
assert options[30] == 'P41', options
# A delisted market is in neither list, whatever volume it reports.
assert 'P42' not in options
assert labels[0] == 'P40 · 40.00M', labels[0]
assert labels[30] == 'P41', labels[30]
print('PASS: the picker lists the live top 30 by 24h volume, keeps the saved no-volume market and drops a delisted one.')

# The pruned pin loses its chip; the surviving pin keeps its volume label.
chips = json.loads(js("JSON.stringify([...document.querySelectorAll('.favourite-chip')].map(c => c.dataset.symbol))"))
assert chips == ['P40'], chips
assert 'Error' not in js("document.querySelector('#legend').textContent")
wait_until("document.querySelector('#legend').textContent.includes('P41')")
assert js("document.querySelector('#last-price').textContent") != '—'
print('PASS: a delisted pin is removed from favourites while the charted market keeps loading.')
capture_screenshot('/tmp/candle-ranking-picker.png', max_dim=1200)

# Selecting a market past the old cap charts it and keeps it in the picker.
js("document.querySelector('#symbol').value = 'P27'; document.querySelector('#symbol').dispatchEvent(new Event('change'))")
wait_until("document.querySelector('#legend').textContent.includes('P27')")
options = json.loads(js("JSON.stringify([...document.querySelector('#symbol').options].map(o => o.value))"))
assert 'P27' in options and len(options) == 31, options
assert js("document.querySelector('#btn-favourite').click(); void 0") is None
wait_until("document.querySelectorAll('.favourite-chip').length === 2")
print('PASS: a market inside the raised cap can be charted and starred straight from the picker.')

cdp('Emulation.clearDeviceMetricsOverride')
finish_scope()
