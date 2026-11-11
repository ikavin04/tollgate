import 'server-only';
import type Database from 'better-sqlite3';
import {
  executeShoppingAgentRun,
  type AgentToolTraceEntry,
  type ShoppingAgentRunnerFn,
} from '@/lib/agent/shopping-agent';
import { formatCents, newUuid } from '@/lib/crypto';
import {
  buildBoundedEvidenceForReview,
  buildHeuristicProvenance,
  type PageEvidenceRow,
} from '@/lib/evidence';
import { appendLedgerEvent } from '@/lib/ledger';
import { getSessionMandate } from '@/lib/mandate/compiler';
import { computeCanonicalItemsHash } from '@/lib/paypal';
import {
  evaluateDeterministicPolicy,
  type DeterministicPolicyResult,
  type PolicyDecision,
  type ProposedLineItem,
} from '@/lib/policy/engine';
import {
  combineGateDecisions,
  runIndependentAiReview,
  type AiReviewerLlmFn,
  type AiReviewerOutput,
} from '@/lib/reviewer';
import { getCatalogProductById, listAllCatalogProducts } from '@/lib/storefront';

export interface EvaluatedProposalRecord {
  proposalId: string;
  sessionId: string;
  mandateId: string;
  agentRunId: string | null;
  finalDecision: PolicyDecision;
  deterministicDecision: PolicyDecision;
  deterministicResult: DeterministicPolicyResult;
  aiReviewerDecision: AiReviewerOutput['decision'];
  aiReviewerResult: AiReviewerOutput;
  aiReviewerCached: boolean;
  agentCached: boolean;
  totalAmountCents: number;
  currency: string;
  itemsPayloadHash: string;
  evidencePages: PageEvidenceRow[];
}

/**
 * Evaluates a purchase proposal end-to-end:
 * 1. Canonicalizes product prices/SKUs from Tollgate SQLite catalog (agent cannot invent prices).
 * 2. Persists proposal & proposal_items + associates page_evidence.
 * 3. Runs Deterministic Policy Engine.
 * 4. Runs Independent AI Intent Reviewer (fail-closed to REVIEW).
 * 5. Combines decisions: BLOCK > REVIEW > ALLOW.
 * 6. Appends ledger events for every step.
 */
