import 'server-only';
import type Database from 'better-sqlite3';
import { formatCents, newUuid, parseMoneyToCents, sha256Canonical } from '@/lib/crypto';
import { getPayPalConfig } from '@/lib/env';
import { appendLedgerEvent } from '@/lib/ledger';
import { assertSessionOwned } from '@/lib/session';
import { executeIdempotentPayPalOperation, paypalHttpRequest } from './client';
import {
  PayPalApiError,
  PayPalOrderVerificationError,
  type OrderVerificationCheck,
  type OrderVerificationResult,
  type PaymentRow,
  type PayPalAuthorizationResource,
  type PayPalOrderItem,
  type PayPalOrderResource,
} from './types';

export interface ProposalSummaryRow {
  id: string;
  session_id: string;
  mandate_id: string;
  status: string;
  currency: string;
  total_amount_cents: number;
  items_payload_hash: string;
  final_decision: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
  human_decision: string;
}

export interface ProposalItemRow {
  id: string;
  session_id: string;
  proposal_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  category: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  currency: string;
}

export class PayPalWorkflowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalWorkflowStateError';
  }
}

export function mapPayPalItemCategory(
  category: string
): 'DIGITAL_GOODS' | 'PHYSICAL_GOODS' {
  return category === 'gift_card' ? 'DIGITAL_GOODS' : 'PHYSICAL_GOODS';
}

export function computeCanonicalItemsHash(
  items: Array<{
    sku: string;
    product_name: string;
    category: string;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
    currency: string;
  }>,
  totalAmountCents: number,
  currency: string
): string {
  return sha256Canonical({
    currency,
    total_amount_cents: totalAmountCents,
    items: items.map((item) => ({
      sku: item.sku,
      name: item.product_name.slice(0, 127),
      category: mapPayPalItemCategory(item.category),
      quantity: item.quantity,
      unit_price_cents: item.unit_price_cents,
      line_total_cents: item.line_total_cents,
      currency: item.currency,
    })),
  });
}

function loadProposalAndItems(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): { proposal: ProposalSummaryRow; items: ProposalItemRow[] } {
  const proposal = assertSessionOwned(
    db
      .prepare('SELECT * FROM proposals WHERE id = ? AND session_id = ?')
      .get(proposalId, sessionId) as ProposalSummaryRow | undefined,
    sessionId,
    'Proposal'
  );

  const items = db
    .prepare('SELECT * FROM proposal_items WHERE proposal_id = ? AND session_id = ? ORDER BY created_at ASC')
    .all(proposalId, sessionId) as ProposalItemRow[];

  if (items.length === 0) {
    throw new PayPalWorkflowStateError(`Proposal ${proposalId} has no items`);
  }

  return { proposal, items };
}

export function getPaymentByProposalId(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): PaymentRow | null {
  const row = db
    .prepare('SELECT * FROM payments WHERE proposal_id = ? AND session_id = ?')
    .get(proposalId, sessionId) as PaymentRow | undefined;
  return row ?? null;
}

export function getPaymentByOrderId(
  db: Database.Database,
  sessionId: string,
  paypalOrderId: string
): PaymentRow | null {
  const row = db
    .prepare('SELECT * FROM payments WHERE paypal_order_id = ? AND session_id = ?')
    .get(paypalOrderId, sessionId) as PaymentRow | undefined;
  return row ?? null;
}

