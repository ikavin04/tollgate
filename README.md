# TOLLGATE

**Every AI purchase must pass the gate.**

Tollgate is an intent-verification and payment-authorization gateway that prevents AI shopping agents from executing unauthorized purchases by checking their proposed purchases against the original human instructions, enforcing deterministic spending policies, reviewing untrusted webpage content, and controlling PayPal Sandbox payment execution.

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

Tollgate separates untrusted product discovery from deterministic enforcement, independent AI intent inspection, and live PayPal payment execution:

1. **Mandate Compiler** ([`lib/mandate/compiler.ts`](lib/mandate/compiler.ts)) — Converts plain-English instructions into Zod-validated JSON ([`lib/mandate/schema.ts`](lib/mandate/schema.ts)), flags unsupported categories, conflicting constraints, missing budgets, and unresolved approved-brand lists before requiring explicit human confirmation.
2. **Controlled Fake Storefront** ([`lib/storefront/index.ts`](lib/storefront/index.ts)) — SQLite-seeded electronics catalog (`products`) containing normal listings and adversarial prompt-injection / contradictory-prose listings. Untrusted HTML/JS is never executed; hidden elements and HTML comments are converted to explicit plain text markers (`[HIDDEN_ELEMENT_TEXT]`, `[HTML_COMMENT]`).
3. **Isolated Shopping Agent** ([`lib/agent/shopping-agent.ts`](lib/agent/shopping-agent.ts)) — Restricted to three backend-validated tools: `search_store`, `read_page`, and `propose_purchase`. The agent submits only `product_id` and integer `quantity`; Tollgate resolves authoritative prices, SKUs, and warranty attributes from its catalog.
4. **Page Evidence Collector & Heuristic Provenance** ([`lib/evidence/index.ts`](lib/evidence/index.ts)) — Persists verbatim `read_page` output with SHA-256 hashes, enforces a 4,000-char/page and 16,000-char/review model bound, escalates truncated pages to `REVIEW`, and applies heuristic source tags (`from_mandate`, `from_tool_result`, `from_page_text`, `from_agent_inference`).
5. **Deterministic Policy Engine** ([`lib/policy/engine.ts`](lib/policy/engine.ts)) — Pure TypeScript rules evaluating budget (`max_total`), category (`gift_card` never authorized by `accessories_allowed`), allowed brands, product condition, quantity, currency, mandatory specs, approval thresholds (`approval_above`), ambiguous bundles, truncation flags, and structured soft preferences (e.g., 16 GB RAM preference with fallback condition check).
6. **Independent AI Intent Reviewer** ([`lib/reviewer/index.ts`](lib/reviewer/index.ts)) — Separate Gemini API invocation with isolated system instructions treating webpage content as untrusted quoted data. Evaluates contradictions between canonical catalog facts and untrusted prose. Fails closed to `REVIEW` on timeout, error, or malformed JSON. Combined precedence is strictly `BLOCK > REVIEW > ALLOW`.
7. **PayPal Payment Adapter** ([`lib/paypal/`](lib/paypal/index.ts)) — Server-only PayPal REST API v2 integration (`POST /v1/oauth2/token` with `expires_in`-driven caching, `POST /v2/checkout/orders` with `intent: "AUTHORIZE"`, `GET /v2/checkout/orders/{id}`, `POST /authorize`, `GET /v2/payments/authorizations/{id}`, `POST /capture`, `POST /void`), backed by persistent UUID idempotency in `payment_operations`.
8. **Tamper-Evident Evidence Ledger** ([`lib/ledger/index.ts`](lib/ledger/index.ts)) — Per-session SHA-256 hash chain `H_n = SHA256(H_previous + canonical_event_json)`, live verification, independent checkpoint exports, and downloadable JSON receipts.
9. **Session Isolation** ([`lib/session/index.ts`](lib/session/index.ts)) — Cryptographic anonymous session IDs via `HttpOnly`, `SameSite=Lax` cookies scoping every database read and mutation.

---

## Technology Stack

