// .github/scripts/fetch-candles.js
// Fetches XAU/USD candles + spot price + ForexFactory news
// Writes data/candles.json and data/usage.json

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const NINJA_KEY    = process.env.NINJA_KEY;
const GOLD_KEY     = process.env.GOLD_KEY;
const IS_MANUAL    = process.env.MANUAL_OVERRIDE === 'true';
const DATA_DIR     = path.join(process.cwd(), 'data');
const CANDLES_FILE = path.join(DATA_DIR, 'candles.json');
const USAGE_FILE   = path.join(DATA_DIR, 'usage.json');

// Budget caps
const NINJA_MONTHLY_LIMIT = 2700;
const NINJA_HARD_STOP     = 2900;
const NINJA_MIN_INTERVAL  = 145;   // seconds between scheduled calls
const GOLD_MONTHLY_LIMIT  = 90;
const GOLD_HARD_STOP      = 95;
const GOLD_MIN_INTERVAL   = 3900;  // 65 min
const FF_MIN_INTERVAL     = 3600;  // 60 min

function nowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function nowTs() { return Math.floor(Date.now() / 1000); }
function getMonth() { return new Date().toISOString().slice(0, 7); }

function isValidWindow() {
  if (IS_MANUAL) { console.log('[INFO] Manual override — skipping window check'); return true; }
  const et = nowET(), dow = et.getDay(), h = et.getHours();
  if (dow === 0 || dow === 6) { console.log('[SKIP] Weekend'); return false; }
  if (h < 8 || h >= 13)      { console.log(`[SKIP] Outside session ET hour: ${h}`); return false; }
  return true;
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode === 200
        ? resolve(d)
        : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function loadUsage() {
  try { if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); }
  catch(e) {}
  return { month: '', ninja: { count: 0, lastTs: 0 }, gold: { count: 0, lastTs: 0 }, ff: { lastTs: 0 }, history: [] };
}
function saveUsage(u) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}
function resetMonth(u) {
  const m = getMonth();
  if (u.month !== m) {
    console.log(`[INFO] New month ${m} — resetting counters`);
    u.month = m; u.ninja = { count: 0, lastTs: 0 }; u.gold = { count: 0, lastTs: 0 }; u.ff = { lastTs: 0 }; u.history = [];
  }
}

// ── AUTO-BIAS ─────────────────────────────────────────────
function detectBias(candles, label) {
  if (!candles || candles.length < 8) return { bias: 'Rng', reason: 'Not enough candles' };
  const last = candles[candles.length - 1];
  const hi = Math.max(...candles.map(c => c.h));
  const lo = Math.min(...candles.map(c => c.l));
  const eq = (hi + lo) / 2;

  const swHi = [], swLo = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.h > candles[i-1].h && c.h > candles[i-2].h && c.h > candles[i+1].h && c.h > candles[i+2].h) swHi.push(c.h);
    if (c.l < candles[i-1].l && c.l < candles[i-2].l && c.l < candles[i+1].l && c.l < candles[i+2].l) swLo.push(c.l);
  }

  let structBull = null;
  if (swHi.length >= 2 && swLo.length >= 2) {
    const h = swHi.slice(-2), l = swLo.slice(-2);
    if (h[1] > h[0] && l[1] > l[0]) structBull = true;
    else if (h[1] < h[0] && l[1] < l[0]) structBull = false;
  }

  const recent = candles.slice(-4);
  const bulls = recent.filter(c => c.c > c.o).length;
  const bears = recent.filter(c => c.c < c.o).length;
  const momBull = bulls >= 3 ? true : bears >= 3 ? false : null;
  const aboveEQ = last.c > eq;

  const bCount = [structBull === true,  momBull === true,  aboveEQ ].filter(Boolean).length;
  const dCount = [structBull === false, momBull === false, !aboveEQ].filter(Boolean).length;
  const reason = `struct:${structBull === null ? '?' : structBull ? 'HH/HL' : 'LH/LL'} mom:${momBull === null ? '?' : momBull ? 'bull' : 'bear'} EQ:${aboveEQ ? 'above' : 'below'}`;

  if (bCount >= 2) { console.log(`[BIAS] ${label}: Bull (${bCount}/3)`); return { bias: 'Bull', reason }; }
  if (dCount >= 2) { console.log(`[BIAS] ${label}: Bear (${dCount}/3)`); return { bias: 'Bear', reason }; }
  console.log(`[BIAS] ${label}: Rng`);
  return { bias: 'Rng', reason };
}

