# Run with: browser-harness < scripts/test-candle-intervals-ui.py
# Isolated in-memory fixture: no production API calls. Both candle feeds are
# mocked so every interval can be followed from its button through the REST
# request, the live socket and the candle it draws.
#
# 3M/6M/12M are not feed intervals: the chart folds the feed's weekly series
# onto calendar boundaries. The weekly fixture is exposed as window.__weeks, so
# the expected bars are folded here in Python from the same input the page got.
begin_browser_task()
from pathlib import Path
import calendar
import datetime
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
const STEP = {'1m':60000, '5m':300000, '15m':900000, '30m':1800000, '1h':3600000, '2h':7200000, '1w':604800000};
// Intraday bars are epoch milliseconds, the shape both feeds answer with (the
// Hyperliquid reader divides by 1000 and the Binance reader does too).
const bars = (interval, count) => {
  const step = STEP[interval], base = Math.floor(Date.now() / step) * step;
  return Array.from({length: count}, (_, i) => ({
    t: base - (count - 1 - i) * step, o:'2500', h:'2540', l:'2460',
    c:String(2500 + Math.sin(i) * 20), v:'100',
  }));
};
// The weekly series behind a fold: 300 weeks, each with an unmistakable OHLCV,
// so the fold's open/high/low/close/volume sums can be recomputed and checked
// from outside the page.
const WEEK = 604800000, weekEnd = Math.floor(Date.now() / WEEK) * WEEK;
window.__weeks = Array.from({length: 300}, (_, i) => ({
  t: weekEnd - (299 - i) * WEEK, o: String(100 + i), h: String(105 + i),
  l: String(95 + i), c: String(101 + i), v: String(10 + i),
}));
window.__weekRows = (interval, limit) => window.__weeks.slice(-Number(limit)).map((w) => ({
  t: w.t, o: w.o, h: w.h, l: w.l, c: w.c, v: w.v,
}));
// Push a weekly bar down the live stream, in the shape of the open feed.
window.__tickBinanceWeek = (week) => {
  for (const ws of window.__sockets) {
    if (ws.readyState !== 1) continue;
    ws.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
      e:'kline', k:{t: week.t, o: week.o, h: week.h, l: week.l, c: week.c, v: week.v},
    })}));
  }
};
window.__tickHlWeek = (week) => {
  for (const ws of window.__sockets) {
    if (ws.readyState !== 1 || !ws.url.includes('api.hyperliquid.xyz')) continue;
    ws.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
      channel:'candle', data:{t: week.t, o: week.o, h: week.h, l: week.l, c: week.c, v: week.v},
    })}));
  }
};
window.fetch = async (raw, opts = {}) => {
  const url = String(raw);
  const send = (data) => new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
  if (url.includes('/api/alerts') || url.includes('/api/quote')) {
    return send({alerts:[], feeds:[], price:'2500', level:'2500', step:'0.01', event_at:Date.now()});
  }
  if (url.includes('api.binance.com')) {
    const q = new URL(url).searchParams, interval = q.get('interval'), limit = Number(q.get('limit'));
    window.__klineRequests.push({interval, symbol:q.get('symbol'), limit:q.get('limit')});
    if (interval === '1w') {
      // Binance klines row: [openTime, o, h, l, c, volume, closeTime, ...]
      return send(window.__weekRows(interval, limit).map(w => [w.t, w.o, w.h, w.l, w.c, w.v,
        w.t + WEEK - 1, '1', 1, '1', '1', '0']));
    }
    return send(bars(interval, Math.min(limit, 500)).map(b => [b.t, b.o, b.h, b.l, b.c, b.v,
      b.t + STEP[interval] - 1, '1', 1, '1', '1', '0']));
  }
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'candleSnapshot') {
      window.__snapshots.push({interval: body.req.interval, coin: body.req.coin});
      if (body.req.interval === '1w') {
        const span = body.req.endTime - body.req.startTime;
        const limit = Math.max(1, Math.min(1000, Math.round(span / WEEK)));
        return send(window.__weekRows('1w', limit));
      }
      return send(bars(body.req.interval, 120).map(b => ({...b, i: body.req.interval, s: body.req.coin})));
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
for filename in ['lwc-4.0.1.js', 'alerts.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset + 18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')
# The alert UI is handed the candle series, which is the cheapest way to see the
# bars the chart was actually given (setData) and told about (update).
js('''(() => {
  const create = window.createCandleAlerts;
  window.createCandleAlerts = (options) => {
    const series = options.series;
    window.__seriesData = []; window.__seriesUpdates = [];
    const setData = series.setData.bind(series), update = series.update.bind(series);
    series.setData = (d) => { window.__seriesData = d; return setData(d); };
    series.update = (b) => { window.__seriesUpdates.push(b); return update(b); };
    return create(options);
  };
})(); void 0''')
for filename in ['watchlist.js', 'app.js']:
    source = root.joinpath(filename).read_text()
    js("window.__fixtureScript = ''")
    for offset in range(0, len(source), 18000):
        js('window.__fixtureScript += ' + json.dumps(source[offset:offset + 18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')


def series():
    """The candle series the chart was last handed, as the chart holds it."""
    return json.loads(js("""JSON.stringify(window.__seriesData.map(
      (b) => ({time:b.time, open:b.open, high:b.high, low:b.low, close:b.close, volume:b.volume})))"""))


def weeks():
    return json.loads(js("JSON.stringify(window.__weeks)"))


def bucket_start(sec, span):
    d = datetime.datetime.fromtimestamp(sec, datetime.UTC)
    month = (d.month - 1) // span * span
    return calendar.timegm(datetime.datetime(d.year, month + 1, 1, tzinfo=datetime.UTC).timetuple())


def fold(raw, span):
    """The page's fold: calendar buckets, oldest (cut-short) bucket dropped."""
    out = []
    for w in raw:
        t = bucket_start(w['t'] // 1000, span)
        if out and out[-1]['time'] == t:
            bar = out[-1]
            bar['high'] = max(bar['high'], float(w['h']))
            bar['low'] = min(bar['low'], float(w['l']))
            bar['close'] = float(w['c'])
            bar['volume'] += float(w['v'])
        else:
            out.append({'time': t, 'open': float(w['o']), 'high': float(w['h']),
                        'low': float(w['l']), 'close': float(w['c']), 'volume': float(w['v'])})
    return out[1:] if len(out) > 1 else out


def click_interval(iv):
    js("document.querySelector('#intervals button[data-iv=\"%s\"]').click(); void 0" % iv)


def wait_for_interval(iv):
    wait_until("document.querySelector('.legend').textContent.includes('· %s ·')" % iv)
    wait_until("window.__seriesData.length > 1")


def check_folded(chart_bars, span, label):
    expected = fold(weeks(), span)
    assert len(chart_bars) == len(expected), (label, len(chart_bars), len(expected))
    for got, want in zip(chart_bars, expected):
        assert got['time'] == want['time'], (label, got, want)
        assert got['time'] == bucket_start(got['time'], span), (label, 'bucket not on a boundary', got['time'])
        for field in ('open', 'high', 'low', 'close'):
            assert abs(got[field] - want[field]) < 1e-9, (label, field, got, want)
        assert abs(got['volume'] - want['volume']) < 1e-6, (label, 'volume', got, want)
    print(f'PASS: {label} draws {len(chart_bars)} calendar-aligned bars, matching the fold '
          f'of the weekly series ({span} months each), with the request\'s cut-short oldest bucket dropped.')


# The interval row carries every interval, in ascending order.
buttons = json.loads(js("JSON.stringify([...document.querySelectorAll('#intervals button')].map(b => b.dataset.iv))"))
assert buttons == ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w', '1M', '3M', '6M', '12M'], buttons
print('PASS: the interval row offers 1m to 12M, including 2h, 3M, 6M and 12M, in ascending order.')

# The saved 15m market loads first, with no other interval on the wire.
wait_until("window.__klineRequests.length >= 1 && document.querySelector('#last-price').textContent !== '—'")
assert js("window.__klineRequests.map(r => r.interval).join(',')") == '15m'

# 30m, then 2h: both are feed intervals, so each re-requests history and
# re-subscribes the live socket to its own stream.
for iv, ws_suffix in (('30m', '@kline_30m'), ('2h', '@kline_2h')):
    before = int(js("window.__klineRequests.length"))
    click_interval(iv)
    wait_until("window.__klineRequests.length > " + str(before)
               + " && window.__sockets.some(s => s.url.includes('" + ws_suffix + "'))")
    last = json.loads(js("JSON.stringify(window.__klineRequests[window.__klineRequests.length - 1])"))
    assert last['interval'] == iv and last['symbol'] == 'BTCUSDT' and last['limit'] == '500', last
    assert js("JSON.stringify(window.__sockets[window.__sockets.length - 1].url)") == '"wss://stream.binance.com/ws/btcusdt' + ws_suffix + '"'
    assert js("document.querySelector('#intervals button.active').dataset.iv") == iv
    wait_until("(() => { const el = document.querySelector('.candle-countdown');"
               " return !!el && !el.hidden && /^" + iv + " closes in[\\d:]+$/.test(el.textContent); })()")
print('PASS: 30m and 2h each re-fetch history and re-subscribe the live kline stream, and their countdowns track the bar.')

# 3M: the feed is asked for its weekly series, not a 3M candle, and the chart is
# drawn from the fold of it. The live subscription follows the same base.
click_interval('3M')
wait_until("window.__klineRequests.some(r => r.interval === '1w') && window.__seriesData.length > 1")
request = json.loads(js("JSON.stringify(window.__klineRequests[window.__klineRequests.length - 1])"))
assert request['interval'] == '1w' and request['limit'] == '1000', request
assert js("window.__snapshots.length") == 0  # still on Binance Spot
assert js("JSON.stringify(window.__sockets[window.__sockets.length - 1].url)") == '"wss://stream.binance.com/ws/btcusdt@kline_1w"'
check_folded(series(), 3, '3M')
wait_until("(() => { const el = document.querySelector('.candle-countdown');"
           " return !!el && !el.hidden && /^3M closes in\\d+d$/.test(el.textContent); })()")
print('PASS: the 3M countdown reads in whole days, so the badge stays inside the price-scale column.')

# A live weekly bar folds with the weeks already behind the open bucket: the
# chart's newest candle, timed at the bucket boundary, is replaced by the whole
# bucket re-folded around it rather than by a bar standing on its own.
current = fold(weeks(), 3)[-1]
seeded = [w for w in weeks() if bucket_start(w['t'] // 1000, 3) == current['time']]
tick = {'t': seeded[-1]['t'] + 3 * 86400000, 'o': '999', 'h': '1200', 'l': '900', 'c': '1100', 'v': '77'}
expected = fold(seeded + [tick], 3)[-1]
js("window.__seriesUpdates.length = 0")
js("window.__tickBinanceWeek(" + json.dumps(tick) + "); void 0")
wait_until("window.__seriesUpdates.length > 0")
update = json.loads(js("JSON.stringify(window.__seriesUpdates[window.__seriesUpdates.length - 1])"))
for field in ('time', 'open', 'high', 'low', 'close'):
    assert update[field] == expected[field], (field, update, expected)
assert abs(update['volume'] - expected['volume']) < 1e-6, (update, expected)
assert update['volume'] != float(tick['v']), update
print('PASS: a live weekly bar re-folds into the open 3M bucket instead of standing in for it.')

# A replay of an older week belongs to a bar the bucket has already folded in,
# so it must not overwrite the newest week and unsum its volume.
stale = dict(tick, t=seeded[0]['t'], o='1', h='9999', l='0', c='2', v='1')
js("window.__seriesUpdates.length = 0")
js("window.__tickBinanceWeek(" + json.dumps(stale) + "); void 0")
wait_until("window.__seriesUpdates.length > 0")
replay = json.loads(js("JSON.stringify(window.__seriesUpdates[window.__seriesUpdates.length - 1])"))
assert replay['high'] == expected['high'] and replay['low'] == expected['low'] and replay['close'] == expected['close'], replay
assert abs(replay['volume'] - expected['volume']) < 1e-6, (replay, expected)
print('PASS: a replayed older week leaves the open 3M bucket alone.')

# Hyperliquid serves the same three intervals off its own weekly series.
js("document.querySelector('#source-toggle button[data-source=\"hyperliquid\"]').click(); void 0")
wait_until("window.__snapshots.some(s => s.interval === '1w') && window.__seriesData.length > 1")
subs = json.loads(js("""JSON.stringify(window.__sockets.filter(s => s.url.includes('api.hyperliquid.xyz'))
  .flatMap(s => s.sent.filter(m => m.subscription).map(m => m.subscription)))"""))
assert subs and subs[-1]['interval'] == '1w' and subs[-1]['type'] == 'candle' and subs[-1]['coin'] == 'BTC', subs
assert 'Error' not in js("document.querySelector('#legend').textContent")
check_folded(series(), 3, '3M on Hyperliquid')

# 6M and 12M are the same fold at a wider span.
for iv, span in (('6M', 6), ('12M', 12)):
    click_interval(iv)
    wait_for_interval(iv)
    bars_now = series()
    check_folded(bars_now, span, iv)
    for bar in bars_now:
        d = datetime.datetime.fromtimestamp(bar['time'], datetime.UTC)
        assert d.day == 1 and (d.month - 1) % span == 0, (iv, bar['time'])
        assert d.hour == 0 and d.minute == 0 and d.second == 0, (iv, bar['time'])
    saved = json.loads(js("JSON.stringify(JSON.parse(window.__ls['cc-settings-v1']).interval)"))
    assert saved == iv, saved
    wait_until("(() => { const el = document.querySelector('.candle-countdown');"
               " return !!el && !el.hidden && /^" + iv + " closes in\\d+d$/.test(el.textContent); })()")

capture_screenshot('/tmp/candle-12m.png', max_dim=1200)
cdp('Emulation.clearDeviceMetricsOverride')
finish_scope()
