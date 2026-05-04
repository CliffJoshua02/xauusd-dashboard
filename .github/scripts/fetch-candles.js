// .github/scripts/fetch-candles.js
//
// What this script does every time GitHub Actions fires it (every 5 min):
//   1. Checks if we're in the ET trading window (Mon–Fri 8AM–1PM ET)
//   2. Checks rate limits for both APIs independently
//   3. Fetches candles from API Ninjas (every 150s — ~2,500 calls/month)
//   4. Fetches spot price from GoldAPI (every 65min — ~105 calls/month, capped at 90)
//   5. Fetches news from ForexFactory JSON (every 60min, free, no key needed)
//   6. Auto-calculates 1H + 15M bias from candle structure
//   7. Writes everything to data/candles.json
//
// The website reads data/candles.json — it never calls any API directly.

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const NINJA_KEY    = process.env.NINJA_KEY;
const GOLD_KEY     = process.env.GOLD_KEY;
const DATA_DIR     = path.join(process.cwd(), 'data');
const CANDLES_FILE = path.join(DATA_DIR, 'candles.json');
const USAGE_FILE   = path.join(DATA_DIR, 'usage.json');

// API Ninja: 3,000/month budget → use 2,700 (hard stop 2,900)
const NINJA_MONTHLY_LIMIT = 2700;
const NINJA_HARD_STOP     = 2900;
const NINJA_MIN_INTERVAL  = 145;

// GoldAPI.io: 100/month free → use max 90 (hard stop 95)
// 90 calls / 21 trading days = ~4.3/day. At 5h session that's one call every 70min.
// We set 65min minimum to stay well within budget.
const GOLD_MONTHLY_LIMIT  = 90;
const GOLD_HARD_STOP      = 95;
const GOLD_MIN_INTERVAL   = 3900; // 65 minutes

// ForexFactory: free, no key — once per hour max
const FF_MIN_INTERVAL = 3600;

function nowET() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(s);
}
function nowTs() { return Math.floor(Date.now() / 1000); }
function getCurrentMonth() { return new Date().toISOString().slice(0, 7); }

function isValidTradingWindow() {
  // When triggered manually from the website, skip the window guard
  if (process.env.MANUAL_OVERRIDE === 'true') {
    console.log('[INFO] MANUAL_OVERRIDE=true — skipping trading window guard');
    return true;
  }
  const et = nowET();
  const dow = et.getDay(), h = et.getHours();
  if (dow === 0 || dow === 6) { console.log(`[SKIP] Weekend`); return false; }
  if (h < 8 || h >= 13)      { console.log(`[SKIP] Outside session (ET hour: ${h})`); return false; }
  return true;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'Content-Type': 'application/json', ...headers },
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
  try {
    if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch(e) {}
  return { month: '', ninja: { count: 0, lastTs: 0 }, gold: { count: 0, lastTs: 0 }, ff: { lastTs: 0 }, history: [] };
}
function saveUsage(u) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}
function resetIfNewMonth(usage) {
  const m = getCurrentMonth();
  if (usage.month !== m) {
    console.log(`[INFO] New month ${m} — resetting counters (was ${usage.month})`);
    usage.month = m;
    usage.ninja = { count: 0, lastTs: 0 };
    usage.gold  = { count: 0, lastTs: 0 };
    usage.ff    = { lastTs: 0 };
    usage.history = [];
  }
}