// ── FOREXFACTORY ──────────────────────────────────────────
async function fetchNews() {
  console.log('[FETCH] ForexFactory…');
  const raw    = await get('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  const events = JSON.parse(raw);
  const et     = nowET();
  const today  = et.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });

  const high = events.filter(e => {
    if (e.currency !== 'USD') return false;
    if ((e.impact || '').toLowerCase() !== 'high') return false;
    try {
      const d = new Date(e.date).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });
      return d === today;
    } catch(_) { return false; }
  });

  const result = high.map(e => {
    let timeET = '—';
    try { timeET = new Date(e.date).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }); } catch(_) {}
    return { id: `ff_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, name: e.title || 'USD Event', time: timeET, impact: 'high', auto: true };
  });
  console.log(`[OK]   FF: ${result.length} HIGH events today`);
  return result;
}

// ── API NINJA CANDLES ─────────────────────────────────────
async function fetchCandles(interval, limit) {
  const ts    = nowTs();
  const secs  = { '1h': 3600, '15m': 900, '1m': 60 }[interval] || 3600;
  const start = ts - secs * (limit + 5);
  // Correct endpoint confirmed: commoditypricehistorical with name=gold
  const url   = `https://api.api-ninjas.com/v1/commoditypricehistorical?name=gold&interval=${interval}&start=${start}&end=${ts}`;
  console.log(`[FETCH] Ninja ${interval}…`);
  const raw = await get(url, { 'X-Api-Key': NINJA_KEY });
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error(`Bad response: ${JSON.stringify(arr).slice(0, 100)}`);
  const candles = arr.reverse().slice(-limit).map(c => ({
    t: c.timestamp, o: parseFloat(c.open), h: parseFloat(c.high), l: parseFloat(c.low), c: parseFloat(c.close),
  }));
  console.log(`[OK]   Ninja ${interval}: ${candles.length} candles`);
  return candles;
}

// ── GOLDAPI SPOT ──────────────────────────────────────────
async function fetchSpot() {
  console.log('[FETCH] GoldAPI…');
  const d   = JSON.parse(await get('https://www.goldapi.io/api/XAU/USD', { 'x-access-token': GOLD_KEY }));
  const ask = parseFloat(d.ask || 0), bid = parseFloat(d.bid || 0);
  const spot = {
    price: parseFloat(d.price || d.ask || 0), ask, bid,
    high: parseFloat(d.high_price || 0), low: parseFloat(d.low_price || 0),
    open: parseFloat(d.open_price || 0), change: parseFloat(d.ch || 0), changePct: parseFloat(d.chp || 0),
    spread: +Math.max(0, ask - bid).toFixed(2) || 0.28,
    fetchedAtET: nowET().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
    derivedFromCandles: false,
  };
  console.log(`[OK]   GoldAPI: ${spot.price} spread:${spot.spread}`);
  return spot;
}