export function buildCreateOrderPayload(options: {
  proposal: ProposalSummaryRow;
  items: ProposalItemRow[];
  referenceId: string;
  customId: string;
  appBaseUrl: string;
}) {
  const { proposal, items, referenceId, customId, appBaseUrl } = options;

  const computedSumCents = items.reduce((acc, item) => acc + item.line_total_cents, 0);
  if (computedSumCents !== proposal.total_amount_cents) {
    throw new PayPalWorkflowStateError(
      `Proposal item total mismatch: items sum (${computedSumCents}) != total_amount_cents (${proposal.total_amount_cents})`
    );
  }

  const paypalItems: PayPalOrderItem[] = items.map((item) => ({
    name: item.product_name.slice(0, 127),
    sku: item.sku.slice(0, 127),
    unit_amount: {
      currency_code: item.currency,
      value: formatCents(item.unit_price_cents),
    },
    quantity: String(item.quantity),
    category: mapPayPalItemCategory(item.category),
  }));

  const totalStr = formatCents(proposal.total_amount_cents);

  return {
    intent: 'AUTHORIZE' as const,
    purchase_units: [
      {
        reference_id: referenceId,
        custom_id: customId,
        description: `Tollgate protected order (${proposal.id.slice(0, 8)})`,
        amount: {
          currency_code: proposal.currency,
          value: totalStr,
          breakdown: {
            item_total: {
              currency_code: proposal.currency,
              value: totalStr,
            },
          },
        },
        items: paypalItems,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          brand_name: 'Tollgate Protected Checkout',
          locale: 'en-US',
          landing_page: 'LOGIN',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: `${appBaseUrl}/paypal/return`,
          cancel_url: `${appBaseUrl}/paypal/cancel`,
        },
      },
    },
  };
}

function extractPayerActionUrl(order: PayPalOrderResource): string | null {
  const payerAction = order.links?.find((l) => l.rel === 'payer-action');
  if (payerAction?.href) return payerAction.href;
  const approve = order.links?.find((l) => l.rel === 'approve');
  return approve?.href ?? null;
}

/**
 * Creates a PayPal AUTHORIZE order for an ALLOW or REVIEW proposal.
 * Strictly forbids BLOCKed proposals from creating PayPal orders.
 */
