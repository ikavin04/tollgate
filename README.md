# TOLLGATE

**Every AI purchase must pass the gate.**

Tollgate is a local-first intent-verification and payment-authorization gateway that prevents AI shopping agents from executing unauthorized purchases by checking proposed purchases against original human instructions, enforcing deterministic spending policies, inspecting untrusted webpage content, and controlling PayPal Sandbox payment execution.

> **Core promise:** An AI agent may recommend a purchase. It cannot independently decide to move the user's money.

---

## Problem Statement

AI shopping agents read untrusted merchant webpages containing hidden DOM text, HTML comments, paraphrased prompt injections, or misleading claims that contradict structured product metadata.

For example:
- A user instructs: *"Buy one new laptop under $500. No accessories."*
- A malicious listing offers a `$399` laptop while hiding instructions directing the agent to also add `10x $10` gift cards (`$499` total).
- A naive budget cap fails because `$499` is still under `$500`.

Tollgate sits strictly between the AI shopping agent and PayPal. The agent has **zero** access to PayPal credentials, OAuth tokens, or payment-execution endpoints.

---

## Solution & Architecture

Tollgate separates untrusted product discovery from deterministic enforcement, independent AI intent inspection, and live PayPal Sandbox payment execution:

1. **Mandate Compiler** ([`lib/mandate/compiler.ts`](lib/mandate/compiler.ts)) — Converts plain-English instructions into Zod-validated JSON ([`lib/mandate/schema.ts`](lib/mandate/schema.ts)), flags unsupported categories, conflicting constraints, missing budgets, and unresolved approved-brand lists before requiring explicit human confirmation.
2. **Controlled Fake Storefront** ([`lib/storefront/index.ts`](lib/storefront/index.ts)) — SQLite-seeded electronics catalog (`products`) containing normal listings and adversarial prompt-injection / contradictory-prose listings without exposing any test-oracle labels to the agent or public storefront API. Untrusted HTML/JS is never executed; hidden elements and HTML comments are converted to explicit plain-text markers (`[HIDDEN_ELEMENT_TEXT]`, `[HTML_COMMENT]`).
3. **Isolated Shopping Agent** ([`lib/agent/shopping-agent.ts`](lib/agent/shopping-agent.ts)) — Restricted to three backend-validated tools: `search_store`, `read_page`, and `propose_purchase`. The agent submits only `product_id` and integer `quantity`; Tollgate resolves authoritative prices, SKUs, and warranty attributes from its catalog.
4. **Page Evidence Collector & Heuristic Provenance** ([`lib/evidence/index.ts`](lib/evidence/index.ts)) — Persists verbatim `read_page` output with SHA-256 hashes, enforces a `4,000`-char/page and `16,000`-char/review model bound, escalates truncated pages to `REVIEW`, and applies heuristic source tags (`from_mandate`, `from_tool_result`, `from_page_text`, `from_agent_inference`).
5. **Deterministic Policy Engine** ([`lib/policy/engine.ts`](lib/policy/engine.ts)) — Pure TypeScript rules evaluating budget (`max_total`), category (`gift_card` never authorized by `accessories_allowed`), allowed brands, product condition, quantity, currency, mandatory specs, approval thresholds (`approval_above`), ambiguous bundles, truncation flags, and structured soft preferences (e.g., 16 GB RAM preference with fallback condition check).
6. **Independent AI Intent Reviewer** ([`lib/reviewer/index.ts`](lib/reviewer/index.ts)) — Separate Gemini API invocation with isolated system instructions treating webpage content as untrusted quoted data. Evaluates contradictions between canonical catalog facts and untrusted prose. Fails closed to `REVIEW` on timeout, error, or malformed JSON. Combined precedence is strictly `BLOCK > REVIEW > ALLOW`.
7. **PayPal Payment Adapter** ([`lib/paypal/`](lib/paypal/index.ts)) — Server-only PayPal REST API v2 integration (`POST /v1/oauth2/token` with `expires_in`-driven caching, `POST /v2/checkout/orders` with `intent: "AUTHORIZE"`, `GET /v2/checkout/orders/{id}`, `POST /authorize`, `GET /v2/payments/authorizations/{id}`, `POST /capture`, `POST /void`), backed by persistent UUID idempotency in `payment_operations`.
8. **Tamper-Evident Evidence Ledger** ([`lib/ledger/index.ts`](lib/ledger/index.ts)) — Per-session SHA-256 hash chain `H_n = SHA256(H_previous + canonical_event_json)`, live verification, independent checkpoint exports, and downloadable JSON receipts.
9. **Session Isolation** ([`lib/session/index.ts`](lib/session/index.ts)) — Cryptographic anonymous session IDs via `HttpOnly`, `SameSite=Lax` cookies scoping every database read and mutation.

---

## Technology Stack