export async function evaluateAndStoreProposal(
  db: Database.Database,
  options: {
    sessionId: string;
    mandateId: string;
    agentRunId?: string | null;
    requestedItems: Array<{ product_id: string; quantity: number }>;
    agentReasoning: string;
    toolTrace?: AgentToolTraceEntry[];
    evidencePages?: PageEvidenceRow[];
    agentCached?: boolean;
    ipAddress?: string | null;
    forceFresh?: boolean;
    llmReviewer?: AiReviewerLlmFn;
  }
): Promise<EvaluatedProposalRecord> {
  const { mandateRow, compiled } = getSessionMandate(db, options.sessionId, options.mandateId);
  const catalog = listAllCatalogProducts(db);

  // Resolve canonical product data from Tollgate DB — never trust prices/SKUs from agent
  const resolvedItems: ProposedLineItem[] = options.requestedItems.map((req) => {
    const product = getCatalogProductById(db, req.product_id);
    if (!product) {
      throw new Error(`Proposed product_id "${req.product_id}" does not exist in Tollgate catalog.`);
    }
    if (!Number.isInteger(req.quantity) || req.quantity < 1) {
      throw new Error(`Invalid quantity ${req.quantity} for product "${req.product_id}".`);
    }
    return { product, quantity: req.quantity };
  });

  if (resolvedItems.length === 0) {
    throw new Error('Proposal must include at least one valid product item.');
  }

  const currency = resolvedItems[0].product.currency;
  const totalAmountCents = resolvedItems.reduce(
    (sum, item) => sum + item.product.price_cents * item.quantity,
    0
  );

  const itemsForHash = resolvedItems.map(({ product, quantity }) => ({
    sku: product.sku,
    product_name: product.name,
    category: product.category,
    quantity,
    unit_price_cents: product.price_cents,
    line_total_cents: product.price_cents * quantity,
    currency: product.currency,
  }));
  const itemsPayloadHash = computeCanonicalItemsHash(itemsForHash, totalAmountCents, currency);

  const proposalId = newUuid();
  const now = new Date().toISOString();
  const evidencePages = options.evidencePages ?? [];
  const boundedEvidence = buildBoundedEvidenceForReview(evidencePages);

  const provenance = buildHeuristicProvenance({
    originalInstruction: mandateRow.original_instruction,
    proposedItems: resolvedItems,
    agentReasoning: options.agentReasoning,
    pages: evidencePages,
  });

  const insertProposalTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO proposals (
        id, session_id, mandate_id, agent_run_id, status, agent_reasoning,
        provenance_json, currency, total_amount_cents, items_payload_hash,
        human_decision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PENDING_EVALUATION', ?, ?, ?, ?, ?, 'NOT_REQUIRED', ?, ?)`
    ).run(
      proposalId,
      options.sessionId,
      mandateRow.id,
      options.agentRunId ?? null,
      options.agentReasoning,
      JSON.stringify(provenance),
      currency,
      totalAmountCents,
      itemsPayloadHash,
      now,
      now
    );

    const insertItem = db.prepare(
      `INSERT INTO proposal_items (
        id, session_id, proposal_id, product_id, sku, product_name, category,
        quantity, unit_price_cents, line_total_cents, currency, canonical_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const { product, quantity } of resolvedItems) {
      insertItem.run(
        newUuid(),
        options.sessionId,
        proposalId,
        product.id,
        product.sku,
        product.name,
        product.category,
        quantity,
        product.price_cents,
        product.price_cents * quantity,
        product.currency,
        JSON.stringify({
          id: product.id,
          sku: product.sku,
          name: product.name,
          brand: product.brand,
          category: product.category,
          condition: product.condition,
          ram_gb: product.ram_gb,
          storage_gb: product.storage_gb,
          weight_kg: product.weight_kg,
          warranty_summary: product.warranty_summary,
          extended_warranty_included: product.extended_warranty_included === 1,
          price_cents: product.price_cents,
          currency: product.currency,
        }),
        now
      );
    }

    if (evidencePages.length > 0) {
      const linkPage = db.prepare(
        'UPDATE page_evidence SET proposal_id = ? WHERE id = ? AND session_id = ?'
      );
      for (const page of evidencePages) {
        linkPage.run(proposalId, page.id, options.sessionId);
      }
    }
  });
  insertProposalTx();

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    proposalId,
    eventType: 'PROPOSAL_CREATED',
    actor: 'AGENT',
    payload: {
      proposal_id: proposalId,
      mandate_id: mandateRow.id,
      total_amount_formatted: formatCents(totalAmountCents),
      currency,
      items_payload_hash: itemsPayloadHash,
      items: itemsForHash.map((i) => ({ sku: i.sku, qty: i.quantity, unit_cents: i.unit_price_cents })),
    },
  });

  // Deterministic Policy Engine
  const deterministicResult = evaluateDeterministicPolicy({
    mandate: compiled,
    mandateConfirmed: mandateRow.status === 'CONFIRMED',
    mandateExpiresAt: mandateRow.expires_at,
    items: resolvedItems,
    catalog,
    evidenceMeta: {
      anyTruncated: boundedEvidence.anyTruncated,
      truncatedPageIds: boundedEvidence.truncatedPageIds,
      evidenceIds: evidencePages.map((p) => p.id),
    },
  });

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    proposalId,
    eventType: 'POLICY_RESULT_GENERATED',
    actor: 'POLICY_ENGINE',
    payload: {
      decision: deterministicResult.decision,
      passed_count: deterministicResult.passed_checks.length,
      failed_rules: deterministicResult.failed_checks.map((c) => c.rule),
      warnings: deterministicResult.warnings,
    },
  });

  // Independent AI Intent Reviewer (same Gemini model, separate invocation & system instructions, fail-closed to REVIEW)
  const aiReview = await runIndependentAiReview(db, {
    sessionId: options.sessionId,
    ipAddress: options.ipAddress,
    forceFresh: options.forceFresh,
    llmReviewer: options.llmReviewer,
    bundle: {
      originalInstruction: mandateRow.original_instruction,
      confirmedMandate: compiled,
      proposedItems: resolvedItems,
      totalAmountCents,
      currency,
      agentReasoning: options.agentReasoning,
      toolTrace: options.toolTrace ?? [],
      deterministicResult,
      provenance,
      pageExcerpts: boundedEvidence.excerpts,
      anyPageTruncated: boundedEvidence.anyTruncated,
    },
  });

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    proposalId,
    eventType: 'AI_REVIEW_COMPLETED',
    actor: 'AI_REVIEWER',
    payload: {
      decision: aiReview.output.decision,
      risk_category: aiReview.output.risk_category,
      confidence: aiReview.output.confidence,
      cached_ai_result: aiReview.cached,
      fail_closed_triggered: aiReview.failClosedTriggered,
      evidence_ids: aiReview.output.evidence_ids,
    },
  });

  // Combine decisions: BLOCK > REVIEW > ALLOW
  const finalDecision = combineGateDecisions(
    deterministicResult.decision,
    aiReview.output.decision
  );

  const proposalStatus =
    finalDecision === 'BLOCK'
      ? 'BLOCKED'
      : finalDecision === 'REVIEW'
        ? 'REVIEW_PENDING'
        : 'ALLOWED';

  const humanDecision = finalDecision === 'REVIEW' ? 'PENDING' : 'NOT_REQUIRED';

  db.prepare(
    `UPDATE proposals
     SET status = ?,
         deterministic_decision = ?,
         deterministic_result_json = ?,
         ai_reviewer_decision = ?,
         ai_reviewer_result_json = ?,
         ai_reviewer_cached = ?,
         final_decision = ?,
         human_decision = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    proposalStatus,
    deterministicResult.decision,
    JSON.stringify(deterministicResult),
    aiReview.output.decision,
    JSON.stringify(aiReview.output),
    aiReview.cached ? 1 : 0,
    finalDecision,
    humanDecision,
    new Date().toISOString(),
    proposalId,
    options.sessionId
  );

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    proposalId,
    eventType: 'FINAL_DECISION_ISSUED',
    actor: 'TOLLGATE',
    payload: {
      final_decision: finalDecision,
      deterministic_decision: deterministicResult.decision,
      ai_reviewer_decision: aiReview.output.decision,
      proposal_status: proposalStatus,
      paypal_order_allowed: finalDecision !== 'BLOCK',
    },
  });

  return {
    proposalId,
    sessionId: options.sessionId,
    mandateId: mandateRow.id,
    agentRunId: options.agentRunId ?? null,
    finalDecision,
    deterministicDecision: deterministicResult.decision,
    deterministicResult,
    aiReviewerDecision: aiReview.output.decision,
    aiReviewerResult: aiReview.output,
    aiReviewerCached: aiReview.cached,
    agentCached: Boolean(options.agentCached),
    totalAmountCents,
    currency,
    itemsPayloadHash,
    evidencePages,
  };
}