export async function createPayPalOrderForProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): Promise<{
  payment: PaymentRow;
  order: PayPalOrderResource;
  payerActionUrl: string;
  replayedFromIdempotency: boolean;
}> {
  const { proposal, items } = loadProposalAndItems(db, sessionId, proposalId);

  if (proposal.final_decision !== 'ALLOW' && proposal.final_decision !== 'REVIEW') {
    throw new PayPalWorkflowStateError(
      `Cannot create PayPal order for proposal in decision "${proposal.final_decision ?? 'UNDECIDED'}". Blocked proposals cannot touch PayPal.`
    );
  }

  const recomputedHash = computeCanonicalItemsHash(
    items,
    proposal.total_amount_cents,
    proposal.currency
  );
  if (recomputedHash !== proposal.items_payload_hash) {
    throw new PayPalWorkflowStateError('Proposal items payload hash verification failed locally.');
  }

  const config = getPayPalConfig();

  // Create or load durable payment record BEFORE calling PayPal so reference_id/custom_id stay stable across retries.
  let payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!payment) {
    const now = new Date().toISOString();
    const newPayment: PaymentRow = {
      id: newUuid(),
      session_id: sessionId,
      proposal_id: proposalId,
      reference_id: `TG-${proposalId.slice(0, 8)}-${newUuid().slice(0, 6)}`.toUpperCase(),
      custom_id: `proposal:${proposalId}`,
      currency: proposal.currency,
      expected_amount_cents: proposal.total_amount_cents,
      items_payload_hash: proposal.items_payload_hash,
      paypal_order_id: null,
      paypal_order_status: null,
      paypal_intent: 'AUTHORIZE',
      payer_action_url: null,
      paypal_authorization_id: null,
      paypal_authorization_status: null,
      paypal_capture_id: null,
      paypal_capture_status: null,
      paypal_void_status: null,
      verification_status: 'NOT_STARTED',
      verification_notes_json: null,
      last_paypal_snapshot_json: null,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO payments (
        id, session_id, proposal_id, reference_id, custom_id, currency,
        expected_amount_cents, items_payload_hash, paypal_order_id, paypal_order_status,
        paypal_intent, payer_action_url, paypal_authorization_id, paypal_authorization_status,
        paypal_capture_id, paypal_capture_status, paypal_void_status, verification_status,
        verification_notes_json, last_paypal_snapshot_json, created_at, updated_at
      ) VALUES (
        @id, @session_id, @proposal_id, @reference_id, @custom_id, @currency,
        @expected_amount_cents, @items_payload_hash, @paypal_order_id, @paypal_order_status,
        @paypal_intent, @payer_action_url, @paypal_authorization_id, @paypal_authorization_status,
        @paypal_capture_id, @paypal_capture_status, @paypal_void_status, @verification_status,
        @verification_notes_json, @last_paypal_snapshot_json, @created_at, @updated_at
      )`
    ).run(newPayment);

    payment = newPayment;
  }

  const orderPayload = buildCreateOrderPayload({
    proposal,
    items,
    referenceId: payment.reference_id,
    customId: payment.custom_id,
    appBaseUrl: config.appBaseUrl,
  });

  const { result: order, replayedFromIdempotency } =
    await executeIdempotentPayPalOperation<PayPalOrderResource>({
      db,
      sessionId,
      proposalId,
      paymentId: payment.id,
      operationType: 'CREATE_ORDER',
      logicalOperationKey: `CREATE_ORDER:${proposalId}`,
      requestPayload: orderPayload,
      executeCall: async (payPalRequestId) => {
        const res = await paypalHttpRequest<PayPalOrderResource>({
          method: 'POST',
          path: '/v2/checkout/orders',
          body: orderPayload,
          payPalRequestId,
          preferRepresentation: true,
        });
        if (!res.data || !res.data.id) {
          throw new PayPalApiError('PayPal Create Order returned an empty response', {
            httpStatus: res.status,
            rawPayload: res.data,
          });
        }
        return {
          httpStatus: res.status,
          resourceId: res.data.id,
          responseData: res.data,
        };
      },
    });

  const payerActionUrl = extractPayerActionUrl(order);
  if (!payerActionUrl) {
    throw new PayPalApiError(
      `PayPal Create Order ${order.id} succeeded (${order.status}) but returned no payer-action or approve link`,
      {
        httpStatus: 502,
        rawPayload: order,
      }
    );
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE payments
     SET paypal_order_id = ?,
         paypal_order_status = ?,
         paypal_intent = ?,
         payer_action_url = ?,
         verification_status = CASE
           WHEN verification_status = 'NOT_STARTED' THEN 'ORDER_CREATED'
           ELSE verification_status
         END,
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    order.id,
    order.status,
    order.intent,
    payerActionUrl,
    JSON.stringify(order),
    now,
    payment.id,
    sessionId
  );

  if (!replayedFromIdempotency) {
    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'PAYPAL_ORDER_CREATED',
      actor: 'PAYPAL',
      payload: {
        payment_id: payment.id,
        paypal_order_id: order.id,
        order_status: order.status,
        intent: order.intent,
        reference_id: payment.reference_id,
        custom_id: payment.custom_id,
        amount: formatCents(payment.expected_amount_cents),
        currency: payment.currency,
      },
    });
  }

  const updatedPayment = getPaymentByProposalId(db, sessionId, proposalId)!;
  return {
    payment: updatedPayment,
    order,
    payerActionUrl,
    replayedFromIdempotency,
  };
}

/**
 * Pure verification of a PayPal Order response against stored Tollgate proposal & payment state.
 * Handles both cases: when PayPal returns purchase_units[0].items and when PayPal omits items.
 */
export function verifyPayPalOrderAgainstProposal(options: {
  order: PayPalOrderResource;
  payment: PaymentRow;
  proposal: ProposalSummaryRow;
  proposalItems: ProposalItemRow[];
  expectedStatuses?: string[];
}): OrderVerificationResult {
  const { order, payment, proposal, proposalItems } = options;
  const expectedStatuses = options.expectedStatuses ?? ['APPROVED'];
  const checks: OrderVerificationCheck[] = [];

  checks.push({
    name: 'order_id_match',
    passed: Boolean(payment.paypal_order_id && order.id === payment.paypal_order_id),
    detail: `Expected order ID ${payment.paypal_order_id}, got ${order.id}`,
  });

  checks.push({
    name: 'order_status',
    passed: expectedStatuses.includes(order.status),
    detail: `Expected order status in [${expectedStatuses.join(', ')}], got ${order.status}`,
  });

  checks.push({
    name: 'order_intent',
    passed: order.intent === 'AUTHORIZE',
    detail: `Expected intent AUTHORIZE, got ${order.intent}`,
  });

  const units = order.purchase_units ?? [];
  checks.push({
    name: 'purchase_unit_count',
    passed: units.length === 1,
    detail: `Expected 1 purchase_unit, got ${units.length}`,
  });

  const pu = units[0];
  checks.push({
    name: 'reference_id_match',
    passed: Boolean(pu && pu.reference_id === payment.reference_id),
    detail: `Expected reference_id ${payment.reference_id}, got ${pu?.reference_id ?? 'MISSING'}`,
  });

  checks.push({
    name: 'custom_id_match',
    passed: Boolean(pu && pu.custom_id === payment.custom_id),
    detail: `Expected custom_id ${payment.custom_id}, got ${pu?.custom_id ?? 'MISSING'}`,
  });

  checks.push({
    name: 'currency_match',
    passed: Boolean(pu?.amount?.currency_code === payment.currency),
    detail: `Expected currency ${payment.currency}, got ${pu?.amount?.currency_code ?? 'MISSING'}`,
  });

  let actualAmountCents: number | null = null;
  let amountParseError: string | null = null;
  if (pu?.amount?.value) {
    try {
      actualAmountCents = parseMoneyToCents(pu.amount.value);
    } catch (err) {
      amountParseError = err instanceof Error ? err.message : 'Invalid amount';
    }
  }
  checks.push({
    name: 'amount_match',
    passed: actualAmountCents !== null && actualAmountCents === payment.expected_amount_cents,
    detail: amountParseError
      ? amountParseError
      : `Expected ${formatCents(payment.expected_amount_cents)} ${payment.currency}, got ${pu?.amount?.value ?? 'MISSING'}`,
  });

  const recomputedLocalHash = computeCanonicalItemsHash(
    proposalItems,
    proposal.total_amount_cents,
    proposal.currency
  );
  checks.push({
    name: 'local_items_hash_match',
    passed:
      recomputedLocalHash === payment.items_payload_hash &&
      recomputedLocalHash === proposal.items_payload_hash,
    detail:
      recomputedLocalHash === payment.items_payload_hash
        ? `Server items payload hash verified (${recomputedLocalHash.slice(0, 16)}...)`
        : 'Server items payload hash mismatch',
  });

  let itemsVerificationMode: OrderVerificationResult['itemsVerificationMode'] =
    'LOCAL_HASH_ONLY_ITEMS_NOT_RETURNED_BY_PAYPAL';

  if (Array.isArray(pu?.items) && pu.items.length > 0) {
    itemsVerificationMode = 'PAYPAL_RETURNED_ITEMS_VERIFIED';

    const countMatch = pu.items.length === proposalItems.length;
    checks.push({
      name: 'paypal_items_count_match',
      passed: countMatch,
      detail: `Expected ${proposalItems.length} items, PayPal returned ${pu.items.length}`,
    });

    if (countMatch) {
      const remaining = [...proposalItems];
      let allItemsMatched = true;
      const mismatchDetails: string[] = [];

      for (const returnedItem of pu.items) {
        let returnedUnitCents = -1;
        try {
          returnedUnitCents = returnedItem.unit_amount?.value
            ? parseMoneyToCents(returnedItem.unit_amount.value)
            : -1;
        } catch {
          returnedUnitCents = -1;
        }
        const returnedQty = Number.parseInt(returnedItem.quantity, 10);

        const matchIdx = remaining.findIndex(
          (expected) =>
            expected.sku.slice(0, 127) === (returnedItem.sku ?? '') &&
            expected.quantity === returnedQty &&
            expected.unit_price_cents === returnedUnitCents &&
            expected.currency === returnedItem.unit_amount?.currency_code &&
            expected.product_name.slice(0, 127) === returnedItem.name
        );

        if (matchIdx === -1) {
          allItemsMatched = false;
          mismatchDetails.push(
            `Returned item mismatch (sku=${returnedItem.sku ?? 'none'}, qty=${returnedItem.quantity}, unit=${returnedItem.unit_amount?.value ?? 'none'})`
          );
        } else {
          remaining.splice(matchIdx, 1);
        }
      }

      checks.push({
        name: 'paypal_items_fields_match',
        passed: allItemsMatched,
        detail: allItemsMatched
          ? `All ${pu.items.length} PayPal-returned item(s) matched SKU, name, quantity, currency, and unit price`
          : mismatchDetails.join('; '),
      });
    }
  } else {
    checks.push({
      name: 'paypal_items_omitted_fallback',
      passed: true,
      detail:
        'PayPal Get Order omitted the items array; verified returned total amount, currency, reference_id, custom_id, and stored server-generated items_payload_hash without claiming PayPal echoed item fields.',
    });
  }

  const verified = checks.every((c) => c.passed);
  return {
    verified,
    itemsVerificationMode,
    checks,
    order,
  };
}

/**
 * Calls live PayPal GET /v2/checkout/orders/{id} and verifies against the session's proposal.
 */
export async function getAndVerifyPayPalOrder(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  expectedStatuses: string[] = ['APPROVED']
): Promise<OrderVerificationResult> {
  const { proposal, items } = loadProposalAndItems(db, sessionId, proposalId);
  const payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!payment || !payment.paypal_order_id) {
    throw new PayPalWorkflowStateError(`No PayPal order created for proposal ${proposalId}`);
  }

  const res = await paypalHttpRequest<PayPalOrderResource>({
    method: 'GET',
    path: `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}`,
  });

  if (!res.data) {
    throw new PayPalApiError('PayPal Get Order returned empty body', {
      httpStatus: res.status,
    });
  }

  const verification = verifyPayPalOrderAgainstProposal({
    order: res.data,
    payment,
    proposal,
    proposalItems: items,
    expectedStatuses,
  });

  const now = new Date().toISOString();
  if (!verification.verified) {
    const failedSummary = verification.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.name}: ${c.detail}`)
      .join(' | ');

    db.prepare(
      `UPDATE payments
       SET paypal_order_status = ?,
           verification_status = 'MISMATCH_BLOCKED',
           verification_notes_json = ?,
           last_paypal_snapshot_json = ?,
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      res.data.status,
      JSON.stringify({
        itemsVerificationMode: verification.itemsVerificationMode,
        checks: verification.checks,
      }),
      JSON.stringify(res.data),
      now,
      payment.id,
      sessionId
    );

    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'PAYPAL_VERIFICATION_FAILED',
      actor: 'TOLLGATE',
      payload: {
        stage: 'GET_ORDER',
        paypal_order_id: payment.paypal_order_id,
        failed_checks: verification.checks.filter((c) => !c.passed),
      },
    });

    throw new PayPalOrderVerificationError(
      `PayPal order verification failed: ${failedSummary}`,
      verification.checks
    );
  }

  const wasAlreadyVerified =
    payment.verification_status === 'ORDER_VERIFIED' ||
    payment.verification_status === 'AUTHORIZED' ||
    payment.verification_status === 'CAPTURED' ||
    payment.verification_status === 'VOIDED';

  db.prepare(
    `UPDATE payments
     SET paypal_order_status = ?,
         verification_status = CASE
           WHEN verification_status IN ('NOT_STARTED', 'ORDER_CREATED') THEN 'ORDER_VERIFIED'
           ELSE verification_status
         END,
         verification_notes_json = ?,
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    res.data.status,
    JSON.stringify({
      itemsVerificationMode: verification.itemsVerificationMode,
      checks: verification.checks,
    }),
    JSON.stringify(res.data),
    now,
    payment.id,
    sessionId
  );

  if (!wasAlreadyVerified && res.data.status === 'APPROVED') {
    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'BUYER_APPROVED',
      actor: 'USER',
      payload: {
        paypal_order_id: res.data.id,
        order_status: res.data.status,
        items_verification_mode: verification.itemsVerificationMode,
      },
    });
  }

  return verification;
}

