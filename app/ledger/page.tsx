'use client';

import React, { useEffect, useState } from 'react';
import {
  Link2,
  CheckCircle2,
  ShieldAlert,
  Download,
  BookmarkPlus,
  RefreshCw,
} from 'lucide-react';
import type {
  LedgerCheckpointRow,
  LedgerEventRow,
  LedgerVerificationResult,
} from '@/lib/ledger';

export default function LedgerVerificationPage() {
  const [verification, setVerification] = useState<LedgerVerificationResult | null>(null);
  const [events, setEvents] = useState<LedgerEventRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<LedgerCheckpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  async function refreshLedger() {
    setLoading(true);
    try {
      const res = await fetch('/api/ledger', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setVerification(data.verification);
        setEvents(data.events ?? []);
        setCheckpoints(data.checkpoints ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/ledger', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) {
          setVerification(data.verification);
          setEvents(data.events ?? []);
          setCheckpoints(data.checkpoints ?? []);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleCreateCheckpoint() {
    setCreating(true);
    try {
      await fetch('/api/session', { method: 'POST' });
      const res = await fetch('/api/ledger', { method: 'POST' });
      if (res.ok) {
        await refreshLedger();
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Link2 className="h-6 w-6 text-blue-400" />
            Tamper-Evident Evidence Ledger
          </h1>
          <p className="text-sm text-slate-400">
            Cryptographic SHA-256 hash chain:{' '}
            <code className="text-slate-200">
              H_n = SHA256(H_previous + canonical_event_json)
            </code>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => refreshLedger()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#24375f] bg-[#0b1324] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#111c33]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Re-Verify Chain
          </button>
          <button
            type="button"
            onClick={handleCreateCheckpoint}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            {creating ? 'Creating…' : 'Create Checkpoint'}
          </button>
          <a
            href="/api/ledger?export=checkpoint"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#24375f] bg-[#0b1324] px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-[#111c33]"
          >
            <Download className="h-3.5 w-3.5 text-blue-400" />
            Export Checkpoint JSON
          </a>
        </div>
      </div>

      {/* Verification Banner */}
      {verification && (
        <section
          className={`rounded-2xl border p-6 space-y-3 ${
            verification.valid
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-red-500/40 bg-red-500/10'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 text-lg font-bold text-white">
              {verification.valid ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                  Session Hash Chain Verified ({verification.eventCount} events)
                </>
              ) : (
                <>
                  <ShieldAlert className="h-5 w-5 text-red-400" />
                  Tampering Detected at Seq #{verification.tamperedEventSeq}
                </>
              )}
            </div>
            <span className="font-mono text-xs text-slate-200">
              Head Seq: #{verification.headSeq}
            </span>
          </div>

          <div className="rounded-lg border border-white/10 bg-[#060b16]/80 p-3 font-mono text-xs text-slate-200 break-all">
            Latest Head Hash: {verification.headHash}
          </div>

          {verification.failureReason && (
            <p className="text-sm text-red-200 font-semibold">{verification.failureReason}</p>
          )}

          <p className="text-xs text-slate-300">{verification.integrityNotice}</p>
        </section>
      )}

      {/* Saved Checkpoints */}
      {checkpoints.length > 0 && (
        <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-3">
          <h2 className="text-base font-semibold text-white">Saved Checkpoints</h2>
          <div className="space-y-2">
            {checkpoints.map((cp) => (
              <div
                key={cp.id}
                className="flex flex-col gap-1 rounded-xl border border-[#1d2d4e] bg-[#060b16] p-3 font-mono text-xs sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-slate-200">
                  Seq #{cp.head_seq} ({cp.event_count} events) — {new Date(cp.created_at).toLocaleString()}
                </span>
                <span className="text-blue-300 break-all">{cp.head_hash}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Full Chain Events */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
        <h2 className="text-base font-semibold text-white">
          Chronological Session Events ({events.length})
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-slate-400">No ledger events recorded in this session yet.</p>
        ) : (
          <div className="space-y-3">
            {events.map((ev) => (
              <div
                key={ev.id}
                className="rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 space-y-2 font-mono text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-blue-500/20 px-2 py-0.5 text-blue-300 font-semibold">
                      #{ev.seq}
                    </span>
                    <span className="text-white font-semibold">{ev.event_type}</span>
                    <span className="text-slate-400">by {ev.actor}</span>
                  </div>
                  <span className="text-slate-500">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                </div>

                <div className="text-[11px] text-slate-400 break-all">
                  <div>Prev: {ev.previous_hash}</div>
                  <div className="text-emerald-300">Hash: {ev.event_hash}</div>
                </div>

                <pre className="overflow-auto rounded border border-[#1d2d4e] bg-[#04070f] p-2.5 text-[11px] text-slate-300">
                  {ev.payload_json}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
