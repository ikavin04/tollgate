import 'server-only';
import type Database from 'better-sqlite3';
import { formatCents } from '@/lib/crypto';
import type { HeuristicProvenanceReport, PageEvidenceRow } from '@/lib/evidence';
import {
  listSessionLedgerEvents,
  verifySessionLedger,
  type LedgerEventRow,
} from '@/lib/ledger';
import type { CompiledMandate } from '@/lib/mandate/schema';
import type { PaymentOperationRow, PaymentRow } from '@/lib/paypal';
import type { DeterministicPolicyResult } from '@/lib/policy/engine';
import type { AiReviewerOutput } from '@/lib/reviewer';
import { assertSessionOwned } from '@/lib/session';

export interface DashboardStats {
  totalProposals: number;
  allowedCount: number;
  reviewedCount: number;
  blockedCount: number;
  capturedCount: number;
  voidedCount: number;
  pendingHumanDecisions: number;
}

export interface ProposalListItem {
  id: string;
  mandateId: string;
  originalInstruction: string;
  status: string;
  finalDecision: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
  deterministicDecision: string | null;
  aiReviewerDecision: string | null;
  humanDecision: string;
  totalAmountCents: number;
  totalFormatted: string;
  currency: string;
  itemsSummary: string;
  paymentStatus: string | null;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  createdAt: string;
}

