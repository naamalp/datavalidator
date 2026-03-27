const path = require('path');
require('dotenv').config();
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  require('dotenv').config({ path: path.join(__dirname, '.env.example') });
}
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const twilio = require('twilio');
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
    return {
      first_name_match: im.first_name_match ?? im.firstNameMatch ?? '',
      last_name_match: im.last_name_match ?? im.lastNameMatch ?? '',
      summary_score: im.summary_score ?? im.summaryScore ?? '',
      identity_match_error: '',
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

app.post('/api/process-chunk', express.json({ limit: '2mb' }), async (req, res) => {
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

  const updatedRows = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      updatedRows.push(row);
      continue;
    }

    const firstNameMatch = row[row.length - 4];
    const lastNameMatch = row[row.length - 3];
    const summaryScore = row[row.length - 2];
    const identityMatchError = row[row.length - 1];

    // If we've already processed this row successfully, skip re-calling Twilio
    const alreadyProcessed =
      !isResultEmpty(firstNameMatch) ||
      !isResultEmpty(lastNameMatch) ||
      !isResultEmpty(summaryScore) ||
      !isResultEmpty(identityMatchError);
    if (alreadyProcessed) {
      updatedRows.push(row);
      continue;
    }

    const phone = (row[COL_PHONE] ?? '').toString().trim();
    const firstName = (row[COL_FIRST_NAME] ?? '').toString();
    const lastName = (row[COL_LAST_NAME] ?? '').toString();

    const result = USE_MOCK_IDENTITY_MATCH
      ? {
          first_name_match: firstName.trim() ? 'exact_match' : 'no_match',
          last_name_match: lastName.trim() ? 'exact_match' : 'no_match',
          summary_score: (firstName.trim() && lastName.trim()) ? 'high' : 'low',
          identity_match_error: '',
        }
      : await identityMatch(client, phone, firstName, lastName);
    const base = row.slice(0, row.length - RESULT_COLUMNS.length);
    updatedRows.push([
      ...base,
      result.first_name_match,
      result.last_name_match,
      result.summary_score,
      result.identity_match_error,
    ]);
  }

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

app.post('/api/caller-name', express.json(), async (req, res) => {
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

app.post('/api/preview', upload.single('csv'), (req, res) => {
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
