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
if (!crypto.randomUUID) crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(Math.floor(Math.random()*1e12)).padStart(12, '0');
window.WebSocket = class { addEventListener() {} close() {} };
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
    const base = Math.floor(Date.now()/900000)*900000;
    data = Array.from({length:100}, (_,i) => [base-(99-i)*900000,2500+Math.sin(i)*20,2540,2460,2500+Math.cos(i)*20,100]);
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
html = re.sub(r'<script src="(?:alerts|app)\.js[^>]+></script>', '', html)
html = html.replace('</body>', '<script>' + mock + '</script></body>')
frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
cdp('Page.setDocumentContent', frameId=frame, html=html)
# Keep each harness protocol message below its line-size ceiling.
for filename in ['lwc-4.0.1.js', 'alerts.js', 'app.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset+18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')
wait_until("document.querySelector('#legend').textContent.includes('BTCUSDT') && !document.querySelector('#legend').textContent.includes('Loading')")
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
cdp('Emulation.clearDeviceMetricsOverride')
cdp('Emulation.setTouchEmulationEnabled', enabled=False)
finish_scope()
