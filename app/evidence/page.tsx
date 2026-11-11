'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileSearch, AlertTriangle, RefreshCw } from 'lucide-react';
import type { PageEvidenceRow } from '@/lib/evidence';

export default function EvidenceViewerPage() {
  const [evidence, setEvidence] = useState<PageEvidenceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshEvidence = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/evidence', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setEvidence(data.evidence ?? []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetch('/api/evidence', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) setEvidence(data.evidence ?? []);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <FileSearch className="h-6 w-6 text-blue-400" />
            Untrusted Page Evidence Viewer
          </h1>
          <p className="text-sm text-slate-400">
            Every page read by the Shopping Agent is preserved verbatim as safely extracted text
            with SHA-256 fingerprints. Hashes verify integrity of stored bytes — never truthfulness.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refreshEvidence()}
          className="inline-flex items-center gap-2 rounded-lg border border-[#24375f] bg-[#0b1324] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#111c33]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {evidence.length === 0 ? (
        <div className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-8 text-center text-sm text-slate-400">
          No storefront page evidence captured in this session yet. Run the Shopping Agent first.
        </div>
      ) : (
        <div className="space-y-4">
          {evidence.map((ev) => {
            const hasHiddenContent =
              ev.raw_text.includes('[HIDDEN_ELEMENT_TEXT]') ||
              ev.raw_text.includes('[HTML_COMMENT]');
            return (
              <div
                key={ev.id}
                className={`rounded-2xl border bg-[#0b1324] p-5 space-y-3 ${
                  hasHiddenContent ? 'border-amber-500/40' : 'border-[#1d2d4e]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-mono text-sm font-semibold text-blue-300">
                      {ev.storefront_path}
                    </span>
                    {hasHiddenContent && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[11px] text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        HIDDEN TEXT / COMMENT DETECTED
                      </span>
                    )}
                    {ev.truncated_for_model === 1 && (
                      <span className="rounded bg-red-500/20 px-2 py-0.5 font-mono text-[11px] text-red-300">
                        TRUNCATED FOR MODEL ({ev.model_excerpt_length} / {ev.content_length})
                      </span>
                    )}
                  </div>

                  {ev.proposal_id && (
                    <Link
                      href={`/transactions/${encodeURIComponent(ev.proposal_id)}`}
                      className="text-xs font-semibold text-blue-400 hover:underline"
                    >
                      View Proposal →
                    </Link>
                  )}
                </div>

                <div className="grid gap-2 text-xs font-mono text-slate-400 sm:grid-cols-3">
                  <div>Evidence ID: {ev.id.slice(0, 12)}…</div>
                  <div>Length: {ev.content_length} chars</div>
                  <div>Captured: {new Date(ev.created_at).toLocaleString()}</div>
                </div>

                <div className="rounded-lg border border-[#1d2d4e] bg-[#060b16] px-3 py-2 font-mono text-[11px] text-slate-300 break-all">
                  SHA-256: {ev.sha256_hash}
                </div>

                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-[#1d2d4e] bg-[#04070f] p-4 font-mono text-xs leading-relaxed text-slate-200">
                  {ev.raw_text}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
