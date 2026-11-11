'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { LayoutDashboard, RefreshCw, ArrowRight } from 'lucide-react';
import { DecisionBadge, StatusPill } from '@/components/DecisionBadge';
import type { DashboardStats, ProposalListItem } from '@/lib/proposals/queries';

export default function TransactionsDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [proposals, setProposals] = useState<ProposalListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'ALL' | 'ALLOW' | 'REVIEW' | 'BLOCK'>('ALL');

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch('/api/proposals', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats);
        setProposals(data.proposals ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/proposals', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) {
          setStats(data.stats);
          setProposals(data.proposals ?? []);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visible = proposals.filter(
    (p) => filter === 'ALL' || p.finalDecision === filter
  );

  const metricCards = [
    { label: 'Total Proposals', value: stats?.totalProposals ?? 0, tone: 'text-white' },
    { label: 'Allowed', value: stats?.allowedCount ?? 0, tone: 'text-emerald-300' },
    { label: 'Reviewed', value: stats?.reviewedCount ?? 0, tone: 'text-amber-300' },
    { label: 'Blocked', value: stats?.blockedCount ?? 0, tone: 'text-red-300' },
    { label: 'Captured Payments', value: stats?.capturedCount ?? 0, tone: 'text-blue-300' },
    {
      label: 'Pending Human Decisions',
      value: stats?.pendingHumanDecisions ?? 0,
      tone: 'text-amber-300',
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <LayoutDashboard className="h-6 w-6 text-blue-400" />
            Transaction Dashboard
          </h1>
          <p className="text-sm text-slate-400">
            Session-scoped proposals, gate verdicts, human review queues, and live PayPal Sandbox statuses.
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadData()}
          className="inline-flex items-center gap-2 rounded-lg border border-[#24375f] bg-[#0b1324] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#111c33]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary Metric Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {metricCards.map((m) => (
          <div
            key={m.label}
            className="rounded-xl border border-[#1d2d4e] bg-[#0b1324] p-4 space-y-1"
          >
            <span className="block text-xs text-slate-400">{m.label}</span>
            <span className={`font-mono text-2xl font-bold ${m.tone}`}>{m.value}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {(['ALL', 'ALLOW', 'REVIEW', 'BLOCK'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setFilter(tab)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              filter === tab
                ? 'border-blue-500 bg-blue-500/20 text-blue-200'
                : 'border-[#1d2d4e] bg-[#0b1324] text-slate-400 hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Proposals List */}
      <div className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400 space-y-2">
            <p>No proposals in this session matching filter &quot;{filter}&quot;.</p>
            <Link href="/mandate" className="text-blue-400 hover:underline text-xs font-semibold">
              Start by creating a purchasing mandate →
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-[#1d2d4e]">
            {visible.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between hover:bg-[#111c33]/50 transition"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <DecisionBadge decision={p.finalDecision} />
                    <StatusPill status={p.paymentStatus ?? p.status} />
                    <span className="font-mono text-xs text-slate-400">
                      ID: {p.id.slice(0, 8)}
                    </span>
                    {p.paypalOrderId && (
                      <span className="font-mono text-xs text-blue-300">
                        Order: {p.paypalOrderId}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-white truncate">{p.itemsSummary}</p>
                  <p className="text-xs text-slate-400 truncate">
                    Mandate: &quot;{p.originalInstruction}&quot;
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4 shrink-0">
                  <div className="text-right">
                    <div className="font-mono text-base font-bold text-white">
                      ${p.totalFormatted} {p.currency}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">
                      Det: {p.deterministicDecision} • AI: {p.aiReviewerDecision}
                    </div>
                  </div>
                  <Link
                    href={`/transactions/${encodeURIComponent(p.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                  >
                    Inspect
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