- **Frontend:** Next.js `16.4.6` (App Router), React `19.3.0`, TypeScript, Tailwind CSS v4, Lucide React
- **Backend:** Next.js App Router Route Handlers, Node.js (`v22.18.0`), Zod `4.6.7`
- **Database:** SQLite via `better-sqlite3` (`13` schema tables including migrations & rate-limit buckets)
- **AI:** Google Gemini API via `@google/genai` (`3.0.0`), Model ID: `gemini-3.5-flash-lite`
- **Payments:** PayPal REST API (Sandbox), Orders API v2, Payments API v2 (server-side REST redirects — no PayPal JS SDK mixing)
- **Integrity:** Node.js `crypto` (SHA-256, `randomUUID`, `randomBytes`)
- **Testing:** Vitest (`vitest run`)
- **Deployment Target:** Render (`render.yaml`)

---

## AI Models and Tools Used

- **Exact Gemini Model ID:** `gemini-3.5-flash-lite` (configured via `GEMINI_MODEL`)
- **Mandate Compiler:** `gemini-3.5-flash-lite` with JSON Schema structured output (`responseMimeType: "application/json"`) followed by strict Zod validation and deterministic ambiguity/conflict analysis.
- **Shopping Agent:** `gemini-3.5-flash-lite` with controlled function declarations (`search_store`, `read_page`, `propose_purchase`) and a hard cap of `8` tool calls.
- **Independent AI Intent Reviewer:** Separate `gemini-3.5-flash-lite` invocation with distinct system instructions (explicitly documented as the same model provider in an independent reviewer role, not a second independent model).
- **AI Cost Controls:** Bounded input characters (`24,000`), bounded `maxOutputTokens`, request abort timeouts, per-session & per-IP SQLite rate limiting, and session-scoped `llm_output_cache` (labeled `CACHED AI RESULT` in the UI). Provider-side Gemini API quotas remain authoritative across restarts.

---

## PayPal Integration Details

- **OAuth 2.0:** `POST /v1/oauth2/token` caches access tokens using PayPal's returned `expires_in` seconds with proactive refresh buffering and single-flight deduplication.
- **Order Creation:** Every order enforces `intent: "AUTHORIZE"`, server-generated `reference_id`, `custom_id`, currency, amount breakdown (`item_total`), canonical `items` array, and `payment_source.paypal.experience_context` pointing to `/paypal/return` and `/paypal/cancel` (`APP_BASE_URL`).
- **Two Separate Human Actions:**
  1. **PayPal Buyer Approval:** Buyer completes checkout via PayPal's `payer-action` URL. `/paypal/return` executes live `GET /v2/checkout/orders/{id}`, verifies order ID, `APPROVED` state, `AUTHORIZE` intent, `reference_id`, `custom_id`, currency, total amount, and `items` (when returned by PayPal; if omitted by PayPal, verifies returned amount/reference against the proposal and server-generated `items_payload_hash` without claiming PayPal echoed item fields), then authorizes (`POST /authorize`) and verifies authorization (`GET /v2/payments/authorizations/{id}`).
  2. **Tollgate Human REVIEW Decision:** `ALLOW` proposals capture automatically after verified authorization. `REVIEW` proposals pause after authorization (`CREATED`) until a human explicitly chooses **Approve & Capture** (`POST /capture`) or **Deny & Void Authorization** (`POST /void`) inside Tollgate.
- **Idempotency:** `payment_operations` persists a unique `PayPal-Request-Id` UUID and `request_payload_hash` per logical operation before calling PayPal, reuses the original UUID on retries, checks live PayPal resource state before retrying `UNCERTAIN` outcomes, and prevents duplicate captures or conflicting capture/void calls. PayPal operations are never cached in `llm_output_cache`.

---

## Local Installation & Environment Variables