function deriveSpot(candles1m, prev) {
  if (!candles1m.length) return prev;
  const last = candles1m[candles1m.length - 1];
  return {
    ...(prev || {}), price: last.c,
    high: Math.max(...candles1m.map(c => c.h)), low: Math.min(...candles1m.map(c => c.l)),
    open: candles1m[0]?.o || last.c,
    change: +(last.c - (candles1m[0]?.o || last.c)).toFixed(2),
    changePct: candles1m[0]?.o ? +((last.c - candles1m[0].o) / candles1m[0].o * 100).toFixed(2) : 0,
    spread: prev?.spread || 0.28,
    fetchedAtET: nowET().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET (derived)',
    derivedFromCandles: true,
  };
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`[START] ${new Date().toISOString()}`);
  console.log(`[ET]    ${nowET().toLocaleString()}`);
  console.log(`[MODE]  ${IS_MANUAL ? 'MANUAL OVERRIDE' : 'Scheduled'}`);

  if (!isValidWindow()) process.exit(0);

  const usage = loadUsage();
  resetMonth(usage);
  const ts = nowTs();

  let existing = {};
  try { if (fs.existsSync(CANDLES_FILE)) existing = JSON.parse(fs.readFileSync(CANDLES_FILE, 'utf8')); } catch(e) {}

  let c1h  = existing.candles1h  || [];
  let c15m = existing.candles15m || [];
  let c1m  = existing.candles1m  || [];
  let spot = existing.spot || null;
  let news = (existing.news || []).filter(e => !e.auto);
  let ninjaUsed = 0, goldUsed = 0;

  // ── NINJA ──
  const ninjaElapsed = ts - (usage.ninja.lastTs || 0);
  if (usage.ninja.count >= NINJA_HARD_STOP) {
    console.log(`[SKIP] Ninja SUSPENDED ${usage.ninja.count}/${NINJA_HARD_STOP}`);
  } else if (!IS_MANUAL && ninjaElapsed < NINJA_MIN_INTERVAL) {
    console.log(`[SKIP] Ninja too soon: ${ninjaElapsed}s`);
  } else {
    try {
      c1h  = await fetchCandles('1h',  40); ninjaUsed++;
      c15m = await fetchCandles('15m', 40); ninjaUsed++;
      c1m  = await fetchCandles('1m',  60); ninjaUsed++;
      usage.ninja.lastTs = ts;
      usage.ninja.count += ninjaUsed;
    } catch(e) { console.error('[ERROR] Ninja:', e.message); }
  }

  // ── GOLDAPI ──
  const goldElapsed = ts - (usage.gold.lastTs || 0);
  if (usage.gold.count >= GOLD_HARD_STOP) {
    console.log(`[SKIP] GoldAPI SUSPENDED`);
    spot = deriveSpot(c1m, spot);
  } else if (!IS_MANUAL && goldElapsed < GOLD_MIN_INTERVAL) {
    console.log(`[SKIP] GoldAPI too soon: ${goldElapsed}s`);
    if (c1m.length) spot = deriveSpot(c1m, spot);
  } else {
    try {
      spot = await fetchSpot();
      usage.gold.lastTs = ts; usage.gold.count++; goldUsed = 1;
    } catch(e) {
      console.error('[ERROR] GoldAPI:', e.message);
      spot = deriveSpot(c1m, spot);
    }
  }

  // ── FOREXFACTORY ──
  const ffElapsed = ts - (usage.ff.lastTs || 0);
  if (!IS_MANUAL && ffElapsed < FF_MIN_INTERVAL) {
    console.log(`[SKIP] FF too soon: ${ffElapsed}s`);
    news = [...(existing.news || []).filter(e => e.auto), ...news];
  } else {
    try {
      const autoNews = await fetchNews();
      news = [...autoNews, ...news];
      usage.ff.lastTs = ts;
    } catch(e) {
      console.error('[ERROR] ForexFactory:', e.message);
      news = [...(existing.news || []).filter(e => e.auto), ...news];
    }
  }

  // ── BIAS ──
  const bias1h  = detectBias(c1h,  '1H');
  const bias15m = detectBias(c15m, '15M');

  // ── WRITE OUTPUT ──
  const out = {
    meta: {
      fetchedAt: new Date().toISOString(),
      fetchedAtET: spot?.fetchedAtET || nowET().toLocaleString() + ' ET',
      fetchedAtTs: ts, isManual: IS_MANUAL,
      ninja: { usage: usage.ninja.count, limit: NINJA_MONTHLY_LIMIT, hardStop: NINJA_HARD_STOP,
               pct: ((usage.ninja.count / NINJA_MONTHLY_LIMIT) * 100).toFixed(1) + '%',
               status: usage.ninja.count >= NINJA_HARD_STOP ? 'SUSPENDED' : usage.ninja.count >= NINJA_MONTHLY_LIMIT ? 'WARNING' : 'OK' },
      gold:  { usage: usage.gold.count,  limit: GOLD_MONTHLY_LIMIT,  hardStop: GOLD_HARD_STOP,
               pct: ((usage.gold.count  / GOLD_MONTHLY_LIMIT)  * 100).toFixed(1) + '%',
               status: usage.gold.count >= GOLD_HARD_STOP ? 'SUSPENDED' : 'OK' },
    },
    spot, candles1h: c1h, candles15m: c15m, candles1m: c1m,
    bias: {
      h1: bias1h.bias, h1Reason: bias1h.reason,
      m15: bias15m.bias, m15Reason: bias15m.reason,
      aligned: bias1h.bias !== 'Rng' && bias1h.bias === bias15m.bias,
      direction: (bias1h.bias === bias15m.bias && bias1h.bias !== 'Rng') ? bias1h.bias : 'Rng',
      detectedAt: new Date().toISOString(),
    },
    news,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CANDLES_FILE, JSON.stringify(out, null, 2));
  console.log(`[WRITE] candles.json — ${JSON.stringify(out).length} bytes`);

  usage.history.push({ ts, ninjaUsed, goldUsed, ninjaTot: usage.ninja.count, goldTot: usage.gold.count });
  if (usage.history.length > 500) usage.history = usage.history.slice(-500);
  saveUsage(usage);

  console.log(`\n[DONE]`);
  console.log(`  Ninja: ${usage.ninja.count}/${NINJA_MONTHLY_LIMIT}`);
  console.log(`  Gold:  ${usage.gold.count}/${GOLD_MONTHLY_LIMIT}`);
  console.log(`  Bias:  1H=${bias1h.bias} | 15M=${bias15m.bias} | Aligned=${out.bias.aligned}`);
  console.log(`  News:  ${news.length} events`);
  console.log('─'.repeat(50) + '\n');
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
