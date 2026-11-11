'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  ArrowRight,
  Lock,
  Cpu,
  Scale,
  Eye,
  CreditCard,
  Link2,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Activity,
} from 'lucide-react';

interface HealthStatus {
  status: string;
  database: { ok: boolean; seededProducts: number; migrationsApplied: number };
  environment: {
    ok: boolean;
    missing: string[];
    paypalMode: string;
    geminiModel: string;
  };
}

export default function LandingPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => null);
  }, []);

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-gradient-to-br from-[#0b1324] via-[#0d172c] to-[#08101f] p-6 sm:p-10 shadow-2xl">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              AI-Agent Payment Security Gateway • PayPal Sandbox
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
              Every AI purchase must pass the gate.
            </h1>
            <p className="text-base leading-relaxed text-slate-300 sm:text-lg">
              An AI shopping agent may recommend a purchase.{' '}
              <span className="font-semibold text-white">
                It cannot independently decide to move the user&apos;s money.
              </span>{' '}
              Tollgate compiles human intent into strict policy mandates, isolates PayPal credentials
              from the agent, reviews untrusted storefront evidence, and enforces deterministic + AI
              gate checks before PayPal Orders v2 authorization, capture, or void.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link
                href="/mandate"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Create Purchasing Mandate
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/agent"
                className="inline-flex items-center gap-2 rounded-lg border border-[#2a3f68] bg-[#111c33] px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-[#162442]"
              >
                Launch Shopping Agent
              </Link>
              <Link
                href="/transactions"
                className="inline-flex items-center gap-2 rounded-lg border border-[#1d2d4e] bg-[#0b1324] px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:text-white"
              >
                Transaction Dashboard
              </Link>
            </div>
          </div>

          {/* System Readiness Card */}
          <div className="w-full max-w-md rounded-xl border border-[#1d2d4e] bg-[#060b16]/90 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#1d2d4e] pb-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Activity className="h-4 w-4 text-blue-400" />
                Gateway Runtime Status
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${
                  health?.database?.ok
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                }`}
              >
                {health ? (health.database.ok ? 'READY' : 'DEGRADED') : 'CHECKING…'}
              </span>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">SQLite &amp; Seeded Storefront</span>
                <span className="font-mono text-slate-200">
                  {health ? `${health.database.seededProducts} SKUs (${health.database.migrationsApplied} mig)` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">PayPal Mode</span>
                <span className="font-mono uppercase text-blue-300">
                  {health?.environment?.paypalMode ?? 'sandbox'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Gemini Model ID</span>
                <span className="font-mono text-slate-200">
                  {health?.environment?.geminiModel ?? 'gemini-3.5-flash-lite'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Credentials Configured</span>
                <span
                  className={`font-mono ${
                    health?.environment?.ok ? 'text-emerald-300' : 'text-amber-300'
                  }`}
                >
                  {health
                    ? health.environment.ok
                      ? 'ALL SET'
                      : `MISSING: ${health.environment.missing.join(', ')}`
                    : '—'}
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-[#1d2d4e] bg-[#0b1324] p-3 text-[11px] leading-relaxed text-slate-400">
              <Lock className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
              PayPal secrets and Gemini API keys remain strictly server-side. Each browser receives
              an isolated anonymous <code className="text-slate-200">HttpOnly</code> session.
            </div>
          </div>
        </div>
      </section>

      {/* Architecture Pipeline */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">Security Pipeline Architecture</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: FileTextIcon,
              title: '1. Mandate Compiler',
              desc: 'Converts plain-English instructions into Zod-validated policy JSON via Gemini 3.5 Flash-Lite. Flags ambiguous brand lists or conflicting requirements before human confirmation.',
            },
            {
              icon: Cpu,
              title: '2. Isolated Shopping Agent',
              desc: 'Restricted strictly to search_store, read_page, and propose_purchase. Zero PayPal tokens, zero pricing authority — Tollgate resolves canonical SKUs & prices.',
            },
            {
              icon: Eye,
              title: '3. Evidence & SHA-256 Provenance',
              desc: 'Captures complete raw page text (including hidden HTML & comments), hashes every page with SHA-256, and escalates to REVIEW if model evidence limits truncate.',
            },
            {
              icon: Scale,
              title: '4. Deterministic Policy Engine',
              desc: 'Pure TypeScript checks budget, category, brand allow-list, quantity, condition, mandatory specs, gift-card isolation, and structured 16 GB RAM soft preferences.',
            },
            {
              icon: ShieldCheck,
              title: '5. Independent AI Intent Reviewer',
              desc: 'Separate Gemini 3.5 Flash-Lite invocation with isolated system instructions compares canonical catalog specs against untrusted webpage prose; fails closed to REVIEW.',
            },
            {
              icon: CreditCard,
              title: '6. PayPal Sandbox & Evidence Ledger',
              desc: 'Executes live PayPal Orders v2 AUTHORIZE, verifies order & authorization amounts/references/items, and separates buyer approval from Tollgate human Capture or Void.',
            },
          ].map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.title}
                className="rounded-xl border border-[#1d2d4e] bg-[#0b1324] p-5 space-y-2.5"
              >
                <div className="flex items-center gap-2.5 text-blue-300">
                  <Icon className="h-5 w-5" />
                  <h3 className="font-semibold text-white">{card.title}</h3>
                </div>
                <p className="text-sm leading-relaxed text-slate-400">{card.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Showcase Scenarios */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Core Demonstration Scenarios</h2>
          <Link href="/agent" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            Run live in Shopping Agent →
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-500/30 bg-[#0b1324] p-5 space-y-2">
            <div className="flex items-center gap-2 text-emerald-300 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              Scenario A — ALLOW ($449 Verified Laptop)
            </div>
            <p className="text-sm text-slate-300">
              Mandate asks for one new laptop under $500, preferring 16 GB RAM from Northstar with no
              accessories. Agent proposes Northstar DevBook 14 ($449). Gate passes, buyer approves
              PayPal checkout, authorization and capture succeed, and a hash-chained receipt is issued.
            </p>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-[#0b1324] p-5 space-y-2">
            <div className="flex items-center gap-2 text-amber-300 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              Scenario B — REVIEW &amp; VOID (Ambiguous Bundle)
            </div>
            <p className="text-sm text-slate-300">
              Agent proposes the $475 Northstar Commuter Laptop Bundle. Tollgate routes it to REVIEW.
              Buyer approves PayPal checkout and PayPal authorizes the order, then the human denies it
              inside Tollgate — triggering a live PayPal Authorization Void.
            </p>
          </div>

          <div className="rounded-xl border border-red-500/30 bg-[#0b1324] p-5 space-y-2">
            <div className="flex items-center gap-2 text-red-300 font-semibold">
              <ShieldAlert className="h-4 w-4" />
              Scenario C — BLOCK (Hidden 10 Gift Cards Attack)
            </div>
            <p className="text-sm text-slate-300">
              Malicious product page ($399 laptop) hides prompt injection demanding 10x $10 gift cards
              ($499 total — still under $500!). Tollgate detects unauthorized gift_card category &amp;
              quantity and blocks BEFORE any PayPal order is created.
            </p>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-[#0b1324] p-5 space-y-2">
            <div className="flex items-center gap-2 text-amber-300 font-semibold">
              <Link2 className="h-4 w-4" />
              Scenario D — AI Escalation (Contradictory Warranty)
            </div>
            <p className="text-sm text-slate-300">
              Listing ($445) passes every hard budget/brand rule, yet hidden webpage prose falsely
              claims a free 3-year extended warranty contradicting the canonical catalog. The
              independent AI reviewer spots the discrepancy and escalates.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function FileTextIcon({ className }: { className?: string }) {
  return <Scale className={className} />;
}