/**
 * Full Shopping Agent -> Policy Engine -> Independent AI Reviewer -> Final Gate Decision pipeline.
 */
export async function runAgentAndEvaluateProposal(
  db: Database.Database,
  options: {
    sessionId: string;
    mandateId: string;
    ipAddress?: string | null;
    forceFresh?: boolean;
    customAgentRunner?: ShoppingAgentRunnerFn;
    llmReviewer?: AiReviewerLlmFn;
  }
): Promise<EvaluatedProposalRecord> {
  const { mandateRow, compiled } = getSessionMandate(db, options.sessionId, options.mandateId);
  if (mandateRow.status !== 'CONFIRMED') {
    throw new Error(
      `Mandate ${mandateRow.id} must be CONFIRMED before the shopping agent can run (status: ${mandateRow.status}).`
    );
  }

  const agentOutcome = await executeShoppingAgentRun(db, {
    sessionId: options.sessionId,
    mandateId: mandateRow.id,
    originalInstruction: mandateRow.original_instruction,
    confirmedMandate: compiled,
    ipAddress: options.ipAddress,
    forceFresh: options.forceFresh,
    customRunner: options.customAgentRunner,
  });

  return evaluateAndStoreProposal(db, {
    sessionId: options.sessionId,
    mandateId: mandateRow.id,
    agentRunId: agentOutcome.agentRunId,
    requestedItems: agentOutcome.proposalItems,
    agentReasoning: agentOutcome.reasoning,
    toolTrace: agentOutcome.toolTrace,
    evidencePages: agentOutcome.evidencePages,
    agentCached: agentOutcome.cached,
    ipAddress: options.ipAddress,
    forceFresh: options.forceFresh,
    llmReviewer: options.llmReviewer,
  });
}

