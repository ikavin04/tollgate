'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Bot,
  Play,
  Store,
  ArrowRight,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { CachedAiBadge, DecisionBadge, StatusPill } from '@/components/DecisionBadge';

interface MandateOption {
  id: string;
  originalInstruction: string;
  status: string;
  compiledMandate: {
    max_total: number;
    allowed_brands: string[];
    allowed_categories: string[];
    accessories_allowed: boolean;
  };
}

interface StorefrontProduct {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  price_usd: string;
  condition: string;
  ram_gb: number | null;
  storage_gb: number | null;
  warranty_summary: string;
  safe_extracted_page_text: string;
}

function AgentWorkspaceInner() {
  const searchParams = useSearchParams();
  const initialMandateId = searchParams.get('mandateId') ?? '';

  const [mandates, setMandates] = useState<MandateOption[]>([]);
  const [selectedMandateId, setSelectedMandateId] = useState(initialMandateId);
  const [forceFresh, setForceFresh] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{
    message: string;
    code?: string;
    retryable?: boolean;
  } | null>(null);
  const [products, setProducts] = useState<StorefrontProduct[]>([]);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  const [runResult, setRunResult] = useState<{
    proposalId: string;
    finalDecision: string;
    deterministicDecision: string;
    aiReviewerDecision: string;
    agentCached: boolean;
    aiReviewerCached: boolean;
    totalAmountCents: number;
    currency: string;
  } | null>(null);

  useEffect(() => {
    async function load() {
      const [mRes, pRes] = await Promise.all([
        fetch('/api/mandates', { cache: 'no-store' }),
        fetch('/api/storefront/products?includePageText=true', {
          cache: 'no-store',
        }),
      ]);
      if (mRes.ok) {
        const mData = await mRes.json();
        const confirmed = (mData.mandates ?? []).filter(
          (m: MandateOption) => m.status === 'CONFIRMED'
        );
        setMandates(confirmed);
        if (!selectedMandateId && confirmed.length > 0) {
          setSelectedMandateId(confirmed[0].id);
        }
      }
      if (pRes.ok) {
        const pData = await pRes.json();
        setProducts(pData.products ?? []);
      }
    }
    load().catch(() => null);
  }, [selectedMandateId]);

  async function handleRunAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedMandateId) return;
    setRunning(true);
    setError(null);
    setRunResult(null);

    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mandateId: selectedMandateId,
          forceFresh,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({
          message: data.error || 'Agent execution failed',
          code: data.code,
          retryable: data.retryable,
        });
        return;
      }
      setRunResult(data);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Agent run failed',
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
          <Bot className="h-6 w-6 text-blue-400" />
          Shopping Agent &amp; Simulated Storefront
        </h1>
        <p className="text-sm text-slate-400">
          The agent has ONLY three tools (search_store, read_page, propose_purchase) and zero
          PayPal credentials. Every proposal enters the Tollgate verification gate.
        </p>
      </div>

      {error && (
        <div
          className={`rounded-xl border p-4 text-sm space-y-1 ${
            error.code === 'GEMINI_UNAVAILABLE'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-red-500/40 bg-red-500/10 text-red-300'
          }`}
        >
          {error.code === 'GEMINI_UNAVAILABLE' && (
            <div className="font-semibold text-amber-300">
              Gemini AI is temporarily unavailable (fail-closed: no purchase proposal was allowed and no PayPal order was created). Please retry shortly.
            </div>
          )}
          <div className="text-xs opacity-90">{error.message}</div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={handleRunAgent}
          className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-5"
        >
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-white">
              Confirmed Active Mandate
            </label>
            {mandates.length === 0 ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200 space-y-2">
                <p>No confirmed mandates in this session yet.</p>
                <Link
                  href="/mandate"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-300 hover:underline"
                >
                  Create &amp; Confirm a Mandate first →
                </Link>
              </div>
            ) : (
              <select
                value={selectedMandateId}
                onChange={(e) => setSelectedMandateId(e.target.value)}
                className="w-full rounded-xl border border-[#24375f] bg-[#060b16] p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
              >
                {mandates.map((m) => (
                  <option key={m.id} value={m.id}>
                    [Max ${m.compiledMandate.max_total}] {m.originalInstruction.slice(0, 85)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-3.5 text-xs text-slate-300 space-y-1">
            <div className="font-semibold text-white">Autonomous Evaluation Mode</div>
            <p className="text-slate-400">
              The shopping agent searches the catalogue autonomously with zero scenario hints or
              attack labels, must read candidate product pages via <code>read_page</code>, and
              submits its recommendation through the dual Tollgate verification gate.
            </p>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={forceFresh}
              onChange={(e) => setForceFresh(e.target.checked)}
              className="rounded border-slate-600 bg-[#060b16]"
            />
            Bypass AI cache (run live Gemini agent + reviewer)
          </label>

          <button
            type="submit"
            disabled={running || mandates.length === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {running ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Agent Searching, Reading Pages &amp; Passing Tollgate…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run Shopping Agent &amp; Evaluate Gate
              </>
            )}
          </button>
        </form>

        {/* Gate Evaluation Output */}
        <div className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
          {!runResult ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center text-slate-400 space-y-2">
              <ShieldAlert className="h-10 w-10 text-slate-600" />
              <p className="text-sm font-medium text-slate-300">Gate Evaluation Pending</p>
              <p className="max-w-sm text-xs">
                Run the Shopping Agent to inspect tool calls, page hashes, deterministic policy
                checks, independent AI intent review, and PayPal checkout authorization.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1d2d4e] pb-3">
                <span className="text-sm font-semibold text-white">Tollgate Verdict</span>
                <DecisionBadge decision={runResult.finalDecision} size="lg" />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 space-y-1">
                  <span className="text-slate-400 block">Deterministic Engine</span>
                  <DecisionBadge decision={runResult.deterministicDecision} />
                </div>
                <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 space-y-1">
                  <span className="text-slate-400 block">AI Intent Reviewer</span>
                  <div className="flex items-center gap-2">
                    <DecisionBadge decision={runResult.aiReviewerDecision} />
                    <CachedAiBadge cached={runResult.aiReviewerCached} />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-[#1d2d4e] bg-[#060b16] p-3 text-sm">
                <span className="text-slate-400">Canonical Server Total</span>
                <span className="font-mono font-bold text-white">
                  ${(runResult.totalAmountCents / 100).toFixed(2)} {runResult.currency}
                </span>
              </div>

              {(runResult.agentCached || runResult.aiReviewerCached) && (
                <div className="flex items-center gap-2 text-xs text-blue-300">
                  <CachedAiBadge cached />
                  <span>
                    One or more AI stages served from session LLM cache (PayPal calls are never cached).
                  </span>
                </div>
              )}

              <Link
                href={`/transactions/${encodeURIComponent(runResult.proposalId)}`}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Open Full Gate Inspection &amp; PayPal Controls
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Simulated Storefront Catalog */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Store className="h-5 w-5 text-blue-400" />
            Controlled Fake Storefront Catalog ({products.length} SKUs)
          </h2>
          <span className="text-xs text-slate-400">
            Untrusted HTML/JS never executed; hidden injections safely extracted as text
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {products.map((p) => {
            const expanded = expandedProductId === p.id;
            return (
              <div
                key={p.id}
                className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sm text-white">{p.name}</span>
                    </div>
                    <div className="font-mono text-xs text-slate-400 mt-0.5">
                      {p.sku} • {p.brand} • {p.category} • {p.condition}
                      {p.ram_gb ? ` • ${p.ram_gb}GB RAM` : ''}
                      {p.storage_gb ? ` / ${p.storage_gb}GB` : ''}
                    </div>
                  </div>
                  <span className="font-mono text-sm font-bold text-emerald-300 shrink-0">
                    ${p.price_usd}
                  </span>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <StatusPill status={p.category} />
                  <button
                    type="button"
                    onClick={() => setExpandedProductId(expanded ? null : p.id)}
                    className="text-xs font-medium text-blue-400 hover:underline"
                  >
                    {expanded ? 'Hide Extracted Page Text' : 'Inspect Raw Extracted Page Text'}
                  </button>
                </div>

                {expanded && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-[#1d2d4e] bg-[#04070f] p-3 font-mono text-[11px] text-slate-300">
                    {p.safe_extracted_page_text}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading Shopping Agent…</div>}>
      <AgentWorkspaceInner />
    </Suspense>
  );
}