// ── AUTO-BIAS FROM CANDLE STRUCTURE ─────────────────────────
function detectBias(candles, label) {
  if (!candles || candles.length < 8) return { bias: 'Rng', reason: 'Not enough data' };

  const last  = candles[candles.length - 1];
  const price = last.c;
  const hi    = Math.max(...candles.map(c => c.h));
  const lo    = Math.min(...candles.map(c => c.l));
  const eq    = (hi + lo) / 2;

  // Swing structure detection (need 2 candles buffer each side)
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.h > candles[i-1].h && c.h > candles[i-2].h &&
        c.h > candles[i+1].h && c.h > candles[i+2].h) swingHighs.push(c.h);
    if (c.l < candles[i-1].l && c.l < candles[i-2].l &&
        c.l < candles[i+1].l && c.l < candles[i+2].l) swingLows.push(c.l);
  }

  // HH/HL = bullish, LH/LL = bearish
  let structureBull = null;
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs.slice(-2), hl = swingLows.slice(-2);
    if (hh[1] > hh[0] && hl[1] > hl[0])      structureBull = true;
    else if (hh[1] < hh[0] && hl[1] < hl[0]) structureBull = false;
  }

  // Momentum: last 4 candles direction
  const recent = candles.slice(-4);
  const bulls  = recent.filter(c => c.c > c.o).length;
  const bears  = recent.filter(c => c.c < c.o).length;
  const momentumBull = bulls >= 3 ? true : bears >= 3 ? false : null;

  // Price vs EQ
  const aboveEQ = price > eq;

  const bullCount = [structureBull === true,  momentumBull === true,  aboveEQ ].filter(Boolean).length;
  const bearCount = [structureBull === false, momentumBull === false, !aboveEQ].filter(Boolean).length;

  const reason = `struct:${structureBull===null?'?':structureBull?'HH/HL':'LH/LL'} mom:${momentumBull===null?'?':momentumBull?'bull':'bear'} EQ:${aboveEQ?'above':'below'}`;

  if (bullCount >= 2) { console.log(`[BIAS] ${label}: Bull (${bullCount}/3) — ${reason}`); return { bias: 'Bull', reason }; }
  if (bearCount >= 2) { console.log(`[BIAS] ${label}: Bear (${bearCount}/3) — ${reason}`); return { bias: 'Bear', reason }; }
  console.log(`[BIAS] ${label}: Ranging (mixed) — ${reason}`);
  return { bias: 'Rng', reason };
}

// ── FOREXFACTORY NEWS ────────────────────────────────────────
async function fetchForexFactoryNews() {
  console.log('[FETCH] ForexFactory news…');
  // ForexFactory publishes a free JSON calendar for current week
  const raw    = await httpGet('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  const events = JSON.parse(raw);

  const et       = nowET();
  const todayET  = et.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric',
  });

  const high = events.filter(e => {
    if (e.currency !== 'USD') return false;
    if ((e.impact || '').toLowerCase() !== 'high') return false;
    // Parse date and check if it's today in ET
    try {
      const evStr = new Date(e.date).toLocaleDateString('en-US', {
        timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric',
      });
      return evStr === todayET;
    } catch(_) { return false; }
  });

  const result = high.map(e => {
    let timeET = '—';
    try {
      timeET = new Date(e.date).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
      });
    } catch(_) {}
    return {
      id:     `ff_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      name:   e.title || e.name || 'USD Event',
      time:   timeET,
      impact: 'high',
      auto:   true,
    };
  });

  console.log(`[OK]   ForexFactory: ${result.length} HIGH USD events today`);
  result.forEach(e => console.log(`       → ${e.name} at ${e.time} ET`));
  return result;
}

// ── API NINJA CANDLES ────────────────────────────────────────
async function fetchCandleInterval(interval, limit) {
  const ts    = nowTs();
  const secs  = { '1h': 3600, '15m': 900, '1m': 60 }[interval] || 3600;
  const start = ts - secs * (limit + 5);
  const url   = `https://api.api-ninjas.com/v1/goldpricehistorical?commodity=gold&interval=${interval}&start=${start}&end=${ts}`;
  console.log(`[FETCH] Ninja ${interval}…`);
  const raw = await httpGet(url, { 'X-Api-Key': NINJA_KEY });
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error(`Bad Ninja response for ${interval}`);
  const candles = arr.reverse().slice(-limit).map(c => ({
    t: c.timestamp,
    o: parseFloat(c.open), h: parseFloat(c.high),
    l: parseFloat(c.low),  c: parseFloat(c.close),
  }));
  console.log(`[OK]   Ninja ${interval}: ${candles.length} candles`);
  return candles;
}