1. Clone and enter the Next.js app directory (`e:\paypal\tollgate` / `tollgate/`):
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env.local` and supply your Sandbox & Gemini credentials:
   ```env
   PAYPAL_CLIENT_ID=
   PAYPAL_CLIENT_SECRET=
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com

   APP_BASE_URL=http://localhost:3000

   GEMINI_API_KEY=
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```
   `.env.local` is excluded from Git via `.gitignore` (`.env*` with `!.env.example`).
3. Start development or production server:
   ```bash
   npm run dev
   ```
4. Check runtime & environment readiness at `GET /api/health` (or `GET /api/health?verifyPaypalOAuth=true` to verify live Sandbox OAuth without exposing credentials).

---

## Sandbox Testing & Demo Guide

- See [`DEMO_GUIDE.md`](DEMO_GUIDE.md) for step-by-step walkthroughs of Scenarios A, B, C, and D.
- **Demo Credentials:** Use a dedicated PayPal **Sandbox Personal Buyer** account from your PayPal Developer Dashboard when redirected to `sandbox.paypal.com` checkout. Never publish merchant `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY`, OAuth access tokens, or live PayPal credentials.

---

## Attack Test Results & Automated Verification

Automated tests run via `npm test` (`vitest run`) using mocked PayPal/Gemini HTTP boundaries and an in-memory SQLite database (`:memory:`), covering 23 test cases across 3 test files (`test/phase1-paypal.test.ts`, `test/phase2-security-and-e2e.test.ts`, and `test/gemini-resilience.test.ts`):
- **Phase 1–3 PayPal & Foundation (`9` tests):** Environment validation without secret leakage, session isolation, SHA-256 ledger tamper detection, `BLOCK` order-creation prevention, PayPal amount/reference mismatch detection, omitted-items fallback verification, duplicate capture protection, `UNCERTAIN` timeout reconciliation preserving `PayPal-Request-Id`, and `REVIEW` capture/void gating.
- **Gemini Availability & Resilience (`5` tests):** 50s timeout, bounded exponential backoff + jitter retries on `503`/retryable `429`/timeouts, non-retry on permanent `4xx`/auth/quota errors, and fail-closed `REVIEW` preservation.
- **Phase 4–10 Security & E2E (`9` tests):** Valid & cached mandate compilation, ambiguous/unsupported/unresolved-brand detection, zero test-oracle leakage in agent/reviewer DTOs, deterministic price/category/gift-card/quantity/condition/16GB soft-preference rules, Scenarios A/C/D injection & warranty contradiction detection, reviewer timeout/malformed fail-closed to `REVIEW`, 4,000-char evidence truncation escalation, full E2E `ALLOW` capture + `REVIEW` human capture/void, and an honest deterministic-only attack benchmark (`3` caught / `1` missed when evaluating semantic warranty prose contradictions without the AI Reviewer layer, demonstrating why the dual Deterministic + AI Reviewer gate is necessary).

### Benchmark Classification Discipline
Tollgate distinguishes four separate security outcomes rather than collapsing them into a single "attack caught" count:
1. **Agent avoided a suspicious search result** (skipped during search without reading the page — not counted as page-injection resistance).
2. **Agent read and resisted a malicious page** (`page_evidence` confirms the page was fetched and read, yet the agent refused the injected instructions).
3. **Independent reviewer detected an attack** (the reviewer identified untrusted prose manipulation or canonical catalog contradiction and escalated to `REVIEW`/`BLOCK`).
4. **Deterministic policy blocked an unauthorized purchase** (hard-rule enforcement blocked an unauthorized proposal before PayPal regardless of AI decisions).

Live PayPal Sandbox checkout, authorization, capture, and void calls must be verified manually with real Sandbox credentials (`DEMO_GUIDE.md`), as automated unit tests mock network calls and never execute live financial voids/captures unattended.

---

## Limitations & Security Disclosures

- **Tamper-evident, not tamper-proof:** The SHA-256 event ledger detects database row tampering after the fact; unless checkpoints (`/api/ledger?export=checkpoint`) are exported externally, a host-root attacker could rewrite an entire local chain.
- **Ephemeral SQLite on Render Free Tier:** Local SQLite (`data/tollgate.db`) may reset after Render free-tier service restarts, cold starts, or redeployments. Free Render services also cold-start after inactivity.
- **Same LLM Family for Agent & Reviewer:** Both agent and reviewer invoke `gemini-3.5-flash-lite` (isolated prompts/roles), not two distinct model vendors.
- **Not a production fraud/escrow platform:** Tollgate is an educational/hackathon reference gateway demonstrating architectural isolation and payment-gating controls in PayPal Sandbox. Do not deploy with live funds without persistent encrypted storage, full merchant webhook reconciliation, user authentication, and security hardening.
- **Heuristic Provenance:** Provenance tags (`from_mandate`, `from_tool_result`, `from_page_text`, `from_agent_inference`) reflect observable overlap and do not prove causal token influence.

---

## Deployment (Render)

[`render.yaml`](render.yaml) configures a Node web service with `npm ci && npm run build`, `npm start`, and `/api/health` health checks. Set `APP_BASE_URL` to your deployed `https://<service>.onrender.com` URL and configure `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `GEMINI_API_KEY` as secret environment variables in the Render dashboard.

---

## License

MIT License — see [`LICENSE`](LICENSE).