export interface ProposalDetailDTO {
  proposal: {
    id: string;
    sessionId: string;
    mandateId: string;
    agentRunId: string | null;
    status: string;
    agentReasoning: string;
    provenance: HeuristicProvenanceReport | null;
    currency: string;
    totalAmountCents: number;
    totalFormatted: string;
    itemsPayloadHash: string;
    deterministicDecision: string | null;
    deterministicResult: DeterministicPolicyResult | null;
    aiReviewerDecision: string | null;
    aiReviewerResult: AiReviewerOutput | null;
    aiReviewerCached: boolean;
    finalDecision: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
    humanDecision: string;
    humanDecisionReason: string | null;
    humanDecidedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  mandate: {
    id: string;
    originalInstruction: string;
    compiledMandate: CompiledMandate;
    status: string;
    compilerModel: string;
    compilerCached: boolean;
    confirmedAt: string | null;
  };
  items: Array<{
    id: string;
    productId: string;
    sku: string;
    productName: string;
    category: string;
    quantity: number;
    unitPriceCents: number;
    unitPriceFormatted: string;
    lineTotalCents: number;
    lineTotalFormatted: string;
    currency: string;
    canonicalSnapshot: Record<string, unknown>;
  }>;
  agentRun: {
    id: string;
    modelId: string;
    scenarioHint: string | null;
    status: string;
    toolCallsCount: number;
    toolTrace: unknown[];
    cachedOutput: boolean;
    createdAt: string;
    completedAt: string | null;
  } | null;
  pageEvidence: PageEvidenceRow[];
  payment: {
    id: string;
    referenceId: string;
    customId: string;
    currency: string;
    expectedAmountCents: number;
    expectedAmountFormatted: string;
    itemsPayloadHash: string;
    paypalOrderId: string | null;
    paypalOrderStatus: string | null;
    paypalIntent: string | null;
    payerActionUrl: string | null;
    paypalAuthorizationId: string | null;
    paypalAuthorizationStatus: string | null;
    paypalCaptureId: string | null;
    paypalCaptureStatus: string | null;
    paypalVoidStatus: string | null;
    verificationStatus: string;
    verificationNotes: unknown;
    updatedAt: string;
  } | null;
  paymentOperations: PaymentOperationRow[];
  ledgerEvents: LedgerEventRow[];
  ledgerValid: boolean;
  allowedActions: {
    canCreatePayPalOrder: boolean;
    canOpenPayPalCheckout: boolean;
    canHumanApproveCapture: boolean;
    canHumanDenyVoid: boolean;
  };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getSessionDashboardData(
  db: Database.Database,
  sessionId: string
): { stats: DashboardStats; proposals: ProposalListItem[] } {
  const rows = db
    .prepare(
      `SELECT
        p.id,
        p.mandate_id,
        m.original_instruction,
        p.status,
        p.final_decision,
        p.deterministic_decision,
        p.ai_reviewer_decision,
        p.human_decision,
        p.total_amount_cents,
        p.currency,
        p.created_at,
        pay.verification_status as payment_status,
        pay.paypal_order_id,
        pay.paypal_authorization_id,
        pay.paypal_capture_id
      FROM proposals p
      JOIN mandates m ON m.id = p.mandate_id AND m.session_id = p.session_id
      LEFT JOIN payments pay ON pay.proposal_id = p.id AND pay.session_id = p.session_id
      WHERE p.session_id = ?
      ORDER BY p.created_at DESC`
    )
    .all(sessionId) as Array<{
    id: string;
    mandate_id: string;
    original_instruction: string;
    status: string;
    final_decision: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
    deterministic_decision: string | null;
    ai_reviewer_decision: string | null;
    human_decision: string;
    total_amount_cents: number;
    currency: string;
    created_at: string;
    payment_status: string | null;
    paypal_order_id: string | null;
    paypal_authorization_id: string | null;
    paypal_capture_id: string | null;
  }>;

  const itemsStmt = db.prepare(
    'SELECT product_name, quantity FROM proposal_items WHERE proposal_id = ? AND session_id = ?'
  );

  const stats: DashboardStats = {
    totalProposals: rows.length,
    allowedCount: 0,
    reviewedCount: 0,
    blockedCount: 0,
    capturedCount: 0,
    voidedCount: 0,
    pendingHumanDecisions: 0,
  };

  const proposals: ProposalListItem[] = rows.map((r) => {
    if (r.final_decision === 'ALLOW') stats.allowedCount += 1;
    if (r.final_decision === 'REVIEW') stats.reviewedCount += 1;
    if (r.final_decision === 'BLOCK') stats.blockedCount += 1;
    if (r.payment_status === 'CAPTURED') stats.capturedCount += 1;
    if (r.payment_status === 'VOIDED') stats.voidedCount += 1;
    if (
      r.final_decision === 'REVIEW' &&
      r.human_decision === 'PENDING' &&
      r.payment_status !== 'CAPTURED' &&
      r.payment_status !== 'VOIDED'
    ) {
      stats.pendingHumanDecisions += 1;
    }

    const lineItems = itemsStmt.all(r.id, sessionId) as Array<{
      product_name: string;
      quantity: number;
    }>;

    return {
      id: r.id,
      mandateId: r.mandate_id,
      originalInstruction: r.original_instruction,
      status: r.status,
      finalDecision: r.final_decision,
      deterministicDecision: r.deterministic_decision,
      aiReviewerDecision: r.ai_reviewer_decision,
      humanDecision: r.human_decision,
      totalAmountCents: r.total_amount_cents,
      totalFormatted: formatCents(r.total_amount_cents),
      currency: r.currency,
      itemsSummary: lineItems.map((li) => `${li.quantity}x ${li.product_name}`).join(', '),
      paymentStatus: r.payment_status,
      paypalOrderId: r.paypal_order_id,
      paypalAuthorizationId: r.paypal_authorization_id,
      paypalCaptureId: r.paypal_capture_id,
      createdAt: r.created_at,
    };
  });

  return { stats, proposals };
}

export function getSessionProposalDetail(
  db: Database.Database,
  sessionId: string,
  proposalId: string
): ProposalDetailDTO {
  const row = assertSessionOwned(
    db
      .prepare('SELECT * FROM proposals WHERE id = ? AND session_id = ?')
      .get(proposalId, sessionId) as
      | {
          id: string;
          session_id: string;
          mandate_id: string;
          agent_run_id: string | null;
          status: string;
          agent_reasoning: string;
          provenance_json: string;
          currency: string;
          total_amount_cents: number;
          items_payload_hash: string;
          deterministic_decision: string | null;
          deterministic_result_json: string | null;
          ai_reviewer_decision: string | null;
          ai_reviewer_result_json: string | null;
          ai_reviewer_cached: number;
          final_decision: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
          human_decision: string;
          human_decision_reason: string | null;
          human_decided_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined,
    sessionId,
    'Proposal'
  );

  const mandate = assertSessionOwned(
    db
      .prepare('SELECT * FROM mandates WHERE id = ? AND session_id = ?')
      .get(row.mandate_id, sessionId) as
      | {
          id: string;
          session_id: string;
          original_instruction: string;
          compiled_mandate_json: string;
          status: string;
          compiler_model: string;
          compiler_cached: number;
          confirmed_at: string | null;
        }
      | undefined,
    sessionId,
    'Mandate'
  );

  const itemRows = db
    .prepare('SELECT * FROM proposal_items WHERE proposal_id = ? AND session_id = ? ORDER BY created_at ASC')
    .all(proposalId, sessionId) as Array<{
    id: string;
    product_id: string;
    sku: string;
    product_name: string;
    category: string;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
    currency: string;
    canonical_snapshot_json: string;
  }>;

  const agentRunRow = row.agent_run_id
    ? (db
        .prepare('SELECT * FROM agent_runs WHERE id = ? AND session_id = ?')
        .get(row.agent_run_id, sessionId) as
        | {
            id: string;
            model_id: string;
            scenario_hint: string | null;
            status: string;
            tool_calls_count: number;
            tool_trace_json: string;
            cached_output: number;
            created_at: string;
            completed_at: string | null;
          }
        | undefined)
    : undefined;

  const pageEvidence = db
    .prepare(
      `SELECT * FROM page_evidence
       WHERE session_id = ? AND (proposal_id = ? OR (? IS NOT NULL AND agent_run_id = ?))
       ORDER BY created_at ASC`
    )
    .all(sessionId, proposalId, row.agent_run_id, row.agent_run_id) as PageEvidenceRow[];

  const paymentRow = db
    .prepare('SELECT * FROM payments WHERE proposal_id = ? AND session_id = ?')
    .get(proposalId, sessionId) as PaymentRow | undefined;

  const paymentOperations = db
    .prepare('SELECT * FROM payment_operations WHERE proposal_id = ? AND session_id = ? ORDER BY created_at ASC')
    .all(proposalId, sessionId) as PaymentOperationRow[];

  const ledgerEvents = listSessionLedgerEvents(db, sessionId, proposalId);
  const ledgerCheck = verifySessionLedger(db, sessionId);

  // Strict backend state permissions for UI controls
  const canCreatePayPalOrder =
    (row.final_decision === 'ALLOW' || row.final_decision === 'REVIEW') &&
    (!paymentRow || !paymentRow.paypal_order_id);

  const canOpenPayPalCheckout = Boolean(
    paymentRow?.payer_action_url &&
      (paymentRow.verification_status === 'ORDER_CREATED' ||
        paymentRow.verification_status === 'BUYER_CANCELLED')
  );

  const canHumanApproveCapture = Boolean(
    row.final_decision === 'REVIEW' &&
      row.human_decision === 'PENDING' &&
      paymentRow?.paypal_authorization_id &&
      paymentRow.verification_status === 'AUTHORIZED'
  );

  const canHumanDenyVoid = Boolean(
    row.final_decision === 'REVIEW' &&
      row.human_decision === 'PENDING' &&
      paymentRow?.verification_status !== 'CAPTURED' &&
      paymentRow?.verification_status !== 'VOIDED'
  );

  return {
    proposal: {
      id: row.id,
      sessionId: row.session_id,
      mandateId: row.mandate_id,
      agentRunId: row.agent_run_id,
      status: row.status,
      agentReasoning: row.agent_reasoning,
      provenance: safeJsonParse<HeuristicProvenanceReport | null>(row.provenance_json, null),
      currency: row.currency,
      totalAmountCents: row.total_amount_cents,
      totalFormatted: formatCents(row.total_amount_cents),
      itemsPayloadHash: row.items_payload_hash,
      deterministicDecision: row.deterministic_decision,
      deterministicResult: safeJsonParse<DeterministicPolicyResult | null>(
        row.deterministic_result_json,
        null
      ),
      aiReviewerDecision: row.ai_reviewer_decision,
      aiReviewerResult: safeJsonParse<AiReviewerOutput | null>(row.ai_reviewer_result_json, null),
      aiReviewerCached: row.ai_reviewer_cached === 1,
      finalDecision: row.final_decision,
      humanDecision: row.human_decision,
      humanDecisionReason: row.human_decision_reason,
      humanDecidedAt: row.human_decided_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    mandate: {
      id: mandate.id,
      originalInstruction: mandate.original_instruction,
      compiledMandate: safeJsonParse<CompiledMandate>(
        mandate.compiled_mandate_json,
        {} as CompiledMandate
      ),
      status: mandate.status,
      compilerModel: mandate.compiler_model,
      compilerCached: mandate.compiler_cached === 1,
      confirmedAt: mandate.confirmed_at,
    },
    items: itemRows.map((i) => ({
      id: i.id,
      productId: i.product_id,
      sku: i.sku,
      productName: i.product_name,
      category: i.category,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      unitPriceFormatted: formatCents(i.unit_price_cents),
      lineTotalCents: i.line_total_cents,
      lineTotalFormatted: formatCents(i.line_total_cents),
      currency: i.currency,
      canonicalSnapshot: safeJsonParse<Record<string, unknown>>(i.canonical_snapshot_json, {}),
    })),
    agentRun: agentRunRow
      ? {
          id: agentRunRow.id,
          modelId: agentRunRow.model_id,
          scenarioHint: agentRunRow.scenario_hint,
          status: agentRunRow.status,
          toolCallsCount: agentRunRow.tool_calls_count,
          toolTrace: safeJsonParse<unknown[]>(agentRunRow.tool_trace_json, []),
          cachedOutput: agentRunRow.cached_output === 1,
          createdAt: agentRunRow.created_at,
          completedAt: agentRunRow.completed_at,
        }
      : null,
    pageEvidence,
    payment: paymentRow
      ? {
          id: paymentRow.id,
          referenceId: paymentRow.reference_id,
          customId: paymentRow.custom_id,
          currency: paymentRow.currency,
          expectedAmountCents: paymentRow.expected_amount_cents,
          expectedAmountFormatted: formatCents(paymentRow.expected_amount_cents),
          itemsPayloadHash: paymentRow.items_payload_hash,
          paypalOrderId: paymentRow.paypal_order_id,
          paypalOrderStatus: paymentRow.paypal_order_status,
          paypalIntent: paymentRow.paypal_intent,
          payerActionUrl: paymentRow.payer_action_url,
          paypalAuthorizationId: paymentRow.paypal_authorization_id,
          paypalAuthorizationStatus: paymentRow.paypal_authorization_status,
          paypalCaptureId: paymentRow.paypal_capture_id,
          paypalCaptureStatus: paymentRow.paypal_capture_status,
          paypalVoidStatus: paymentRow.paypal_void_status,
          verificationStatus: paymentRow.verification_status,
          verificationNotes: safeJsonParse<unknown>(paymentRow.verification_notes_json, null),
          updatedAt: paymentRow.updated_at,
        }
      : null,
    paymentOperations,
    ledgerEvents,
    ledgerValid: ledgerCheck.valid,
    allowedActions: {
      canCreatePayPalOrder,
      canOpenPayPalCheckout,
      canHumanApproveCapture,
      canHumanDenyVoid,
    },
  };
}

export function listSessionEvidence(
  db: Database.Database,
  sessionId: string
): PageEvidenceRow[] {
  return db
    .prepare('SELECT * FROM page_evidence WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as PageEvidenceRow[];
}

