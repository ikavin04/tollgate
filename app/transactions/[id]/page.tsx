'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Scale,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { CachedAiBadge, DecisionBadge, StatusPill } from '@/components/DecisionBadge';
import type { ProposalDetailDTO } from '@/lib/proposals/queries';

function TransactionDetailInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const proposalId = params.id;

  const paypalQueryStatus = searchParams.get('paypal');
  const paypalQueryError = searchParams.get('paypalError');

  const [detail, setDetail] = useState<ProposalDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load transaction');
      }
      setDetail(data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load transaction');
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/proposals/${encodeURIComponent(proposalId)}`, { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load transaction');
        return data as ProposalDetailDTO;
      })
      .then((data) => {
        if (active) setDetail(data);
      })
      .catch((err) => {
        if (active) {
          setActionError(err instanceof Error ? err.message : 'Unable to load transaction');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [proposalId]);

  async function handleCreatePayPalOrder() {
    setActionLoading('CREATE_ORDER');
    setActionError(null);
    try {
      const res = await fetch('/api/paypal/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create PayPal order');
      }
      await loadDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'PayPal order creation failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleHumanReview(decision: 'APPROVE' | 'DENY') {
    setActionLoading(decision);
    setActionError(null);
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reason:
            reviewReason.trim() ||
            (decision === 'APPROVE'
              ? 'Approved by human reviewer in Tollgate'
              : 'Denied by human reviewer in Tollgate'),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${decision.toLowerCase()} proposal`);
      }
      await loadDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Review action failed');
    } finally {
      setActionLoading(null);
    }
  }

  if (loading && !detail) {
    return <div className="text-sm text-slate-400">Loading transaction details…</div>;
  }

  if (!detail) {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200 space-y-3">
        <p>{actionError ?? 'Transaction not found in current session.'}</p>
        <Link href="/transactions" className="text-blue-300 hover:underline block">
          ← Back to Transaction Dashboard
        </Link>
      </div>
    );
  }

  const { proposal, mandate, items, agentRun, pageEvidence, payment, paymentOperations, ledgerEvents, allowedActions } =
    detail;

  return (
    <div className="space-y-8">
      {/* Top Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Link
            href="/transactions"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Transaction Dashboard
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-white">
              Transaction {proposal.id.slice(0, 8)}
            </h1>
            <DecisionBadge decision={proposal.finalDecision} size="lg" />
            <StatusPill status={payment?.verificationStatus ?? proposal.status} />
          </div>
        </div>

        <a
          href={`/api/proposals/${encodeURIComponent(proposal.id)}/receipt`}
          className="inline-flex items-center gap-2 rounded-lg border border-[#24375f] bg-[#0b1324] px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-[#111c33]"
        >
          <Download className="h-4 w-4 text-blue-400" />
          Download JSON Receipt
        </a>
      </div>

      {/* Callback Status Alerts */}
      {paypalQueryStatus && (
        <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 p-4 text-sm text-blue-200">
          {paypalQueryStatus === 'captured' &&
            'PayPal Sandbox checkout approved, verified, authorized, and CAPTURED cleanly.'}
          {paypalQueryStatus === 'authorized_review' &&
            'PayPal Sandbox checkout approved, verified, and AUTHORIZED. Funds remain uncaptured pending your Tollgate human REVIEW decision below.'}
          {paypalQueryStatus === 'cancelled' &&
            'Buyer cancelled checkout on PayPal before approval. No funds were authorized or captured.'}
          {paypalQueryStatus === 'voided' && 'PayPal authorization is VOIDED.'}
        </div>
      )}

      {(paypalQueryError || actionError) && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {paypalQueryError || actionError}
        </div>
      )}

      {/* PayPal & Human Action Control Panel */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1d2d4e] pb-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-400" />
            Payment Execution &amp; Human Gate Controls
          </h2>
          <span className="font-mono text-lg font-bold text-white">
            ${proposal.totalFormatted} {proposal.currency}
          </span>
        </div>

        {proposal.finalDecision === 'BLOCK' ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Blocked Before PayPal</p>
              <p className="text-xs text-red-300 mt-1">
                Tollgate blocked this proposal. No PayPal order was created, and all PayPal payment
                actions remain disabled on the backend.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Stage 1: PayPal Buyer Approval */}
            <div className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-300">
                Action 1 — PayPal Buyer Approval (Checkout Redirect)
              </div>
              <p className="text-xs text-slate-400">
                Creates an <code className="text-slate-200">AUTHORIZE</code> intent order in PayPal
                Sandbox and redirects the buyer via PayPal&apos;s{' '}
                <code className="text-slate-200">payer-action</code> URL.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleCreatePayPalOrder}
                  disabled={!allowedActions.canCreatePayPalOrder || actionLoading !== null}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {actionLoading === 'CREATE_ORDER'
                    ? 'Creating PayPal Order…'
                    : payment?.paypalOrderId
                      ? `Order Created (${payment.paypalOrderId})`
                      : 'Create PayPal AUTHORIZE Order'}
                </button>

                {payment?.payerActionUrl && (
                  <a
                    href={payment.payerActionUrl}
                    aria-disabled={!allowedActions.canOpenPayPalCheckout}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                      allowedActions.canOpenPayPalCheckout
                        ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                        : 'pointer-events-none bg-slate-800 text-slate-500 border border-slate-700'
                    }`}
                  >
                    Approve in PayPal Sandbox
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>

            {/* Stage 2: Tollgate Human REVIEW Decision */}
            <div className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                Action 2 — Tollgate Human REVIEW Decision (Post-Authorization)
              </div>
              <p className="text-xs text-slate-400">
                {proposal.finalDecision === 'ALLOW'
                  ? 'ALLOW proposals capture automatically upon verified PayPal buyer approval & authorization.'
                  : 'For REVIEW proposals, buyer authorization pauses before capture. Approve to capture or Deny to void in PayPal.'}
              </p>

              {proposal.finalDecision === 'REVIEW' && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={reviewReason}
                    onChange={(e) => setReviewReason(e.target.value)}
                    disabled={!allowedActions.canHumanApproveCapture && !allowedActions.canHumanDenyVoid}
                    placeholder="Optional human review note (recorded in ledger)"
                    className="w-full rounded-lg border border-[#24375f] bg-[#0b1324] px-3 py-1.5 text-xs text-white placeholder-slate-500 disabled:opacity-40"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleHumanReview('APPROVE')}
                      disabled={!allowedActions.canHumanApproveCapture || actionLoading !== null}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {actionLoading === 'APPROVE' ? 'Capturing…' : 'Approve & Capture'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleHumanReview('DENY')}
                      disabled={!allowedActions.canHumanDenyVoid || actionLoading !== null}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {actionLoading === 'DENY' ? 'Voiding…' : 'Deny & Void Authorization'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Dual Gate Verification: Deterministic Policy + Independent AI Intent Reviewer */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-[#1d2d4e] pb-3">
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <Scale className="h-4 w-4 text-blue-400" />
              Deterministic Policy Engine
            </h2>
            <DecisionBadge decision={proposal.deterministicDecision} />
          </div>

          {proposal.deterministicResult && (
            <div className="space-y-3 text-xs">
              {proposal.deterministicResult.failed_checks.map((c) => (
                <div
                  key={c.rule}
                  className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-200"
                >
                  <div className="font-mono font-semibold">
                    [FAIL • {c.outcomeIfFailed}] {c.rule}
                  </div>
                  <div className="mt-1">{c.detail}</div>
                </div>
              ))}
              {proposal.deterministicResult.warnings.map((w, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200"
                >
                  {w}
                </div>
              ))}
              <div className="space-y-1.5">
                <div className="text-slate-400 font-semibold">
                  Passed Checks ({proposal.deterministicResult.passed_checks.length})
                </div>
                {proposal.deterministicResult.passed_checks.map((c) => (
                  <div
                    key={c.rule}
                    className="rounded border border-[#1d2d4e] bg-[#060b16] px-3 py-2 text-slate-300"
                  >
                    <span className="font-mono text-emerald-300">[PASS] {c.rule}:</span> {c.detail}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1d2d4e] pb-3">
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-blue-400" />
              Independent AI Intent Reviewer
            </h2>
            <div className="flex items-center gap-2">
              <CachedAiBadge cached={proposal.aiReviewerCached} />
              <DecisionBadge decision={proposal.aiReviewerDecision} />
            </div>
          </div>

          <p className="text-[11px] text-slate-400">
            Separate Gemini 3.5 Flash-Lite invocation with isolated system instructions (same model,
            independent reviewer role; never holds PayPal credentials; fails closed to REVIEW).
          </p>

          {proposal.aiReviewerResult && (
            <div className="space-y-3 text-xs">
              <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3.5 space-y-2">
                <div className="flex items-center justify-between font-mono text-slate-400">
                  <span>Risk Category: {proposal.aiReviewerResult.risk_category}</span>
                  <span>Confidence: {(proposal.aiReviewerResult.confidence * 100).toFixed(0)}%</span>
                </div>
                <p className="text-sm text-slate-200">{proposal.aiReviewerResult.reason}</p>
              </div>
            </div>
          )}

          {/* Heuristic Provenance */}
          {proposal.provenance && (
            <div className="space-y-2 pt-2 border-t border-[#1d2d4e]">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Heuristic Source Provenance
              </h3>
              <p className="text-[11px] text-slate-500">{proposal.provenance.disclaimer}</p>
              <div className="space-y-2">
                {proposal.provenance.fields.map((f) => (
                  <div
                    key={f.field}
                    className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-2.5 text-xs space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-mono font-semibold text-white">{f.field}</span>
                      <div className="flex flex-wrap gap-1">
                        {f.sources.map((src) => (
                          <span
                            key={src}
                            className="rounded bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] text-blue-300"
                          >
                            {src}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="text-slate-400">{f.notes}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Mandate + Proposed Items + Canonical Catalog Snapshot */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-400" />
              Original &amp; Compiled Mandate
            </h2>
            <CachedAiBadge cached={mandate.compilerCached} />
          </div>
          <p className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 text-sm text-slate-200">
            &quot;{mandate.originalInstruction}&quot;
          </p>
          <pre className="max-h-60 overflow-auto rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 font-mono text-[11px] text-slate-300">
            {JSON.stringify(mandate.compiledMandate, null, 2)}
          </pre>
        </section>

        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-3">
          <h2 className="text-base font-semibold text-white">
            Canonical Catalog Proposed Items
          </h2>
          <p className="text-xs text-slate-400">
            Agent submitted product IDs only; Tollgate resolved authoritative SKUs, prices, and
            warranty fields from its database.
          </p>
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 space-y-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-white">
                    {item.quantity}x {item.productName}
                  </span>
                  <span className="font-mono font-bold text-emerald-300">
                    ${item.lineTotalFormatted} {item.currency}
                  </span>
                </div>
                <div className="font-mono text-slate-400">
                  SKU: {item.sku} • Category: {item.category} • Unit: ${item.unitPriceFormatted}
                </div>
                <div className="text-slate-300">
                  Canonical Warranty:{' '}
                  <span className="text-white">
                    {String(item.canonicalSnapshot.warranty_summary ?? '—')}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 text-xs">
            <span className="text-slate-400 block mb-1">Agent Reasoning:</span>
            <p className="text-slate-200">{proposal.agentReasoning}</p>
          </div>
        </section>
      </div>

      {/* Untrusted Page Evidence & Agent Tool Trace */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-3">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Eye className="h-4 w-4 text-blue-400" />
            Untrusted Page Evidence ({pageEvidence.length})
          </h2>
          <p className="text-[11px] text-slate-400">
            SHA-256 hashes prove integrity of stored evidence text, not its truthfulness or origin.
          </p>
          {pageEvidence.length === 0 ? (
            <p className="text-xs text-slate-400">No pages recorded for this proposal.</p>
          ) : (
            <div className="space-y-3">
              {pageEvidence.map((pe) => (
                <div
                  key={pe.id}
                  className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-blue-300">{pe.storefront_path}</span>
                    <span className="font-mono text-slate-400">{pe.content_length} chars</span>
                  </div>
                  <div className="font-mono text-[10px] text-slate-400 break-all">
                    SHA-256: {pe.sha256_hash}
                  </div>
                  {pe.truncated_for_model === 1 && (
                    <div className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                      <AlertTriangle className="h-3 w-3" />
                      Truncated before model inspection ({pe.model_excerpt_length} chars sent)
                    </div>
                  )}
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#1d2d4e] bg-[#04070f] p-2.5 font-mono text-[11px] text-slate-300">
                    {pe.raw_text}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Agent Tool-Call Trace</h2>
            <CachedAiBadge cached={agentRun?.cachedOutput} />
          </div>
          {!agentRun ? (
            <p className="text-xs text-slate-400">No agent run attached.</p>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-xl border border-[#1d2d4e] bg-[#060b16] p-3.5 font-mono text-[11px] text-slate-300">
              {JSON.stringify(agentRun.toolTrace, null, 2)}
            </pre>
          )}
        </section>
      </div>

      {/* PayPal Telemetry, Verification Checks, Idempotency & Ledger Events */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
        <h2 className="text-base font-semibold text-white">
          PayPal Sandbox Lifecycle, Verification &amp; Idempotency Records
        </h2>

        {!payment ? (
          <p className="text-xs text-slate-400">No PayPal order created for this proposal.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3">
              <span className="text-slate-400 block">PayPal Order ID</span>
              <span className="font-mono text-white">{payment.paypalOrderId ?? '—'}</span>
            </div>
            <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3">
              <span className="text-slate-400 block">Authorization ID / Status</span>
              <span className="font-mono text-white">
                {payment.paypalAuthorizationId ?? '—'} ({payment.paypalAuthorizationStatus ?? '—'})
              </span>
            </div>
            <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3">
              <span className="text-slate-400 block">Capture / Void Status</span>
              <span className="font-mono text-white">
                {payment.paypalCaptureId
                  ? `${payment.paypalCaptureId} (${payment.paypalCaptureStatus})`
                  : payment.paypalVoidStatus
                    ? `VOID (${payment.paypalVoidStatus})`
                    : '—'}
              </span>
            </div>
            <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3">
              <span className="text-slate-400 block">Reference / Custom ID</span>
              <span className="font-mono text-slate-200 break-all">
                {payment.referenceId} / {payment.customId}
              </span>
            </div>
          </div>
        )}

        {paymentOperations.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Persistent UUID Idempotency Operations
            </h3>
            <div className="overflow-x-auto rounded-xl border border-[#1d2d4e]">
              <table className="w-full text-left font-mono text-xs">
                <thead className="bg-[#060b16] text-slate-400">
                  <tr>
                    <th className="p-2.5">Type</th>
                    <th className="p-2.5">Status</th>
                    <th className="p-2.5">PayPal-Request-Id</th>
                    <th className="p-2.5">Resource ID</th>
                    <th className="p-2.5">Attempts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1d2d4e]">
                  {paymentOperations.map((op) => (
                    <tr key={op.id} className="bg-[#0b1324]">
                      <td className="p-2.5 text-white">{op.operation_type}</td>
                      <td className="p-2.5">
                        <StatusPill status={op.operation_status} />
                      </td>
                      <td className="p-2.5 text-slate-300">{op.paypal_request_id}</td>
                      <td className="p-2.5 text-blue-300">{op.paypal_resource_id ?? '—'}</td>
                      <td className="p-2.5 text-slate-300">{op.attempt_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Proposal Hash-Chained Ledger Events ({ledgerEvents.length})
            </h3>
            <Link href="/ledger" className="text-xs text-blue-400 hover:underline">
              Verify full session chain →
            </Link>
          </div>
          <div className="space-y-1.5">
            {ledgerEvents.map((ev) => (
              <div
                key={ev.id}
                className="flex flex-col gap-1 rounded-lg border border-[#1d2d4e] bg-[#060b16] px-3 py-2 font-mono text-[11px] sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-slate-200">
                  #{ev.seq} <span className="text-blue-300">{ev.event_type}</span> ({ev.actor})
                </span>
                <span className="text-slate-500 truncate max-w-md">
                  H={ev.event_hash.slice(0, 20)}…
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function TransactionDetailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading transaction…</div>}>
      <TransactionDetailInner />
    </Suspense>
  );
}
