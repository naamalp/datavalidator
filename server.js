const path = require('path');
const fs = require('fs');
require('dotenv').config();
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  require('dotenv').config({ path: path.join(__dirname, '.env.example') });
}
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const twilio = require('twilio');
const crypto = require('crypto');
const { RequestClient } = twilio;

/**
 * Redirects Twilio API requests to a mock base URL (e.g. Prism).
 * @see https://www.twilio.com/docs/openapi/mock-api-generation-with-twilio-openapi-spec
 */
function createMockHttpClient(mockBaseUrl) {
  const base = (mockBaseUrl || '').replace(/\/$/, '');
  if (!base) return null;
  const inner = new RequestClient();
  return {
    request(opts) {
      if (opts && opts.uri && /^https:\/\/[^/]+\.twilio\.com/.test(opts.uri)) {
        opts = { ...opts, uri: opts.uri.replace(/^https:\/\/[^/]+\.twilio\.com/, base) };
      }
      return inner.request(opts);
    },
  };
}

const app = express();
const PORT = process.env.PORT || 3000;

// Column indices (0-based): column 1 → 0, column 4 → 3, column 5 → 4
const COL_PHONE = 0;
const COL_FIRST_NAME = 3;
const COL_LAST_NAME = 4;

const RESULT_COLUMNS = [
  'first_name_match',
  'last_name_match',
  'summary_score',
  'identity_match_error',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      return cb(new Error('Only CSV files are allowed'));
    }
    cb(null, true);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isResultEmpty(v) {
  return (v ?? '').toString().trim() === '';
}

const AUTH_COOKIE_NAME = 'dv_session';
// Long-lived cookie (no idle/expiry validation on the token itself).
const AUTH_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365 * 10;

function getAuthSecret() {
  const explicit = (process.env.AUTH_SECRET || '').trim();
  if (explicit) return explicit;
  const users = (process.env.AUTH_USERS || '').trim();
  if (users) {
    return crypto.createHash('sha256').update(`dv-auth:${users}`).digest('hex');
  }
  return crypto.createHash('sha256').update('dv-auth:dev-only-change-me').digest('hex');
}

const AUTH_SECRET = getAuthSecret();

const CHECKPOINT_DIR = process.env.VERCEL
  ? path.join('/tmp', 'datavalidator-checkpoints')
  : path.join(__dirname, '.checkpoints');

function parseAuthUsers(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) return null;
      const username = entry.slice(0, idx).trim();
      const password = entry.slice(idx + 1).trim();
      if (!username || !password) return null;
      return { username, password };
    })
    .filter(Boolean);
}

const AUTH_USERS = parseAuthUsers(process.env.AUTH_USERS);

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  const result = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    result[key] = decodeURIComponent(val);
  }
  return result;
}

