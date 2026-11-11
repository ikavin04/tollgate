import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { newUuid } from '@/lib/crypto';
import { openDatabase, setDbForTests } from '@/lib/db';
import { getEnvStatus } from '@/lib/env';
import {
  appendLedgerEvent,
  createLedgerCheckpoint,
  verifySessionLedger,
} from '@/lib/ledger';
import {
  approveReviewAndCapture,
  authorizePayPalOrder,
  captureVerifiedAuthorization,
  computeCanonicalItemsHash,
  createPayPalOrderForProposal,
  denyReviewAndVoid,
  executeIdempotentPayPalOperation,
  getAndVerifyPayPalOrder,
  invalidateCachedPayPalToken,
  PayPalIdempotencyConflictError,
  PayPalOrderVerificationError,
  PayPalWorkflowStateError,
  verifyPayPalOrderAgainstProposal,
  voidVerifiedAuthorization,
} from '@/lib/paypal';
import { assertSessionOwned, createSessionRecord, ResourceNotFoundError } from '@/lib/session';

function seedProposalForTest(
  db: Database.Database,
  options: {
    sessionId: string;
    finalDecision: 'ALLOW' | 'REVIEW' | 'BLOCK';
    productId?: string;
    quantity?: number;
  }
) {
  const productId = options.productId ?? 'prod-ns-devbook-16';
  const quantity = options.quantity ?? 1;

  const product = db
    .prepare('SELECT * FROM products WHERE id = ?')
    .get(productId) as {
    id: string;
    sku: string;
    name: string;
    category: string;
    price_cents: number;
    currency: string;
  };

  const mandateId = newUuid();
  const proposalId = newUuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO mandates (
      id, session_id, original_instruction, compiled_mandate_json, status,
      compiler_model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'CONFIRMED', 'gemini-3.5-flash-lite', ?, ?)`
  ).run(mandateId, options.sessionId, 'Buy one new laptop under $500', '{}', now, now);

  const lineTotal = product.price_cents * quantity;
  const itemsForHash = [
    {
      sku: product.sku,
      product_name: product.name,
      category: product.category,
      quantity,
      unit_price_cents: product.price_cents,
      line_total_cents: lineTotal,
      currency: product.currency,
    },
  ];
  const itemsHash = computeCanonicalItemsHash(itemsForHash, lineTotal, product.currency);

  const status =
    options.finalDecision === 'BLOCK'
      ? 'BLOCKED'
      : options.finalDecision === 'REVIEW'
        ? 'REVIEW_PENDING'
        : 'ALLOWED';

  db.prepare(
    `INSERT INTO proposals (
      id, session_id, mandate_id, status, agent_reasoning, provenance_json,
      currency, total_amount_cents, items_payload_hash, final_decision,
      human_decision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    proposalId,
    options.sessionId,
    mandateId,
    status,
    'Selected verified product.',
    product.currency,
    lineTotal,
    itemsHash,
    options.finalDecision,
    options.finalDecision === 'REVIEW' ? 'PENDING' : 'NOT_REQUIRED',
    now,
    now
  );

  db.prepare(
    `INSERT INTO proposal_items (
      id, session_id, proposal_id, product_id, sku, product_name, category,
      quantity, unit_price_cents, line_total_cents, currency, canonical_snapshot_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`
  ).run(
    newUuid(),
    options.sessionId,
    proposalId,
    product.id,
    product.sku,
    product.name,
    product.category,
    quantity,
    product.price_cents,
    lineTotal,
    product.currency,
    now
  );

  return { mandateId, proposalId, product, totalCents: lineTotal, itemsHash };
}

