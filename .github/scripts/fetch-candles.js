// .github/scripts/fetch-candles.js
// Fetches XAU/USD OHLC candle data from API Ninjas + live spot from GoldAPI.
// Guards: ET trading hours only, Mon–Fri, 150s minimum between real fetches,
// hard stop at 2,900 monthly calls.
// Writes data/candles.json and data/usage.json.

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── CONFIG ──────────────────────────────────────────────────
const NINJA_KEY      = process.env.NINJA_KEY;
const GOLD_KEY       = process.env.GOLD_KEY;
const DATA_DIR       = path.join(process.cwd(), 'data');
const CANDLES_FILE   = path.join(DATA_DIR, 'candles.json');
const USAGE_FILE     = path.join(DATA_DIR, 'usage.json');

const MONTHLY_LIMIT  = 2700;   // target budget
const HARD_STOP      = 2900;   // absolute ceiling — alert and stop
const MIN_INTERVAL_S = 145;    // minimum seconds between real API calls
const SESSION_START_H = 8;     // ET hour (inclusive)
const SESSION_END_H   = 13;    // ET hour (exclusive) — stops at 1PM ET

// ── HELPERS ─────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req  = https.request({
      hostname: opts.hostname,
      path:     opts.pathname + opts.search,
      method:   'GET',
      headers:  { 'Content-Type': 'application/json', ...headers },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function nowET() {
  // Convert current UTC to Eastern Time
  // Uses Intl to handle DST automatically (EDT = UTC-4, EST = UTC-5)
  const etString = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etString);
}

function isValidTradingWindow() {
  const et   = nowET();
  const dow  = et.getDay();   // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hour = et.getHours();

  if (dow === 0 || dow === 6) {
    console.log(`[SKIP] Weekend (day ${dow}) — no trading`);
    return false;
  }
  if (hour < SESSION_START_H || hour >= SESSION_END_H) {
    console.log(`[SKIP] Outside session window — ET hour: ${hour} (need ${SESSION_START_H}–${SESSION_END_H-1})`);
    return false;
  }
  return true;
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch(e) { /* fall through */ }
  return { month: '', count: 0, lastFetchTs: 0, history: [] };
}

function saveUsage(usage) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function checkRateLimit(usage) {
  const month = getCurrentMonth();

  // Reset counter at the start of a new month
  if (usage.month !== month) {
    console.log(`[INFO] New month ${month} — resetting counter (was ${usage.count} in ${usage.month || 'N/A'})`);
    usage.month  = month;
    usage.count  = 0;
    usage.history = [];
  }

  // Hard stop
  if (usage.count >= HARD_STOP) {
    console.error(`[ALERT] Monthly call limit reached: ${usage.count} / ${HARD_STOP}. ALL FETCHES SUSPENDED.`);
    console.error(`[ALERT] Resume on the 1st of next month or increase HARD_STOP in fetch-candles.js.`);
    return false;
  }

  // Soft warning
  if (usage.count >= MONTHLY_LIMIT) {
    console.warn(`[WARN] Approaching limit: ${usage.count} / ${MONTHLY_LIMIT}. Continuing but check budget.`);
  }

  // Minimum interval between calls (prevents runaway re-runs)
  const nowTs = Math.floor(Date.now() / 1000);
  const elapsed = nowTs - (usage.lastFetchTs || 0);
  if (elapsed < MIN_INTERVAL_S) {
    console.log(`[SKIP] Too soon — last fetch was ${elapsed}s ago (minimum ${MIN_INTERVAL_S}s). Skipping.`);
    return false;
  }

  return true;
}

async function fetchCandleInterval(interval, limit) {
  const nowTs  = Math.floor(Date.now() / 1000);
  const secMap = { '1h': 3600, '15m': 900, '1m': 60 };
  const sec    = secMap[interval] || 3600;
  const start  = nowTs - sec * (limit + 5);
  const url    = `https://api.api-ninjas.com/v1/goldpricehistorical?commodity=gold&interval=${interval}&start=${start}&end=${nowTs}`;

  console.log(`[FETCH] ${interval} candles (last ${limit})…`);
  const raw = await httpsGet(url, { 'X-Api-Key': NINJA_KEY });
  if (!Array.isArray(raw)) throw new Error(`Unexpected response for ${interval}: ${JSON.stringify(raw).substring(0,200)}`);

  // API returns newest-first — reverse to oldest-first, take last `limit`
  const candles = raw.reverse().slice(-limit).map(c => ({
    t: c.timestamp,
    o: parseFloat(c.open),
    h: parseFloat(c.high),
    l: parseFloat(c.low),
    c: parseFloat(c.close),
  }));

  console.log(`[OK]    ${interval}: got ${candles.length} candles`);
  return candles;
}