- **Runtime:** Node.js `>= 22.0.0` (required by `better-sqlite3@13.0.3`; verified on Node `v22.18.0`, npm `10.9.3`)
- **Frontend:** Next.js `16.4.6` (App Router), React `19.3.0`, TypeScript, Tailwind CSS v4, Lucide React
- **Backend:** Next.js App Router Route Handlers, Zod `4.6.7`
- **Database:** Local SQLite via `better-sqlite3` (`13` application tables + `schema_migrations`)
- **AI:** Google Gemini API via `@google/genai` (`3.0.0`), Model ID: `gemini-3.5-flash-lite`
- **Payments:** PayPal REST API (Sandbox only), Orders API v2, Payments API v2 (server-side REST redirects — no PayPal JS SDK mixing)
- **Integrity:** Node.js `crypto` (SHA-256, `randomUUID`, `randomBytes`)
- **Testing:** Vitest (`vitest run`)

---

## Prerequisites & Local Installation

Tollgate runs **100% locally** with zero paid cloud hosting required.

### 1. System Requirements
- **Node.js:** `>= 22.0.0` (`better-sqlite3@13.0.3` specifies `engines.node >= 22`; Next.js `16.4.6` requires `>= 20.9.0`; `v22.x` LTS tested on `v22.18.0` and supports `npm run smoke:gemini` via `node --env-file=.env.local`).
- **npm:** Included with Node.js (tested with `npm 10.9.3`).
- **C++ Build Tools (usually unnecessary):** `better-sqlite3@13.0.3` already bundles prebuilt binaries for Windows, macOS, and Linux (`prebuilds/`). See the install note below if npm attempts `node-gyp rebuild`.

### 2. Clone & Install Dependencies

```bash
git clone https://github.com/ikavin04/tollgate.git
cd tollgate
npm ci
```

*(You may alternatively run `npm install`. On Windows machines without Visual Studio C++ Build Tools / Windows SDK, npm may trigger `node-gyp rebuild` on `better-sqlite3` and error; if that happens, run **`npm ci --ignore-scripts`** or **`npm install --ignore-scripts`** so Tollgate loads the bundled prebuilt binary directly from `node_modules/better-sqlite3/prebuilds/`.)*

---

## Environment Setup & Judge Credentials

1. Copy `.env.example` to `.env.local` (`.env.local` is excluded from Git by `.gitignore`):
   - **macOS / Linux:**
     ```bash
     cp .env.example .env.local
     ```
   - **Windows (PowerShell):**
     ```powershell
     Copy-Item .env.example .env.local
     ```

2. Configure your credentials in `.env.local` (never commit `.env.local` or share secret keys):

   | Variable | Required | Default / Example | Description |
   | :--- | :--- | :--- | :--- |
   | `PAYPAL_CLIENT_ID` | Yes (for PayPal) | — | PayPal **Sandbox** REST App Client ID |
   | `PAYPAL_CLIENT_SECRET` | Yes (for PayPal) | — | PayPal **Sandbox** REST App Secret |
   | `PAYPAL_BASE_URL` | Yes | `https://api-m.sandbox.paypal.com` | PayPal Sandbox REST API base URL |
   | `APP_BASE_URL` | Yes | `http://localhost:3000` | Local URL for PayPal return/cancel callbacks (must match the port Tollgate runs on) |
   | `GEMINI_API_KEY` | Yes (for live AI) | — | Google Gemini API key |
   | `GEMINI_MODEL` | Yes | `gemini-3.5-flash-lite` | Active Gemini model identifier |
   | `DATABASE_PATH` | Optional | `./data/tollgate.db` (when blank) | Optional custom SQLite file path |

### Getting Your Own Gemini API Key (Free Tier)
1. Visit Google AI Studio (`https://aistudio.google.com/`).
2. Sign in with a Google account and click **Create API key**.
3. Paste the key into `GEMINI_API_KEY=` inside `.env.local` and keep `GEMINI_MODEL=gemini-3.5-flash-lite`.
4. Optional quick connectivity check (uses Node `20.6+` `--env-file`):
   ```bash
   npm run smoke:gemini
   ```

### Getting Your Own PayPal Sandbox Merchant Credentials & Buyer Account
1. Visit the PayPal Developer Dashboard (`https://developer.paypal.com/`) and log in with a PayPal developer account.
2. Go to **Apps & Credentials -> Sandbox -> Create App** (or select your Default Application), choose **Merchant** type, and copy:
   - **Client ID** -> `PAYPAL_CLIENT_ID=`
   - **Secret** -> `PAYPAL_CLIENT_SECRET=`
3. Keep `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`.
4. Go to **Sandbox -> Accounts** in the Developer Dashboard to get your **Sandbox Personal (Buyer)** account email and password (distinct from the Business/Merchant account):
   - When Tollgate creates an order and you click **Approve in PayPal Sandbox**, PayPal opens `https://www.sandbox.paypal.com/checkoutnow?token=...`.
   - Log in on that Sandbox checkout page using your **Sandbox Personal Buyer** email and password to authorize the test transaction (no real money moves).

---

## Database Initialization