/**
 * Verifies the approved PayPal order, then authorizes it via POST /v2/checkout/orders/{id}/authorize.
 */
export async function authorizePayPalOrder(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): Promise<{
  payment: PaymentRow;
  authorization: PayPalAuthorizationResource;
  replayedFromIdempotency: boolean;
}> {
  const { proposal } = loadProposalAndItems(db, sessionId, proposalId);
  if (proposal.final_decision !== 'ALLOW' && proposal.final_decision !== 'REVIEW') {
    throw new PayPalWorkflowStateError(
      `Cannot authorize proposal in decision "${proposal.final_decision ?? 'UNDECIDED'}"`
    );
  }

  const currentPayment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!currentPayment || !currentPayment.paypal_order_id) {
    throw new PayPalWorkflowStateError(`No PayPal order found for proposal ${proposalId}`);
  }

  // If not yet authorized, require live Get Order verification in APPROVED status first.
  if (!currentPayment.paypal_authorization_id) {
    await getAndVerifyPayPalOrder(db, sessionId, proposalId, ['APPROVED']);
  }

  const orderId = currentPayment.paypal_order_id;
  const authorizePayload = { order_id: orderId };

  const { result: authorizedOrder, replayedFromIdempotency } =
    await executeIdempotentPayPalOperation<PayPalOrderResource>({
      db,
      sessionId,
      proposalId,
      paymentId: currentPayment.id,
      operationType: 'AUTHORIZE',
      logicalOperationKey: `AUTHORIZE:${proposalId}:${orderId}`,
      requestPayload: authorizePayload,
      reconcileExisting: async () => {
        const check = await paypalHttpRequest<PayPalOrderResource>({
          method: 'GET',
          path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        });
        const existingAuth = check.data?.purchase_units?.[0]?.payments?.authorizations?.[0];
        if (check.data && existingAuth?.id) {
          return {
            resolved: true,
            resourceId: existingAuth.id,
            responseData: check.data,
            httpStatus: check.status,
          };
        }
        return { resolved: false };
      },
      executeCall: async (payPalRequestId) => {
        const res = await paypalHttpRequest<PayPalOrderResource>({
          method: 'POST',
          path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
          body: {},
          payPalRequestId,
          preferRepresentation: true,
        });
        const auth = res.data?.purchase_units?.[0]?.payments?.authorizations?.[0];
        if (!res.data || !auth?.id) {
          throw new PayPalApiError(
            'PayPal Authorize Order response missing purchase_units[0].payments.authorizations[0]',
            {
              httpStatus: res.status,
              rawPayload: res.data,
            }
          );
        }
        return {
          httpStatus: res.status,
          resourceId: auth.id,
          responseData: res.data,
        };
      },
    });

  const authorization = authorizedOrder.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authorization?.id) {
    throw new PayPalApiError('Authorized order missing authorization resource', {
      httpStatus: 502,
      rawPayload: authorizedOrder,
    });
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE payments
     SET paypal_order_status = ?,
         paypal_authorization_id = ?,
         paypal_authorization_status = ?,
         verification_status = CASE
           WHEN verification_status IN ('CAPTURED', 'VOIDED') THEN verification_status
           ELSE 'AUTHORIZED'
         END,
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    authorizedOrder.status,
    authorization.id,
    authorization.status,
    JSON.stringify(authorizedOrder),
    now,
    currentPayment.id,
    sessionId
  );

  if (!replayedFromIdempotency) {
    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'AUTHORIZATION_CREATED',
      actor: 'PAYPAL',
      payload: {
        paypal_order_id: orderId,
        paypal_authorization_id: authorization.id,
        authorization_status: authorization.status,
        amount: authorization.amount?.value ?? formatCents(currentPayment.expected_amount_cents),
        currency: authorization.amount?.currency_code ?? currentPayment.currency,
      },
    });
  }

  return {
    payment: getPaymentByProposalId(db, sessionId, proposalId)!,
    authorization,
    replayedFromIdempotency,
  };
}

