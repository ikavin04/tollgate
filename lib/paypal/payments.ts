import 'server-only';
import type Database from 'better-sqlite3';
import { formatCents, parseMoneyToCents } from '@/lib/crypto';
import { appendLedgerEvent } from '@/lib/ledger';
import { assertSessionOwned } from '@/lib/session';
import { executeIdempotentPayPalOperation, paypalHttpRequest } from './client';
import {
  authorizePayPalOrder,
  getPaymentByProposalId,
  PayPalWorkflowStateError,
  type ProposalSummaryRow,
} from './orders';
import {
  PayPalApiError,
  PayPalOrderVerificationError,
  type OrderVerificationCheck,
  type PaymentRow,
  type PayPalAuthorizationResource,
  type PayPalCaptureResource,
} from './types';

function loadProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): ProposalSummaryRow {
  return assertSessionOwned(
    db
      .prepare('SELECT * FROM proposals WHERE id = ? AND session_id = ?')
      .get(proposalId, sessionId) as ProposalSummaryRow | undefined,
    sessionId,
    'Proposal'
  );
}

/**
 * Pure verification of PayPal Authorization details against stored Tollgate payment expectations.
 */
export function verifyAuthorizationResource(
  auth: PayPalAuthorizationResource,
  payment: PaymentRow,
  expectedStatuses: string[] = ['CREATED']
): OrderVerificationCheck[] {
  const checks: OrderVerificationCheck[] = [];

  checks.push({
    name: 'authorization_id_match',
    passed: Boolean(payment.paypal_authorization_id && auth.id === payment.paypal_authorization_id),
    detail: `Expected authorization ID ${payment.paypal_authorization_id}, got ${auth.id}`,
  });

  checks.push({
    name: 'authorization_status',
    passed: expectedStatuses.includes(auth.status),
    detail: `Expected authorization status in [${expectedStatuses.join(', ')}], got ${auth.status}`,
  });

  checks.push({
    name: 'authorization_currency_match',
    passed: Boolean(auth.amount?.currency_code === payment.currency),
    detail: `Expected currency ${payment.currency}, got ${auth.amount?.currency_code ?? 'MISSING'}`,
  });

  let actualCents: number | null = null;
  let parseErr: string | null = null;
  if (auth.amount?.value) {
    try {
      actualCents = parseMoneyToCents(auth.amount.value);
    } catch (err) {
      parseErr = err instanceof Error ? err.message : 'Invalid amount';
    }
  }

  checks.push({
    name: 'authorization_amount_match',
    passed: actualCents !== null && actualCents === payment.expected_amount_cents,
    detail: parseErr
      ? parseErr
      : `Expected ${formatCents(payment.expected_amount_cents)} ${payment.currency}, got ${auth.amount?.value ?? 'MISSING'}`,
  });

  return checks;
}

/**
 * Fetches live authorization details via GET /v2/payments/authorizations/{id} and verifies ID, status, amount, currency.
 */
export async function getAndVerifyAuthorization(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  expectedStatuses: string[] = ['CREATED']
): Promise<PayPalAuthorizationResource> {
  const payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!payment || !payment.paypal_authorization_id) {
    throw new PayPalWorkflowStateError(
      `No PayPal authorization found for proposal ${proposalId}`
    );
  }

  const res = await paypalHttpRequest<PayPalAuthorizationResource>({
    method: 'GET',
    path: `/v2/payments/authorizations/${encodeURIComponent(payment.paypal_authorization_id)}`,
  });

  if (!res.data) {
    throw new PayPalApiError('PayPal Get Authorization returned an empty response', {
      httpStatus: res.status,
    });
  }

  const checks = verifyAuthorizationResource(res.data, payment, expectedStatuses);
  const verified = checks.every((c) => c.passed);

  if (!verified) {
    const failedSummary = checks
      .filter((c) => !c.passed)
      .map((c) => `${c.name}: ${c.detail}`)
      .join(' | ');

    db.prepare(
      `UPDATE payments
       SET paypal_authorization_status = ?,
           verification_status = 'MISMATCH_BLOCKED',
           verification_notes_json = ?,
           last_paypal_snapshot_json = ?,
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      res.data.status,
      JSON.stringify({ authorizationChecks: checks }),
      JSON.stringify(res.data),
      new Date().toISOString(),
      payment.id,
      sessionId
    );

    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'PAYPAL_VERIFICATION_FAILED',
      actor: 'TOLLGATE',
      payload: {
        stage: 'GET_AUTHORIZATION',
        paypal_authorization_id: payment.paypal_authorization_id,
        failed_checks: checks.filter((c) => !c.passed),
      },
    });

    throw new PayPalOrderVerificationError(
      `PayPal authorization verification failed: ${failedSummary}`,
      checks
    );
  }

  db.prepare(
    `UPDATE payments
     SET paypal_authorization_status = ?,
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    res.data.status,
    JSON.stringify(res.data),
    new Date().toISOString(),
    payment.id,
    sessionId
  );

  return res.data;
}