describe('Phase 1-3: Foundation, Session Isolation, Ledger, and PayPal Adapter', () => {
  let db: Database.Database;
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = openDatabase(':memory:');
    setDbForTests(db);
    invalidateCachedPayPalToken();

    process.env.PAYPAL_CLIENT_ID = 'sandbox-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'sandbox-super-secret';
    process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';
    process.env.APP_BASE_URL = 'http://localhost:3000';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    invalidateCachedPayPalToken();
    setDbForTests(undefined);
    db.close();
  });

  it('validates environment variables without revealing secret contents', () => {
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.GEMINI_API_KEY;

    const status = getEnvStatus();
    expect(status.ok).toBe(false);
    expect(status.missing).toContain('PAYPAL_CLIENT_SECRET');
    expect(status.missing).toContain('GEMINI_API_KEY');
    expect(JSON.stringify(status)).not.toContain('sandbox-super-secret');
    expect(JSON.stringify(status)).not.toContain('sandbox-client-id');
  });

  it('enforces strict session isolation across mandates and proposals', () => {
    const s1 = createSessionRecord(db, 'agent-1');
    const s2 = createSessionRecord(db, 'agent-2');
    const seeded = seedProposalForTest(db, {
      sessionId: s1.session.id,
      finalDecision: 'ALLOW',
    });

    const rowForS1 = db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(seeded.proposalId) as { session_id: string };

    expect(() => assertSessionOwned(rowForS1, s1.session.id, 'Proposal')).not.toThrow();
    expect(() => assertSessionOwned(rowForS1, s2.session.id, 'Proposal')).toThrow(
      ResourceNotFoundError
    );
  });

  it('verifies ledger hash chain integrity and detects tampering', () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'ALLOW',
    });

    appendLedgerEvent(db, {
      sessionId: session.id,
      proposalId: seeded.proposalId,
      eventType: 'PROPOSAL_CREATED',
      actor: 'AGENT',
      payload: { proposal_id: seeded.proposalId, amount_cents: seeded.totalCents },
    });

    const checkpoint = createLedgerCheckpoint(db, session.id);
    expect(checkpoint.event_count).toBe(2);

    const validResult = verifySessionLedger(db, session.id);
    expect(validResult.valid).toBe(true);
    expect(validResult.headHash).toBe(checkpoint.head_hash);

    // Tamper with a recorded payload directly in SQLite
    db.prepare(
      `UPDATE transaction_events SET payload_json = '{"amount_cents":1}' WHERE session_id = ? AND seq = 2`
    ).run(session.id);

    const tamperedResult = verifySessionLedger(db, session.id);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.tamperedEventSeq).toBe(2);
  });

  it('forbids PayPal order creation when final decision is BLOCK', async () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'BLOCK',
    });

    await expect(
      createPayPalOrderForProposal(db, session.id, seeded.proposalId)
    ).rejects.toThrow(PayPalWorkflowStateError);
  });

  it('detects PayPal amount mismatch and reference mismatch before authorization', () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'ALLOW',
    });

    const proposal = db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(seeded.proposalId) as never;
    const items = db
      .prepare('SELECT * FROM proposal_items WHERE proposal_id = ?')
      .all(seeded.proposalId) as never[];

    const payment = {
      id: newUuid(),
      session_id: session.id,
      proposal_id: seeded.proposalId,
      reference_id: 'TG-REF-001',
      custom_id: `proposal:${seeded.proposalId}`,
      currency: 'USD',
      expected_amount_cents: 44900,
      items_payload_hash: seeded.itemsHash,
      paypal_order_id: 'ORDER-123',
      paypal_order_status: 'CREATED',
      paypal_intent: 'AUTHORIZE',
      payer_action_url: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-123',
      paypal_authorization_id: null,
      paypal_authorization_status: null,
      paypal_capture_id: null,
      paypal_capture_status: null,
      paypal_void_status: null,
      verification_status: 'ORDER_CREATED',
      verification_notes_json: null,
      last_paypal_snapshot_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // 1. Amount mismatch
    const mismatchAmount = verifyPayPalOrderAgainstProposal({
      order: {
        id: 'ORDER-123',
        status: 'APPROVED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: 'TG-REF-001',
            custom_id: `proposal:${seeded.proposalId}`,
            amount: { currency_code: 'USD', value: '499.00' },
          },
        ],
      },
      payment,
      proposal,
      proposalItems: items,
    });
    expect(mismatchAmount.verified).toBe(false);
    expect(mismatchAmount.checks.find((c) => c.name === 'amount_match')?.passed).toBe(false);

    // 2. Reference mismatch
    const mismatchRef = verifyPayPalOrderAgainstProposal({
      order: {
        id: 'ORDER-123',
        status: 'APPROVED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: 'WRONG-REF',
            custom_id: `proposal:${seeded.proposalId}`,
            amount: { currency_code: 'USD', value: '449.00' },
          },
        ],
      },
      payment,
      proposal,
      proposalItems: items,
    });
    expect(mismatchRef.verified).toBe(false);
    expect(mismatchRef.checks.find((c) => c.name === 'reference_id_match')?.passed).toBe(false);

    // 3. Omitted items array uses local hash verification honestly without claiming PayPal returned items
    const omittedItemsOk = verifyPayPalOrderAgainstProposal({
      order: {
        id: 'ORDER-123',
        status: 'APPROVED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: 'TG-REF-001',
            custom_id: `proposal:${seeded.proposalId}`,
            amount: { currency_code: 'USD', value: '449.00' },
          },
        ],
      },
      payment,
      proposal,
      proposalItems: items,
    });
    expect(omittedItemsOk.verified).toBe(true);
    expect(omittedItemsOk.itemsVerificationMode).toBe(
      'LOCAL_HASH_ONLY_ITEMS_NOT_RETURNED_BY_PAYPAL'
    );
  });

  it('protects against duplicate captures, reuses PayPal-Request-Id, and executes ALLOW + REVIEW capture/void', async () => {
    const { session } = createSessionRecord(db);
    const allowSeeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'ALLOW',
    });

    let oauthCalls = 0;
    let capturePostCalls = 0;
    let voidPostCalls = 0;
    const seenRequestIds: string[] = [];

    let currentRefId = '';
    let currentCustomId = '';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['PayPal-Request-Id']) {
        seenRequestIds.push(headers['PayPal-Request-Id']);
      }

      if (url.endsWith('/v1/oauth2/token')) {
        oauthCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: 'mock-access-token',
            token_type: 'Bearer',
            expires_in: 32400,
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/checkout/orders') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        currentRefId = body.purchase_units[0].reference_id;
        currentCustomId = body.purchase_units[0].custom_id;
        return new Response(
          JSON.stringify({
            id: 'ORD-ALLOW-1',
            status: 'PAYER_ACTION_REQUIRED',
            intent: 'AUTHORIZE',
            links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD-ALLOW-1' }],
          }),
          { status: 201 }
        );
      }

      if (url.endsWith('/v2/checkout/orders/ORD-ALLOW-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'ORD-ALLOW-1',
            status: 'APPROVED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                reference_id: currentRefId,
                custom_id: currentCustomId,
                amount: { currency_code: 'USD', value: '449.00' },
                items: [
                  {
                    name: allowSeeded.product.name,
                    sku: allowSeeded.product.sku,
                    quantity: '1',
                    unit_amount: { currency_code: 'USD', value: '449.00' },
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/checkout/orders/ORD-ALLOW-1/authorize') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'ORD-ALLOW-1',
            status: 'COMPLETED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH-1',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: '449.00' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 201 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'AUTH-1',
            status: 'CREATED',
            amount: { currency_code: 'USD', value: '449.00' },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-1/capture') && method === 'POST') {
        capturePostCalls += 1;
        return new Response(
          JSON.stringify({
            id: 'CAP-1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '449.00' },
            final_capture: true,
          }),
          { status: 201 }
        );
      }

      if (url.endsWith('/v2/checkout/orders/ORD-REV-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'ORD-REV-1',
            status: 'APPROVED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                reference_id: currentRefId,
                custom_id: currentCustomId,
                amount: { currency_code: 'USD', value: '475.00' },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/checkout/orders/ORD-REV-1/authorize') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'ORD-REV-1',
            status: 'COMPLETED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH-REV-1',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: '475.00' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 201 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-REV-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'AUTH-REV-1',
            status: voidPostCalls > 0 ? 'VOIDED' : 'CREATED',
            amount: { currency_code: 'USD', value: '475.00' },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-REV-1/void') && method === 'POST') {
        voidPostCalls += 1;
        return new Response(null, { status: 204 });
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    // Run ALLOW flow end-to-end
    const created = await createPayPalOrderForProposal(db, session.id, allowSeeded.proposalId);
    expect(created.payerActionUrl).toContain('ORD-ALLOW-1');

    const verification = await getAndVerifyPayPalOrder(db, session.id, allowSeeded.proposalId);
    expect(verification.verified).toBe(true);
    expect(verification.itemsVerificationMode).toBe('PAYPAL_RETURNED_ITEMS_VERIFIED');

    await authorizePayPalOrder(db, session.id, allowSeeded.proposalId);
    const firstCapture = await captureVerifiedAuthorization(db, session.id, allowSeeded.proposalId);
    expect(firstCapture.capture.status).toBe('COMPLETED');
    expect(capturePostCalls).toBe(1);

    // Duplicate capture must NOT hit PayPal again (idempotent replay)
    const secondCapture = await captureVerifiedAuthorization(db, session.id, allowSeeded.proposalId);
    expect(secondCapture.replayedFromIdempotency).toBe(true);
    expect(capturePostCalls).toBe(1);

    // Attempting to VOID a captured payment must fail at workflow state layer
    await expect(voidVerifiedAuthorization(db, session.id, allowSeeded.proposalId)).rejects.toThrow(
      PayPalWorkflowStateError
    );

    // And idempotency layer itself rejects conflicting VOID when CAPTURE succeeded or mismatched payload
    await expect(
      executeIdempotentPayPalOperation({
        db,
        sessionId: session.id,
        proposalId: allowSeeded.proposalId,
        paymentId: null,
        operationType: 'VOID',
        logicalOperationKey: `VOID:${allowSeeded.proposalId}:AUTH-1`,
        requestPayload: { authorization_id: 'AUTH-1' },
        executeCall: async () => ({
          httpStatus: 204,
          resourceId: 'AUTH-1',
          responseData: {},
        }),
      })
    ).rejects.toThrow(PayPalIdempotencyConflictError);

    // OAuth token was cached across all calls
    expect(oauthCalls).toBe(1);

    // Now test REVIEW flow: cannot capture before human approval, then deny -> void!
    const reviewSeeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'REVIEW',
      productId: 'prod-ns-commuter-bundle',
    });

    // Update fetch mock to return ORD-REV-1 on second Create Order
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/checkout/orders') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        currentRefId = body.purchase_units[0].reference_id;
        currentCustomId = body.purchase_units[0].custom_id;
        return new Response(
          JSON.stringify({
            id: 'ORD-REV-1',
            status: 'PAYER_ACTION_REQUIRED',
            intent: 'AUTHORIZE',
            links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD-REV-1' }],
          }),
          { status: 201 }
        );
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    await createPayPalOrderForProposal(db, session.id, reviewSeeded.proposalId);
    await authorizePayPalOrder(db, session.id, reviewSeeded.proposalId);

    // Attempting capture without human approval fails
    await expect(
      captureVerifiedAuthorization(db, session.id, reviewSeeded.proposalId)
    ).rejects.toThrow(PayPalWorkflowStateError);

    // Deny in Tollgate -> executes PayPal Void (handles 204 No Content + GET verification)
    const denied = await denyReviewAndVoid(db, session.id, reviewSeeded.proposalId, 'Suspicious bundle');
    expect(denied.voided).toBe(true);
    expect(denied.payment?.verification_status).toBe('VOIDED');
    expect(voidPostCalls).toBe(1);

    // Verify ledger remained valid throughout all operations
    const ledger = verifySessionLedger(db, session.id);
    expect(ledger.valid).toBe(true);
    expect(ledger.eventCount).toBeGreaterThanOrEqual(7);
  });

  it('reconciles remote PayPal capture status on retry after an UNCERTAIN timeout without changing PayPal-Request-Id', async () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'ALLOW',
    });

    const now = new Date().toISOString();
    const paymentId = newUuid();
    db.prepare(
      `INSERT INTO payments (
        id, session_id, proposal_id, reference_id, custom_id, currency,
        expected_amount_cents, items_payload_hash, paypal_order_id, paypal_order_status,
        paypal_intent, paypal_authorization_id, paypal_authorization_status,
        verification_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'REF-TIMEOUT', ?, 'USD', ?, ?, 'ORD-TO-1', 'APPROVED', 'AUTHORIZE', 'AUTH-TO-1', 'CREATED', 'AUTHORIZED', ?, ?)`
    ).run(paymentId, session.id, seeded.proposalId, `proposal:${seeded.proposalId}`, seeded.totalCents, seeded.itemsHash, now, now);

    let captureAttempts = 0;
    let reconciled = false;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 32400 }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-TO-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'AUTH-TO-1',
            status: 'CREATED',
            amount: { currency_code: 'USD', value: '449.00' },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/v2/payments/authorizations/AUTH-TO-1/capture') && method === 'POST') {
        captureAttempts += 1;
        throw new Error('The operation timed out');
      }

      if (url.endsWith('/v2/checkout/orders/ORD-TO-1') && method === 'GET') {
        reconciled = true;
        return new Response(
          JSON.stringify({
            id: 'ORD-TO-1',
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: 'CAP-RECOVERED-1',
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value: '449.00' },
                      final_capture: true,
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    await expect(captureVerifiedAuthorization(db, session.id, seeded.proposalId)).rejects.toThrow(
      /uncertain/i
    );

    const opAfterTimeout = db
      .prepare('SELECT * FROM payment_operations WHERE proposal_id = ?')
      .get(seeded.proposalId) as { paypal_request_id: string; operation_status: string; attempt_count: number };
    expect(opAfterTimeout.operation_status).toBe('UNCERTAIN');

    // Retry should check PayPal order/capture state first, find CAP-RECOVERED-1, and preserve exact paypal_request_id!
    const recovered = await captureVerifiedAuthorization(db, session.id, seeded.proposalId);
    expect(reconciled).toBe(true);
    expect(captureAttempts).toBe(1);
    expect(recovered.capture.id).toBe('CAP-RECOVERED-1');
    expect(recovered.replayedFromIdempotency).toBe(true);

    const opAfterRecovery = db
      .prepare('SELECT * FROM payment_operations WHERE proposal_id = ?')
      .get(seeded.proposalId) as { paypal_request_id: string; operation_status: string; attempt_count: number };
    expect(opAfterRecovery.paypal_request_id).toBe(opAfterTimeout.paypal_request_id);
    expect(opAfterRecovery.operation_status).toBe('SUCCEEDED');
    expect(opAfterRecovery.attempt_count).toBe(2);
  });

  it('rejects REVIEW capture helper before buyer PayPal authorization and approves cleanly after authorization', async () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'REVIEW',
      productId: 'prod-ns-commuter-bundle',
    });

    await expect(approveReviewAndCapture(db, session.id, seeded.proposalId)).rejects.toThrow(
      PayPalWorkflowStateError
    );
  });

  it('rejects PayPal Get Order mismatch via PayPalOrderVerificationError', async () => {
    const { session } = createSessionRecord(db);
    const seeded = seedProposalForTest(db, {
      sessionId: session.id,
      finalDecision: 'ALLOW',
    });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO payments (
        id, session_id, proposal_id, reference_id, custom_id, currency,
        expected_amount_cents, items_payload_hash, paypal_order_id, paypal_order_status,
        paypal_intent, verification_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'REF-OK', ?, 'USD', ?, ?, 'ORD-BAD-1', 'CREATED', 'AUTHORIZE', 'ORDER_CREATED', ?, ?)`
    ).run(newUuid(), session.id, seeded.proposalId, `proposal:${seeded.proposalId}`, seeded.totalCents, seeded.itemsHash, now, now);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 32400 }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          id: 'ORD-BAD-1',
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              reference_id: 'REF-TAMPERED',
              custom_id: `proposal:${seeded.proposalId}`,
              amount: { currency_code: 'USD', value: '449.00' },
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    await expect(getAndVerifyPayPalOrder(db, session.id, seeded.proposalId)).rejects.toThrow(
      PayPalOrderVerificationError
    );
  });
});