No separate database server or manual migration script is required:
- On startup ([`instrumentation.ts`](instrumentation.ts) -> `getDb()` -> [`openDatabase()`](lib/db/index.ts)), Tollgate automatically creates the `./data/` directory (or the parent directory of `DATABASE_PATH`), creates `tollgate.db` with `WAL` mode and `foreign_keys = ON`, applies migration `1` (`initial_tollgate_schema` creating `13` application tables plus `schema_migrations`), and idempotently seeds all `14` storefront SKUs ([`lib/db/seed-products.ts`](lib/db/seed-products.ts)).
- Confirm database initialization and environment health anytime:
  ```bash
  curl http://localhost:3000/api/health
  ```
- Confirm live PayPal Sandbox OAuth connectivity (without exposing secrets):
  ```bash
  curl "http://localhost:3000/api/health?verifyPaypalOAuth=true"
  ```

---

## Running Locally

### Development Mode
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### Production Build & Startup (Local)
```bash
npm run build
npm start
```
Open [http://localhost:3000](http://localhost:3000).

*(If you run on a different local port, update `APP_BASE_URL` in `.env.local` to match so PayPal's `return_url` and `cancel_url` redirect back to the same origin and preserve your `tollgate_session` cookie.)*

---

## Automated Verification Commands

```bash
npx tsc --noEmit   # TypeScript type-check
npm run lint       # ESLint checks
npm test           # Vitest suite (23 mocked/in-memory unit & E2E tests; no external network calls)
npm run build      # Next.js production build
```

For end-to-end walkthroughs using real Gemini + PayPal Sandbox checkout, see [`DEMO_GUIDE.md`](DEMO_GUIDE.md).

---

## AI Models and PayPal Architecture Summary

- **Exact Gemini Model ID:** `gemini-3.5-flash-lite` (configured via `GEMINI_MODEL`) across Mandate Compiler (`responseMimeType: "application/json"` + Zod), Shopping Agent (`search_store`, `read_page`, `propose_purchase`, hard cap of `8` tool calls), and Independent AI Intent Reviewer (separate invocation with isolated system prompt).
- **AI Cost Controls:** `24,000`-char bounded inputs, `maxOutputTokens` caps, abort timeouts + exponential backoff/jitter retries on transient `503`/`429` errors, per-session/per-IP SQLite rate limiting, and session-scoped `llm_output_cache` (`CACHED AI RESULT` badge).
- **Two Separate Human PayPal Actions:**
  1. **PayPal Buyer Approval (`payer-action`):** Buyer logs in on `sandbox.paypal.com` as the Sandbox Personal Buyer. `/paypal/return` runs live `GET /v2/checkout/orders/{id}` (verifying order ID, `APPROVED`, `AUTHORIZE`, `reference_id`, `custom_id`, currency, total, and items / `items_payload_hash`), executes `POST /authorize`, and verifies `GET /v2/payments/authorizations/{id}`.
  2. **Tollgate Human REVIEW Decision:** `ALLOW` proposals capture automatically upon verified authorization; `REVIEW` proposals pause after authorization (`CREATED`) until a human clicks **Approve & Capture** (`POST /capture`) or **Deny & Void Authorization** (`POST /void`) inside Tollgate.
- **Persistent Idempotency:** `payment_operations` stores a durable `PayPal-Request-Id` UUID and `request_payload_hash` before any PayPal mutation, reuses that UUID on retries, reconciles `PENDING`/`UNCERTAIN` states via live PayPal `GET` before retrying, and prevents conflicting `CAPTURE` vs `VOID` actions on the same authorization.

---

## Limitations, Security & Local Data Persistence

- **Local SQLite Persistence (`./data/tollgate.db`):** All sessions, mandates, proposals, page evidence, PayPal telemetry, and hash-chained ledger events persist locally on disk in SQLite WAL mode (`data/tollgate.db`, `data/tollgate.db-wal`, `data/tollgate.db-shm`). To back up an active database safely without missing uncommitted WAL pages, use SQLite's online backup API (e.g., `better-sqlite3`'s `.backup()`) rather than copying `tollgate.db` alone while `-wal` exists. To start completely clean, stop the server and either point `DATABASE_PATH` to a new file or remove local `data/tollgate.db*` files.
- **Tamper-Evident, Not Tamper-Proof:** The SHA-256 event ledger detects post-hoc row tampering within a session; unless checkpoints (`/api/ledger?export=checkpoint`) are exported outside the host, a local administrator with root access to SQLite could rewrite an entire chain from genesis.
- **Same LLM Family for Agent & Reviewer:** Both agent and reviewer invoke `gemini-3.5-flash-lite` under separated roles/prompts rather than two distinct AI vendors.
- **Sandbox / Evaluation Scope Only:** Tollgate is an educational/hackathon reference payment gateway for PayPal Sandbox evaluation. Do not use production funds without full user authentication, encrypted secret/token management, webhook reconciliation, and production security hardening.
- **Heuristic Provenance:** Provenance tags (`from_mandate`, `from_tool_result`, `from_page_text`, `from_agent_inference`) reflect observable text overlap rather than causal token attribution.

---

## License

MIT — see [`LICENSE`](LICENSE).