async function fetchSpotPrice() {
  console.log('[FETCH] Spot price from GoldAPI…');
  const data = await httpsGet('https://www.goldapi.io/api/XAU/USD', {
    'x-access-token': GOLD_KEY,
  });
  return {
    price:      parseFloat(data.price || data.ask || 0),
    ask:        parseFloat(data.ask   || 0),
    bid:        parseFloat(data.bid   || 0),
    high:       parseFloat(data.high_price  || 0),
    low:        parseFloat(data.low_price   || 0),
    open:       parseFloat(data.open_price  || 0),
    change:     parseFloat(data.ch  || 0),
    changePct:  parseFloat(data.chp || 0),
    spread:     parseFloat(Math.max(0, (data.ask || 0) - (data.bid || 0)).toFixed(2)) || 0.28,
  };
}

// ── MAIN ────────────────────────────────────────────────────
async function main() {
  console.log(`[START] fetch-candles.js — ${new Date().toISOString()} UTC`);
  console.log(`[ET]    ${nowET().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);

  // Guard 1: trading window
  if (!isValidTradingWindow()) process.exit(0);

  // Guard 2: rate limit
  const usage = loadUsage();
  if (!checkRateLimit(usage)) process.exit(0);

  // ── Fetch all data ──────────────────────────────────────
  let spot, candles1h, candles15m, candles1m;
  let callsThisRun = 0;

  try {
    spot = await fetchSpotPrice();
    // GoldAPI does NOT count against Ninja quota — it's a separate key
    console.log(`[OK]    Spot: ${spot.price} (spread: ${spot.spread})`);
  } catch(e) {
    console.error('[ERROR] GoldAPI spot fetch failed:', e.message);
    spot = null;
  }

  try {
    candles1h  = await fetchCandleInterval('1h',  40); callsThisRun++;
    candles15m = await fetchCandleInterval('15m', 40); callsThisRun++;
    candles1m  = await fetchCandleInterval('1m',  60); callsThisRun++;
  } catch(e) {
    console.error('[ERROR] Candle fetch failed:', e.message);
    // Write whatever we have so the website doesn't get stale data errors
  }

  // ── Build output JSON ────────────────────────────────────
  const nowTs   = Math.floor(Date.now() / 1000);
  const nowET_  = nowET();

  // Load existing data to preserve on partial failure
  let existing = {};
  try {
    if (fs.existsSync(CANDLES_FILE)) existing = JSON.parse(fs.readFileSync(CANDLES_FILE, 'utf8'));
  } catch(e) {}

  const output = {
    meta: {
      fetchedAt:    new Date().toISOString(),
      fetchedAtET:  nowET_.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
      fetchedAtTs:  nowTs,
      monthlyUsage: usage.count + callsThisRun,
      monthlyLimit: MONTHLY_LIMIT,
      hardStop:     HARD_STOP,
      budgetPct:    (((usage.count + callsThisRun) / MONTHLY_LIMIT) * 100).toFixed(1) + '%',
      status:       (usage.count + callsThisRun) >= HARD_STOP ? 'SUSPENDED' :
                    (usage.count + callsThisRun) >= MONTHLY_LIMIT ? 'WARNING' : 'OK',
    },
    spot:       spot       || existing.spot       || null,
    candles1h:  candles1h  || existing.candles1h  || [],
    candles15m: candles15m || existing.candles15m || [],
    candles1m:  candles1m  || existing.candles1m  || [],
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CANDLES_FILE, JSON.stringify(output, null, 2));
  console.log(`[WRITE] data/candles.json — ${JSON.stringify(output).length} bytes`);

  // ── Update usage counter ─────────────────────────────────
  usage.count       += callsThisRun;
  usage.lastFetchTs  = nowTs;
  usage.month        = getCurrentMonth();
  usage.history.push({
    ts:    nowTs,
    et:    nowET_.toLocaleString('en-US', { timeZone: 'America/New_York' }),
    calls: callsThisRun,
    total: usage.count,
  });
  // Keep only last 200 entries in history
  if (usage.history.length > 200) usage.history = usage.history.slice(-200);

  saveUsage(usage);
  console.log(`[USAGE] ${usage.count} / ${MONTHLY_LIMIT} this month (${output.meta.budgetPct} of budget)`);

  if (usage.count >= HARD_STOP) {
    console.error('[ALERT] !! HARD STOP REACHED — service suspended until next month !!');
  } else if (usage.count >= MONTHLY_LIMIT) {
    console.warn('[WARN]  Soft limit reached. Monitor usage.');
  }

  console.log('[DONE]  fetch-candles.js completed successfully');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
