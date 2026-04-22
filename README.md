# Data Validator

Local app that uploads a UTF-8 CSV, runs **Twilio Lookup Identity Match** on each row (using column 1 = phone, column 4 = First name, column 5 = Last name), then returns the same CSV with result columns added and available to download.

## CSV format

- **Encoding:** UTF-8
- **Column 1:** Phone number (sent to Twilio)
- **Column 4:** First name
- **Column 5:** Last name

Result columns appended to each row:

- `first_name_match`
- `last_name_match`
- `summary_score`
- `identity_match_error` (filled if the lookup failed)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Twilio credentials**

   Copy `.env.example` to `.env` and set your Twilio account details:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:

   - `TWILIO_ACCOUNT_SID` – from [Twilio Console](https://console.twilio.com) (Dashboard → Account Info). Must start with **`AC`**.
   - `TWILIO_AUTH_TOKEN` – from the same place (click the eye icon to reveal). Use the **Auth Token**, not API Key Secret or Client Secret.

3. **App login users (no signup)**

   Set `AUTH_USERS` in `.env` as comma-separated `username:password` pairs:

   ```env
   AUTH_USERS=admin:change-me,ops:strong-password
   ```

   To add a user later, append another `username:password` pair and restart the app.

## Troubleshooting: `identity_match_error: authenticate`

This usually means Twilio rejected your credentials. Fix it by:

1. **Use the correct Account SID**  
   In [Twilio Console](https://console.twilio.com) → Dashboard, under **Account Info**, copy **Account SID**. It always starts with **`AC`** (e.g. `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`). Do not use an API Key SID, SID starting with `SK`/`OQ`, or any other value.

2. **Use the Auth Token, not other secrets**  
   In the same **Account Info** section, copy **Auth Token** (click the eye to reveal). Do not use **API Key Secret**, **Client Secret**, or any other token.

3. **No extra spaces or quotes**  
   In `.env` or `.env.example`, use plain values with no spaces:
   ```env
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token_here
   ```

4. **Regenerate the Auth Token if needed**  
   If the token was rotated or might be wrong: Console → Account → API keys & tokens → Auth Token → Regenerate. Then update your `.env` with the new value.

5. **Restart the app** after changing `.env`.

## Run locally

```bash
npm start
```

Then open **http://localhost:3000**, upload a CSV, and use **Process with Identity Match** or **Preview only (no API cost)**. Results are shown in the table; use **Download CSV** to save. The **Find names** button looks up caller names (Twilio Caller Name API) for rows where both first and last name match are no_match or blank.

## Testing without API cost (mocks)

To test both **Identity Match** and **Find names** without incurring Twilio API costs you can use either approach below.

### Option 1: Inline mock (simplest)

Set in `.env`:

```env
TWILIO_MOCK_IDENTITY_MATCH=1
TWILIO_MOCK_CALLER_NAME=1
```

Restart the app. **Process with Identity Match** and **Find names** will use inline mock responses (no Twilio API calls). This is the easiest way to validate chunking/resume behavior without cost.

### Identity Match speed tuning

`/api/process-chunk` supports bounded parallel lookups per request using:

```env
IDENTITY_MATCH_CONCURRENCY=8
```

Recommended tuning approach:

1. Start at `8`
2. Increase gradually with production-like files
3. If 429s/timeouts increase, step back to the previous stable value

### Option 2: Prism mock server

You can redirect Twilio API requests to a local [Prism](https://stoplight.io/open-source/prism) mock server generated from [Twilio’s OpenAPI spec](https://www.twilio.com/docs/openapi/mock-api-generation-with-twilio-openapi-spec).

1. **Install Prism**

   ```bash
   npm install -g @stoplight/prism-cli
   ```

2. **Start the mock server** (in a separate terminal)

   ```bash
   prism mock https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json
   ```

   Prism will listen on `http://127.0.0.1:4010` (or the port it prints).

3. **Point the app at the mock** in `.env`:

   ```env
   TWILIO_MOCK_BASE_URL=http://127.0.0.1:4010
   ```

4. Restart the Data Validator app. All Twilio requests (including Lookup) are sent to Prism instead of Twilio.

**Note:** The main Twilio OpenAPI spec (`twilio_api_v2010.json`) may not include Lookup v2 (Caller Name) endpoints. If **Find names** fails or returns unexpected data when using Prism, use **Option 1** (inline mock) to test the Find names flow without cost.
