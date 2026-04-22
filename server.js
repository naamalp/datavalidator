const path = require('path');
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
const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const authSessions = new Map();

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

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    return null;
  }
  return { token, session };
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`,
  ];
  if (isProd) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
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

  const token = crypto.randomBytes(24).toString('hex');
  authSessions.set(token, {
    username: user.username,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  });
  setAuthCookie(res, token);
  return res.json({ ok: true, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  const auth = getSession(req);
  if (auth) authSessions.delete(auth.token);
  clearAuthCookie(res);
  res.json({ ok: true });
});

// Protect all data/processing endpoints.
app.use('/api/process', requireAuth);

app.post('/api/caller-name', requireAuth, express.json(), async (req, res) => {
  const phoneNumbers = req.body?.phoneNumbers;
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'phoneNumbers array is required' });
  }

  if (USE_MOCK_CALLER_NAME) {
    const results = phoneNumbers.map((phone) => {
      const p = (phone ?? '').toString().trim();
      return {
        phone: p,
        caller_name: p ? `Mock Caller (${p.slice(-4)})` : '',
        caller_type: 'CONSUMER',
        error: '',
      };
    });
    return res.json({ results });
  }

  let client;
  try {
    client = getTwilioClient();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  const results = [];
  for (const phone of phoneNumbers) {
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