// ── GOLDAPI SPOT ─────────────────────────────────────────────
async function fetchSpotPrice() {
  console.log('[FETCH] GoldAPI spot…');
  const raw = await httpGet('https://www.goldapi.io/api/XAU/USD', { 'x-access-token': GOLD_KEY });
  const d   = JSON.parse(raw);
  const ask = parseFloat(d.ask || 0), bid = parseFloat(d.bid || 0);
  const spot = {
    price:      parseFloat(d.price || d.ask || 0),
    ask, bid,
    high:       parseFloat(d.high_price || 0),
    low:        parseFloat(d.low_price  || 0),
    open:       parseFloat(d.open_price || 0),
    change:     parseFloat(d.ch  || 0),
    changePct:  parseFloat(d.chp || 0),
    spread:     +Math.max(0, ask - bid).toFixed(2) || 0.28,
    fetchedAtET: nowET().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
    derivedFromCandles: false,
  };
  console.log(`[OK]   GoldAPI: ${spot.price} spread:${spot.spread}`);
  return spot;
}

// ── DERIVE SPOT FROM CANDLES (GoldAPI fallback) ──────────────
function deriveSpotFromCandles(candles1m, prevSpot) {
  if (!candles1m.length) return prevSpot;
  const last = candles1m[candles1m.length - 1];
  return {
    ...(prevSpot || {}),
    price:   last.c,
    high:    Math.max(...candles1m.map(c => c.h)),
    low:     Math.min(...candles1m.map(c => c.l)),
    open:    candles1m[0]?.o || last.c,
    change:  +(last.c - (candles1m[0]?.o || last.c)).toFixed(2),
    changePct: candles1m[0]?.o
      ? +((last.c - candles1m[0].o) / candles1m[0].o * 100).toFixed(2) : 0,
    spread:  0.28,
    fetchedAtET: nowET().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET (derived)',
    derivedFromCandles: true,
  };
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[START] ${new Date().toISOString()}`);
  console.log(`[ET]    ${nowET().toLocaleString('en-US', { timeZone: 'America/New_York' })}`);

  if (!isValidTradingWindow()) process.exit(0);

  const usage = loadUsage();
  resetIfNewMonth(usage);
  const ts = nowTs();

  // Load existing cache for fallback on partial failures
  let existing = {};
  try { if (fs.existsSync(CANDLES_FILE)) existing = JSON.parse(fs.readFileSync(CANDLES_FILE, 'utf8')); } catch(e) {}

  let candles1h  = existing.candles1h  || [];
  let candles15m = existing.candles15m || [];
  let candles1m  = existing.candles1m  || [];
  let spot       = existing.spot       || null;
  let newsEvents = (existing.news || []).filter(e => !e.auto); // keep manual, replace auto
  let ninjaThis  = 0, goldThis = 0;

  // ── API NINJA ───────────────────────────────────────────
  const ninjaElapsed = ts - (usage.ninja.lastTs || 0);
  const isManual     = process.env.MANUAL_OVERRIDE === 'true';
  if (usage.ninja.count >= NINJA_HARD_STOP) {
    console.log(`[SKIP] Ninja SUSPENDED — ${usage.ninja.count}/${NINJA_HARD_STOP}`);
  } else if (!isManual && ninjaElapsed < NINJA_MIN_INTERVAL) {
    console.log(`[SKIP] Ninja: ${ninjaElapsed}s ago (min ${NINJA_MIN_INTERVAL}s)`);
  } else {
    try {
      candles1h  = await fetchCandleInterval('1h',  40); ninjaThis++;
      candles15m = await fetchCandleInterval('15m', 40); ninjaThis++;
      candles1m  = await fetchCandleInterval('1m',  60); ninjaThis++;
      usage.ninja.lastTs = ts;
      usage.ninja.count += ninjaThis;
    } catch(e) { console.error('[ERROR] Ninja:', e.message); }
  }

  // ── GOLDAPI ────────────────────────────────────────────
  const goldElapsed = ts - (usage.gold.lastTs || 0);
  if (usage.gold.count >= GOLD_HARD_STOP) {
    console.log(`[SKIP] GoldAPI SUSPENDED — ${usage.gold.count}/${GOLD_HARD_STOP}`);
    spot = deriveSpotFromCandles(candles1m, spot);
  } else if (!isManual && goldElapsed < GOLD_MIN_INTERVAL) {
    console.log(`[SKIP] GoldAPI: ${goldElapsed}s ago (min ${GOLD_MIN_INTERVAL}s). Deriving from candles.`);
    // Update price from fresh candle close even when not calling GoldAPI
    if (candles1m.length) spot = deriveSpotFromCandles(candles1m, spot);
  } else {
    try {
      spot = await fetchSpotPrice();
      usage.gold.lastTs = ts;
      usage.gold.count += 1;
      goldThis = 1;
    } catch(e) {
      console.error('[ERROR] GoldAPI:', e.message);
      spot = deriveSpotFromCandles(candles1m, spot);
    }
  }

  // ── FOREXFACTORY ───────────────────────────────────────
  const ffElapsed = ts - (usage.ff.lastTs || 0);
  if (ffElapsed < FF_MIN_INTERVAL) {
    console.log(`[SKIP] FF news: ${ffElapsed}s ago. Using cached.`);
    // Keep auto news from previous cache
    const prevAuto = (existing.news || []).filter(e => e.auto);
    newsEvents = [...prevAuto, ...newsEvents];
  } else {
    try {
      const autoNews = await fetchForexFactoryNews();
      newsEvents = [...autoNews, ...newsEvents]; // auto first
      usage.ff.lastTs = ts;
    } catch(e) {
      console.error('[ERROR] ForexFactory:', e.message);
      const prevAuto = (existing.news || []).filter(e => e.auto);
      newsEvents = [...prevAuto, ...newsEvents];
    }
  }

  // ── AUTO-BIAS ──────────────────────────────────────────
  const bias1h  = detectBias(candles1h,  '1H');
  const bias15m = detectBias(candles15m, '15M');

  // ── BUILD OUTPUT ───────────────────────────────────────
  const output = {
    meta: {
      fetchedAt:    new Date().toISOString(),
      fetchedAtET:  spot?.fetchedAtET || nowET().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
      fetchedAtTs:  ts,
      ninja:  { usage: usage.ninja.count, limit: NINJA_MONTHLY_LIMIT, hardStop: NINJA_HARD_STOP,
                pct: ((usage.ninja.count / NINJA_MONTHLY_LIMIT) * 100).toFixed(1) + '%',
                status: usage.ninja.count >= NINJA_HARD_STOP ? 'SUSPENDED' : usage.ninja.count >= NINJA_MONTHLY_LIMIT ? 'WARNING' : 'OK' },
      gold:   { usage: usage.gold.count,  limit: GOLD_MONTHLY_LIMIT,  hardStop: GOLD_HARD_STOP,
                pct: ((usage.gold.count  / GOLD_MONTHLY_LIMIT)  * 100).toFixed(1) + '%',
                status: usage.gold.count  >= GOLD_HARD_STOP ? 'SUSPENDED' : 'OK',
                nextFetchIn: Math.max(0, GOLD_MIN_INTERVAL - (ts - usage.gold.lastTs)) + 's' },
    },
    spot,
    candles1h,
    candles15m,
    candles1m,
    bias: {
      h1:        bias1h.bias,
      h1Reason:  bias1h.reason,
      m15:       bias15m.bias,
      m15Reason: bias15m.reason,
      aligned:   bias1h.bias !== 'Rng' && bias1h.bias === bias15m.bias,
      direction: (bias1h.bias === bias15m.bias && bias1h.bias !== 'Rng') ? bias1h.bias : 'Rng',
      detectedAt: new Date().toISOString(),
    },
    news: newsEvents,
  };

  fs.writeFileSync(CANDLES_FILE, JSON.stringify(output, null, 2));
  console.log(`[WRITE] candles.json — ${JSON.stringify(output).length} chars`);

  usage.history.push({ ts, ninjaThis, goldThis, ninjaTot: usage.ninja.count, goldTot: usage.gold.count });
  if (usage.history.length > 500) usage.history = usage.history.slice(-500);
  saveUsage(usage);

  console.log(`\n[SUMMARY]`);
  console.log(`  Ninja:   ${usage.ninja.count}/${NINJA_MONTHLY_LIMIT} (${output.meta.ninja.pct})`);
  console.log(`  GoldAPI: ${usage.gold.count}/${GOLD_MONTHLY_LIMIT}  (${output.meta.gold.pct})`);
  console.log(`  Bias:    1H=${bias1h.bias} | 15M=${bias15m.bias} | Aligned=${output.bias.aligned}`);
  console.log(`  News:    ${newsEvents.length} event(s) (${newsEvents.filter(e=>e.auto).length} auto)`);
  console.log('─'.repeat(60) + '\n');
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