function createSessionToken(username) {
  const payload = JSON.stringify({ u: username });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch (_) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const username = (payload?.u || '').toString().trim();
    return username ? { username } : null;
  } catch (_) {
    return null;
  }
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  return { token, session };
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SEC}`,
  ];
  if (isProd) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function checkpointFilePath(username, fileKey) {
  const userHash = crypto.createHash('sha256').update(username).digest('hex').slice(0, 16);
  const keyHash = crypto.createHash('sha256').update(fileKey).digest('hex');
  return path.join(CHECKPOINT_DIR, `${userHash}_${keyHash}.json`);
}

function readCheckpoint(username, fileKey) {
  const fp = checkpointFilePath(username, fileKey);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.headers) || !Array.isArray(data.rows)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeCheckpoint(username, fileKey, checkpoint) {
  if (!fileKey || !checkpoint || !Array.isArray(checkpoint.headers) || !Array.isArray(checkpoint.rows)) {
    throw new Error('Invalid checkpoint payload');
  }
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const fp = checkpointFilePath(username, fileKey);
  fs.writeFileSync(fp, JSON.stringify(checkpoint), 'utf8');
}

function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProd) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function requireAuth(req, res, next) {
  const auth = getSession(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  req.authUser = auth.session.username;
  next();
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment');
  }
  const mockBase = process.env.TWILIO_MOCK_BASE_URL;
  const httpClient = createMockHttpClient(mockBase);
  const options = httpClient ? { httpClient } : {};
  return twilio(accountSid, authToken, options);
}

const USE_MOCK_IDENTITY_MATCH = /^(1|true|yes)$/i.test(
  (process.env.TWILIO_MOCK_IDENTITY_MATCH || '').trim()
);
const IDENTITY_MATCH_CONCURRENCY = Math.max(
  1,
  Number.parseInt((process.env.IDENTITY_MATCH_CONCURRENCY || '8').trim(), 10) || 8
);

async function identityMatch(client, phoneNumber, firstName, lastName) {
  try {
    const result = await client.lookups.v2
      .phoneNumbers(phoneNumber)
      .fetch({
        fields: 'identity_match',
        firstName: (firstName || '').trim(),
        lastName: (lastName || '').trim(),
      });
    const im = result.identityMatch || {};
    const firstNameMatch = im.first_name_match ?? im.firstNameMatch ?? '';
    const lastNameMatch = im.last_name_match ?? im.lastNameMatch ?? '';
    const summaryScore = im.summary_score ?? im.summaryScore ?? '';
    const noResult =
      isResultEmpty(firstNameMatch) &&
      isResultEmpty(lastNameMatch) &&
      isResultEmpty(summaryScore);
    return {
      first_name_match: firstNameMatch,
      last_name_match: lastNameMatch,
      summary_score: summaryScore,
      // Mark blank responses as attempted so chunk processing can advance.
      identity_match_error: noResult ? 'no_result' : '',
    };
  } catch (err) {
    const code = err.code != null ? err.code : '';
    const msg = err.message || '';
    const identity_match_error = [code, msg].filter(Boolean).join(': ') || 'Lookup failed';
    return {
      first_name_match: '',
      last_name_match: '',
      summary_score: '',
      identity_match_error,
    };
  }
}

app.post('/api/process-chunk', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array is required' });
  }

  let client = null;
  if (!USE_MOCK_IDENTITY_MATCH) {
    try {
      client = getTwilioClient();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const updatedRows = new Array(rows.length);
  const tupleCache = new Map();

  function mapResultToRow(row, result) {
    const base = row.slice(0, row.length - RESULT_COLUMNS.length);
    return [
      ...base,
      result.first_name_match,
      result.last_name_match,
      result.summary_score,
      result.identity_match_error,
    ];
  }

  function mockIdentityMatch(firstName, lastName) {
    return {
      first_name_match: firstName.trim() ? 'exact_match' : 'no_match',
      last_name_match: lastName.trim() ? 'exact_match' : 'no_match',
      summary_score: (firstName.trim() && lastName.trim()) ? 'high' : 'low',
      identity_match_error: '',
    };
  }

  async function processRow(row) {
    const firstNameMatch = row[row.length - 4];
    const lastNameMatch = row[row.length - 3];
    const summaryScore = row[row.length - 2];
    const identityMatchError = row[row.length - 1];

    // If we've already attempted this row, don't call Twilio again.
    const alreadyProcessed =
      !isResultEmpty(firstNameMatch) ||
      !isResultEmpty(lastNameMatch) ||
      !isResultEmpty(summaryScore) ||
      !isResultEmpty(identityMatchError);
    if (alreadyProcessed) return row;

    const phone = (row[COL_PHONE] ?? '').toString().trim();
    const firstName = (row[COL_FIRST_NAME] ?? '').toString();
    const lastName = (row[COL_LAST_NAME] ?? '').toString();
    const tupleKey = `${phone}\u0001${firstName}\u0001${lastName}`;

    if (!tupleCache.has(tupleKey)) {
      const promise = USE_MOCK_IDENTITY_MATCH
        ? Promise.resolve(mockIdentityMatch(firstName, lastName))
        : identityMatch(client, phone, firstName, lastName);
      tupleCache.set(tupleKey, promise);
    }
    const result = await tupleCache.get(tupleKey);
    return mapResultToRow(row, result);
  }

  async function runPool(items, worker, concurrency) {
    let cursor = 0;
    const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
      while (true) {
        const current = cursor;
        cursor += 1;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    });
    await Promise.all(runners);
  }

  await runPool(rows, async (row, idx) => {
    if (!Array.isArray(row)) {
      updatedRows[idx] = row;
      return;
    }
    updatedRows[idx] = await processRow(row);
  }, IDENTITY_MATCH_CONCURRENCY);

  res.json({ rows: updatedRows });
});

async function callerNameLookup(client, phoneNumber) {
  const phone = (phoneNumber || '').toString().trim();
  if (!phone) {
    return { phone: phoneNumber, caller_name: '', caller_type: '', error: 'No phone number' };
  }
  try {
    const result = await client.lookups.v2
      .phoneNumbers(phone)
      .fetch({ fields: 'caller_name' });
    const cn = result.callerName || result.caller_name || {};
    const name = cn.caller_name ?? cn.callerName ?? '';
    const type = cn.caller_type ?? cn.callerType ?? '';
    const err = cn.error_code ?? cn.errorCode ?? null;
    return {
      phone,
      caller_name: name != null ? String(name) : '',
      caller_type: type != null ? String(type) : '',
      error: err != null ? String(err) : '',
    };
  } catch (err) {
    const msg = err.message || 'Lookup failed';
    return { phone, caller_name: '', caller_type: '', error: msg };
  }
}

const USE_MOCK_CALLER_NAME = /^(1|true|yes)$/i.test(
  (process.env.TWILIO_MOCK_CALLER_NAME || '').trim()
);

app.get('/api/auth/me', (req, res) => {
  const auth = getSession(req);
  if (!auth) return res.json({ authenticated: false });
  return res.json({ authenticated: true, username: auth.session.username });
});

app.post('/api/auth/login', express.json(), (req, res) => {
  const username = (req.body?.username || '').toString().trim();
  const password = (req.body?.password || '').toString();

  if (AUTH_USERS.length === 0) {
    return res.status(500).json({
      error: 'No users configured. Set AUTH_USERS env var (e.g. "admin:password,user2:password2").',
    });
  }

  const user = AUTH_USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSessionToken(user.username);
  setAuthCookie(res, token);
  return res.json({ ok: true, username: user.username });
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/checkpoint', requireAuth, (req, res) => {
  const fileKey = (req.query.fileKey || '').toString().trim();
  if (!fileKey) return res.status(400).json({ error: 'fileKey query parameter is required' });
  const checkpoint = readCheckpoint(req.authUser, fileKey);
  return res.json({ checkpoint });
});

app.put('/api/checkpoint', requireAuth, express.json({ limit: '12mb' }), (req, res) => {
  const fileKey = (req.body?.fileKey || '').toString().trim();
  const checkpoint = req.body?.checkpoint;
  if (!fileKey) return res.status(400).json({ error: 'fileKey is required' });
  try {
    writeCheckpoint(req.authUser, fileKey, checkpoint);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Failed to save checkpoint' });
  }
});

// Protect all data/processing endpoints.
app.use('/api/process', requireAuth);

app.post('/api/caller-name', requireAuth, express.json(), async (req, res) => {
  const phoneNumbers = req.body?.phoneNumbers;
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'phoneNumbers array is required' });
  }

  const knownResults = req.body?.knownResults;
  const knownByPhone = new Map();
  if (knownResults && typeof knownResults === 'object' && !Array.isArray(knownResults)) {
    for (const [phone, name] of Object.entries(knownResults)) {
      const p = (phone ?? '').toString().trim();
      const n = (name ?? '').toString().trim();
      if (p && n) knownByPhone.set(p, n);
    }
  }

  const results = [];
  const toLookup = [];

  for (const phone of phoneNumbers) {
    const p = (phone ?? '').toString().trim();
    if (!p) {
      results.push({ phone: p, caller_name: '', caller_type: '', error: 'No phone number' });
      continue;
    }
    if (knownByPhone.has(p)) {
      results.push({
        phone: p,
        caller_name: knownByPhone.get(p),
        caller_type: '',
        error: '',
        cached: true,
      });
      continue;
    }
    toLookup.push(p);
  }

  if (toLookup.length === 0) {
    return res.json({ results });
  }

  if (USE_MOCK_CALLER_NAME) {
    for (const p of toLookup) {
      results.push({
        phone: p,
        caller_name: p ? `Mock Caller (${p.slice(-4)})` : '',
        caller_type: 'CONSUMER',
        error: '',
      });
    }
    return res.json({ results });
  }

  let client;
  try {
    client = getTwilioClient();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  for (const phone of toLookup) {
    const r = await callerNameLookup(client, phone);
    results.push(r);
  }
  res.json({ results });
});

function parseAndValidateCsv(buffer) {
  const records = parse(buffer, {
    encoding: 'utf8',
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  if (records.length === 0) {
    throw new Error('CSV has no rows');
  }
  const header = records[0];
  const maxCol = Math.max(COL_PHONE, COL_FIRST_NAME, COL_LAST_NAME);
  if (header.length <= maxCol) {
    throw new Error(`CSV must have at least 5 columns (phone=1, first name=4, last name=5). Found ${header.length}.`);
  }
  return { header, records };
}

app.post('/api/preview', requireAuth, upload.single('csv'), (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }
  let parsed;
  try {
    parsed = parseAndValidateCsv(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Invalid CSV' });
  }
  const { header, records } = parsed;
  const outputHeader = [...header, ...RESULT_COLUMNS];
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    rows.push([...records[i], '', '', '', '']);
  }
  const filename = (req.file.originalname || 'upload.csv').replace(/\.csv$/i, '') + '-identity-match-results.csv';
  res.json({ headers: outputHeader, rows, filename });
});

app.post('/api/process', (_req, res) => {
  res.status(410).json({
    error: 'Deprecated endpoint. Use /api/preview and /api/process-chunk for resumable processing.',
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Data Validator running at http://localhost:${PORT}`);
    if (process.env.TWILIO_MOCK_BASE_URL) {
      console.log('Twilio requests redirected to mock:', process.env.TWILIO_MOCK_BASE_URL);
    }
    if (USE_MOCK_IDENTITY_MATCH) {
      console.log('Identity Match using inline mock (no API cost). Set TWILIO_MOCK_IDENTITY_MATCH=0 to use real API.');
    }
    if (USE_MOCK_CALLER_NAME) {
      console.log('Caller Name using inline mock (no API cost). Set TWILIO_MOCK_CALLER_NAME=0 to use real API.');
    }
  });
}

module.exports = app;
