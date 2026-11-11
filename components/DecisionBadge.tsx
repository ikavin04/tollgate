import React from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Cpu } from 'lucide-react';

export function DecisionBadge({
  decision,
  size = 'sm',
}: {
  decision: string | null | undefined;
  size?: 'sm' | 'lg';
}) {
  const normalized = (decision ?? 'PENDING').toUpperCase();
  const base =
    size === 'lg'
      ? 'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold tracking-wide border'
      : 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-xs font-semibold tracking-wide border';

  if (normalized === 'ALLOW' || normalized === 'NO_ESCALATION') {
    return (
      <span className={`${base} bg-emerald-500/15 text-emerald-300 border-emerald-500/40`}>
        <CheckCircle2 className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        {normalized}
      </span>
    );
  }

  if (normalized === 'REVIEW' || normalized === 'REVIEW_PENDING') {
    return (
      <span className={`${base} bg-amber-500/15 text-amber-300 border-amber-500/40`}>
        <AlertTriangle className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        {normalized}
      </span>
    );
  }

  if (normalized === 'BLOCK' || normalized === 'BLOCKED') {
    return (
      <span className={`${base} bg-red-500/15 text-red-300 border-red-500/40`}>
        <ShieldAlert className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        {normalized}
      </span>
    );
  }

  return (
    <span className={`${base} bg-slate-700/40 text-slate-300 border-slate-600`}>
      {normalized}
    </span>
  );
}

export function CachedAiBadge({ cached }: { cached?: boolean }) {
  if (!cached) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-blue-400/40 bg-blue-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-blue-300">
      <Cpu className="h-3 w-3" />
      CACHED AI RESULT
    </span>
  );
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = (status ?? 'NOT_STARTED').toUpperCase();
  const styles =
    s === 'CAPTURED' || s === 'COMPLETED' || s === 'CONFIRMED' || s === 'APPROVED'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
      : s === 'AUTHORIZED' || s === 'ORDER_VERIFIED' || s === 'ORDER_CREATED' || s === 'PENDING'
        ? 'bg-blue-500/10 text-blue-300 border-blue-500/30'
        : s === 'VOIDED' || s === 'DENIED' || s === 'DENIED_BY_HUMAN' || s === 'NEEDS_CLARIFICATION'
          ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
          : s === 'MISMATCH_BLOCKED' || s === 'FAILED' || s === 'BLOCKED'
            ? 'bg-red-500/10 text-red-300 border-red-500/30'
            : 'bg-slate-800/70 text-slate-300 border-slate-700';

  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-xs ${styles}`}>
      {s}
    </span>
  );
}