/**
 * Re-verifies authorization, then executes Capture via POST /v2/payments/authorizations/{id}/capture.
 * Strictly enforces Tollgate policy state:
 * - BLOCK proposals cannot capture.
 * - REVIEW proposals require human_decision === 'APPROVED'.
 */
export async function captureVerifiedAuthorization(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): Promise<{
  payment: PaymentRow;
  capture: PayPalCaptureResource;
  replayedFromIdempotency: boolean;
}> {
  const proposal = loadProposal(db, sessionId, proposalId);

  if (proposal.final_decision === 'BLOCK' || !proposal.final_decision) {
    throw new PayPalWorkflowStateError(
      `Cannot capture payment for proposal in decision "${proposal.final_decision ?? 'UNDECIDED'}"`
    );
  }
  if (proposal.final_decision === 'REVIEW' && proposal.human_decision !== 'APPROVED') {
    throw new PayPalWorkflowStateError(
      `Cannot capture REVIEW proposal without explicit Tollgate human approval (current human_decision: ${proposal.human_decision})`
    );
  }

  const payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!payment || !payment.paypal_authorization_id) {
    throw new PayPalWorkflowStateError(
      `Cannot capture proposal ${proposalId}: authorization does not exist yet`
    );
  }

  if (payment.paypal_void_status === 'VOIDED' || payment.verification_status === 'VOIDED') {
    throw new PayPalWorkflowStateError(
      `Cannot capture proposal ${proposalId}: authorization was already VOIDED`
    );
  }

  // If not yet captured locally, verify live authorization is in CREATED state first.
  if (!payment.paypal_capture_id) {
    await getAndVerifyAuthorization(db, sessionId, proposalId, ['CREATED']);
  }

  const authId = payment.paypal_authorization_id;
  const capturePayload = {
    amount: {
      currency_code: payment.currency,
      value: formatCents(payment.expected_amount_cents),
    },
    final_capture: true,
  };

  const { result: capture, replayedFromIdempotency } =
    await executeIdempotentPayPalOperation<PayPalCaptureResource>({
      db,
      sessionId,
      proposalId,
      paymentId: payment.id,
      operationType: 'CAPTURE',
      logicalOperationKey: `CAPTURE:${proposalId}:${authId}`,
      requestPayload: capturePayload,
      reconcileExisting: async () => {
        if (!payment.paypal_order_id) return { resolved: false };
        const orderRes = await paypalHttpRequest<{
          purchase_units?: Array<{
            payments?: { captures?: PayPalCaptureResource[] };
          }>;
        }>({
          method: 'GET',
          path: `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}`,
        });
        const existingCapture = orderRes.data?.purchase_units?.[0]?.payments?.captures?.[0];
        if (existingCapture?.id && existingCapture.status === 'COMPLETED') {
          return {
            resolved: true,
            resourceId: existingCapture.id,
            responseData: existingCapture,
            httpStatus: orderRes.status,
          };
        }
        return { resolved: false };
      },
      executeCall: async (payPalRequestId) => {
        const res = await paypalHttpRequest<PayPalCaptureResource>({
          method: 'POST',
          path: `/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`,
          body: capturePayload,
          payPalRequestId,
          preferRepresentation: true,
        });
        if (!res.data || !res.data.id) {
          throw new PayPalApiError('PayPal Capture returned an empty or invalid response', {
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

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE payments
     SET paypal_capture_id = ?,
         paypal_capture_status = ?,
         paypal_authorization_status = 'CAPTURED',
         verification_status = 'CAPTURED',
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    capture.id,
    capture.status,
    JSON.stringify(capture),
    now,
    payment.id,
    sessionId
  );

  db.prepare(
    `UPDATE proposals
     SET status = 'COMPLETED', updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(now, proposalId, sessionId);

  if (!replayedFromIdempotency) {
    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'CAPTURE_COMPLETED',
      actor: 'PAYPAL',
      payload: {
        paypal_authorization_id: authId,
        paypal_capture_id: capture.id,
        capture_status: capture.status,
        amount: capture.amount?.value ?? formatCents(payment.expected_amount_cents),
        currency: capture.amount?.currency_code ?? payment.currency,
      },
    });
  }

  return {
    payment: getPaymentByProposalId(db, sessionId, proposalId)!,
    capture,
    replayedFromIdempotency,
  };
}

/**
 * Re-verifies authorization, then executes Void via POST /v2/payments/authorizations/{id}/void.
 * Handles both HTTP 200 JSON representation and HTTP 204 No Content + live GET confirmation.
 */
export async function voidVerifiedAuthorization(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): Promise<{
  payment: PaymentRow;
  authorization: PayPalAuthorizationResource;
  replayedFromIdempotency: boolean;
}> {
  const proposal = loadProposal(db, sessionId, proposalId);
  const payment = getPaymentByProposalId(db, sessionId, proposalId);

  if (!payment || !payment.paypal_authorization_id) {
    throw new PayPalWorkflowStateError(
      `Cannot void proposal ${proposalId}: authorization does not exist`
    );
  }

  if (payment.paypal_capture_id || payment.verification_status === 'CAPTURED') {
    throw new PayPalWorkflowStateError(
      `Cannot void proposal ${proposalId}: payment has already been CAPTURED`
    );
  }

  if (payment.verification_status !== 'VOIDED') {
    await getAndVerifyAuthorization(db, sessionId, proposalId, ['CREATED']);
  }

  const authId = payment.paypal_authorization_id;
  const voidPayload = { authorization_id: authId };

  const { result: voidedAuth, replayedFromIdempotency } =
    await executeIdempotentPayPalOperation<PayPalAuthorizationResource>({
      db,
      sessionId,
      proposalId,
      paymentId: payment.id,
      operationType: 'VOID',
      logicalOperationKey: `VOID:${proposalId}:${authId}`,
      requestPayload: voidPayload,
      reconcileExisting: async () => {
        const authRes = await paypalHttpRequest<PayPalAuthorizationResource>({
          method: 'GET',
          path: `/v2/payments/authorizations/${encodeURIComponent(authId)}`,
        });
        if (authRes.data && authRes.data.status === 'VOIDED') {
          return {
            resolved: true,
            resourceId: authRes.data.id,
            responseData: authRes.data,
            httpStatus: authRes.status,
          };
        }
        return { resolved: false };
      },
      executeCall: async (payPalRequestId) => {
        const res = await paypalHttpRequest<PayPalAuthorizationResource>({
          method: 'POST',
          path: `/v2/payments/authorizations/${encodeURIComponent(authId)}/void`,
          payPalRequestId,
          preferRepresentation: true,
        });

        let authResource = res.data;
        if (!authResource || !authResource.id) {
          // PayPal often returns 204 No Content on /void; query GET authorization to confirm VOIDED status.
          const verifyRes = await paypalHttpRequest<PayPalAuthorizationResource>({
            method: 'GET',
            path: `/v2/payments/authorizations/${encodeURIComponent(authId)}`,
          });
          if (!verifyRes.data) {
            throw new PayPalApiError(
              'PayPal Void completed but confirmation Get Authorization returned empty response',
              { httpStatus: verifyRes.status }
            );
          }
          authResource = verifyRes.data;
        }

        return {
          httpStatus: res.status,
          resourceId: authResource.id,
          responseData: authResource,
        };
      },
    });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE payments
     SET paypal_void_status = ?,
         paypal_authorization_status = ?,
         verification_status = 'VOIDED',
         last_paypal_snapshot_json = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    voidedAuth.status,
    voidedAuth.status,
    JSON.stringify(voidedAuth),
    now,
    payment.id,
    sessionId
  );

  if (proposal.human_decision === 'DENIED') {
    db.prepare(
      `UPDATE proposals SET status = 'DENIED_BY_HUMAN', updated_at = ? WHERE id = ? AND session_id = ?`
    ).run(now, proposalId, sessionId);
  }

  if (!replayedFromIdempotency) {
    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'VOID_COMPLETED',
      actor: 'PAYPAL',
      payload: {
        paypal_authorization_id: authId,
        void_status: voidedAuth.status,
      },
    });
  }

  return {
    payment: getPaymentByProposalId(db, sessionId, proposalId)!,
    authorization: voidedAuth,
    replayedFromIdempotency,
  };
}

/**
 * Handles return from PayPal buyer approval redirect (/paypal/return?token=<order_id>).
 * - Verifies order against stored proposal
 * - Authorizes order
 * - Verifies authorization
 * - If proposal is ALLOW -> immediately captures
 * - If proposal is REVIEW -> stops after authorization and waits for Tollgate human decision
 */
export async function completePayPalReturnFlow(
  db: Database.Database,
  sessionId: string,
  paypalOrderId: string
): Promise<{
  proposalId: string;
  finalDecision: 'ALLOW' | 'REVIEW';
  stageReached: 'CAPTURED' | 'AWAITING_HUMAN_REVIEW' | 'ALREADY_VOIDED';
  payment: PaymentRow;
}> {
  const payment = db
    .prepare('SELECT * FROM payments WHERE paypal_order_id = ? AND session_id = ?')
    .get(paypalOrderId, sessionId) as PaymentRow | undefined;

  if (!payment) {
    throw new PayPalWorkflowStateError(
      `PayPal order ${paypalOrderId} was not found in the current Tollgate session.`
    );
  }

  const proposal = loadProposal(db, sessionId, payment.proposal_id);

  if (payment.verification_status === 'CAPTURED') {
    return {
      proposalId: proposal.id,
      finalDecision: proposal.final_decision === 'REVIEW' ? 'REVIEW' : 'ALLOW',
      stageReached: 'CAPTURED',
      payment,
    };
  }

  if (payment.verification_status === 'VOIDED') {
    return {
      proposalId: proposal.id,
      finalDecision: 'REVIEW',
      stageReached: 'ALREADY_VOIDED',
      payment,
    };
  }

  if (proposal.final_decision !== 'ALLOW' && proposal.final_decision !== 'REVIEW') {
    throw new PayPalWorkflowStateError(
      `Proposal ${proposal.id} decision (${proposal.final_decision}) does not permit payment progression.`
    );
  }

  // Step 4-8: Get Order -> Verify -> Authorize -> Get Authorization -> Verify
  await authorizePayPalOrder(db, sessionId, proposal.id);
  await getAndVerifyAuthorization(db, sessionId, proposal.id, ['CREATED']);

  if (proposal.final_decision === 'ALLOW') {
    const captured = await captureVerifiedAuthorization(db, sessionId, proposal.id);
    return {
      proposalId: proposal.id,
      finalDecision: 'ALLOW',
      stageReached: 'CAPTURED',
      payment: captured.payment,
    };
  }

  // REVIEW flow pauses after verified authorization until explicit human approval or denial in Tollgate.
  db.prepare(
    `UPDATE proposals
     SET status = 'REVIEW_PENDING',
         human_decision = CASE WHEN human_decision = 'NOT_REQUIRED' THEN 'PENDING' ELSE human_decision END,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(new Date().toISOString(), proposal.id, sessionId);

  return {
    proposalId: proposal.id,
    finalDecision: 'REVIEW',
    stageReached: 'AWAITING_HUMAN_REVIEW',
    payment: getPaymentByProposalId(db, sessionId, proposal.id)!,
  };
}

/**
 * Tollgate Human REVIEW Approval: marks human approval in DB/ledger, reverifies authorization, and captures.
 */
export async function approveReviewAndCapture(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  reason = 'Approved by human reviewer in Tollgate'
): Promise<{ payment: PaymentRow; capture: PayPalCaptureResource }> {
  const proposal = loadProposal(db, sessionId, proposalId);
  if (proposal.final_decision !== 'REVIEW') {
    throw new PayPalWorkflowStateError(
      `Human review approval only applies to REVIEW proposals (current decision: ${proposal.final_decision})`
    );
  }
  if (proposal.human_decision === 'DENIED') {
    throw new PayPalWorkflowStateError('Cannot approve a proposal that was already denied.');
  }

  const payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (!payment?.paypal_authorization_id) {
    throw new PayPalWorkflowStateError(
      'Buyer must complete PayPal approval and authorization before Tollgate human capture can proceed.'
    );
  }

  const now = new Date().toISOString();
  if (proposal.human_decision !== 'APPROVED') {
    db.prepare(
      `UPDATE proposals
       SET human_decision = 'APPROVED',
           human_decision_reason = ?,
           human_decided_at = ?,
           status = 'APPROVED_BY_HUMAN',
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(reason, now, now, proposalId, sessionId);

    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'HUMAN_REVIEW_APPROVED',
      actor: 'USER',
      payload: {
        reason,
        paypal_authorization_id: payment.paypal_authorization_id,
      },
    });
  }

  const captured = await captureVerifiedAuthorization(db, sessionId, proposalId);
  return {
    payment: captured.payment,
    capture: captured.capture,
  };
}

/**
 * Tollgate Human REVIEW Denial: marks human denial in DB/ledger and voids PayPal authorization (or cancels pre-auth).
 */
export async function denyReviewAndVoid(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  reason = 'Denied by human reviewer in Tollgate'
): Promise<{ payment: PaymentRow | null; voided: boolean }> {
  const proposal = loadProposal(db, sessionId, proposalId);
  if (proposal.final_decision !== 'REVIEW') {
    throw new PayPalWorkflowStateError(
      `Human review denial only applies to REVIEW proposals (current decision: ${proposal.final_decision})`
    );
  }
  if (proposal.human_decision === 'APPROVED') {
    throw new PayPalWorkflowStateError('Cannot deny a proposal that was already approved.');
  }

  const payment = getPaymentByProposalId(db, sessionId, proposalId);
  if (payment?.paypal_capture_id || payment?.verification_status === 'CAPTURED') {
    throw new PayPalWorkflowStateError('Cannot deny and void a payment that has already been captured.');
  }

  const now = new Date().toISOString();
  if (proposal.human_decision !== 'DENIED') {
    db.prepare(
      `UPDATE proposals
       SET human_decision = 'DENIED',
           human_decision_reason = ?,
           human_decided_at = ?,
           status = 'DENIED_BY_HUMAN',
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(reason, now, now, proposalId, sessionId);

    appendLedgerEvent(db, {
      sessionId,
      proposalId,
      eventType: 'HUMAN_REVIEW_DENIED',
      actor: 'USER',
      payload: {
        reason,
        paypal_authorization_id: payment?.paypal_authorization_id ?? null,
      },
    });
  }

  if (payment?.paypal_authorization_id) {
    const res = await voidVerifiedAuthorization(db, sessionId, proposalId);
    return { payment: res.payment, voided: true };
  }

  return { payment, voided: false };
}

