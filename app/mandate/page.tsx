'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FileText,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { CachedAiBadge, StatusPill } from '@/components/DecisionBadge';
import type { CompiledMandate } from '@/lib/mandate/schema';

interface MandateListItem {
  id: string;
  originalInstruction: string;
  compiledMandate: CompiledMandate;
  status: string;
  compilerModel: string;
  compilerCached: boolean;
  confirmedAt: string | null;
  createdAt: string;
}

const PRESET_INSTRUCTIONS = [
  {
    label: 'Clean Laptop ($500 / 16GB / Northstar)',
    text: 'Buy one new laptop under $500. Prefer 16 GB RAM. Approved brands: Northstar. No accessories.',
  },
  {
    label: 'Scenario B Bundle Review (Approve > $450)',
    text: 'Buy one new Northstar laptop or bundle under $500. Prefer 16 GB RAM. Require human approval above $450.',
  },
  {
    label: 'Ambiguous Brands Test (Triggers Clarification)',
    text: 'Buy one new laptop under $500. Prefer 16 GB RAM. Only approved brands. No accessories.',
  },
];

const KNOWN_BRANDS = ['Northstar', 'ApexTech', 'Vanguard', 'Kestrel'];
const KNOWN_CATEGORIES = ['laptop', 'accessory', 'gift_card', 'bundle'];

export default function MandatePage() {
  const [instruction, setInstruction] = useState(PRESET_INSTRUCTIONS[0].text);
  const [forceFresh, setForceFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [error, setError] = useState<{
    message: string;
    code?: string;
    retryable?: boolean;
  } | null>(null);

  const [activeDraft, setActiveDraft] = useState<{
    mandateId: string;
    status: string;
    compilerModel: string;
    cached: boolean;
    originalInstruction: string;
    compiledMandate: CompiledMandate;
  } | null>(null);

  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [clarifiedBudget, setClarifiedBudget] = useState<string>('');
  const [mandates, setMandates] = useState<MandateListItem[]>([]);

  async function loadMandates() {
    const res = await fetch('/api/mandates', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setMandates(data.mandates ?? []);
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/mandates', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) setMandates(data.mandates ?? []);
      })
      .catch(() => null);
    return () => {
      active = false;
    };
  }, []);

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await fetch('/api/session', { method: 'POST' });
      const res = await fetch('/api/mandates/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, forceFresh }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({
          message: data.error || 'Failed to compile mandate',
          code: data.code,
          retryable: data.retryable,
        });
        return;
      }
      setActiveDraft(data);
      setSelectedBrands(data.compiledMandate.allowed_brands ?? []);
      setSelectedCategories(data.compiledMandate.allowed_categories ?? []);
      setClarifiedBudget(String(data.compiledMandate.max_total ?? 500));
      await loadMandates();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Mandate compilation failed',
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!activeDraft) return;
    setConfirmLoading(true);
    setError(null);
    try {
      const hasUnresolved = activeDraft.compiledMandate.unresolved_requirements.length > 0;
      const clarifications = hasUnresolved
        ? {
            allowed_brands: selectedBrands.length > 0 ? selectedBrands : undefined,
            allowed_categories: selectedCategories.length > 0 ? selectedCategories : undefined,
            max_total: clarifiedBudget ? Number(clarifiedBudget) : undefined,
          }
        : undefined;

      const res = await fetch(`/api/mandates/${encodeURIComponent(activeDraft.mandateId)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clarifications ? { clarifications } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({
          message: data.error || 'Failed to confirm mandate',
          code: data.code,
          retryable: data.retryable,
        });
        return;
      }
      setActiveDraft({
        ...activeDraft,
        status: data.status,
        compiledMandate: data.compiledMandate,
      });
      await loadMandates();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Confirmation failed',
      });
    } finally {
      setConfirmLoading(false);
    }
  }

  function toggleBrand(brand: string) {
    setSelectedBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  }

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <FileText className="h-6 w-6 text-blue-400" />
            Mandate Compiler
          </h1>
          <p className="text-sm text-slate-400">
            Compile plain-English purchasing instructions into Zod-validated JSON rules. Unresolved or
            ambiguous requirements must be clarified before human activation.
          </p>
        </div>
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
              Gemini AI is temporarily unavailable due to high upstream demand or timeout. No mandate was created or activated — please try again shortly.
            </div>
          )}
          <div className="text-xs opacity-90">{error.message}</div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Input Form */}
        <form
          onSubmit={handleCompile}
          className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-5"
        >
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Quick Presets
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESET_INSTRUCTIONS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setInstruction(preset.text)}
                  className="rounded-lg border border-[#24375f] bg-[#111c33] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-blue-500/50 hover:text-white"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="instruction"
              className="block text-sm font-semibold text-white"
            >
              Human Purchasing Instruction
            </label>
            <textarea
              id="instruction"
              rows={5}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={1500}
              required
              className="w-full rounded-xl border border-[#24375f] bg-[#060b16] p-3.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              placeholder='e.g. "Buy one new laptop under $500. Prefer 16 GB RAM. Approved brands: Northstar. No accessories."'
            />
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{instruction.length} / 1500 chars</span>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceFresh}
                  onChange={(e) => setForceFresh(e.target.checked)}
                  className="rounded border-slate-600 bg-[#060b16]"
                />
                Bypass AI cache (fresh Gemini call)
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {loading ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Compiling via Gemini 3.5 Flash-Lite…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Compile Mandate JSON
              </>
            )}
          </button>
        </form>

        {/* Right: Compiled Output + Clarification + Confirmation */}
        <div className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-5">
          {!activeDraft ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-slate-400 space-y-2">
              <FileText className="h-10 w-10 text-slate-600" />
              <p className="text-sm font-medium text-slate-300">No draft compiled yet</p>
              <p className="max-w-sm text-xs">
                Submit an instruction on the left to inspect the structured mandate, resolve any
                gaps, and explicitly confirm it before running the Shopping Agent.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1d2d4e] pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">Compiled Mandate</span>
                  <StatusPill status={activeDraft.status} />
                  <CachedAiBadge cached={activeDraft.cached} />
                </div>
                <span className="font-mono text-xs text-slate-400">
                  {activeDraft.compilerModel}
                </span>
              </div>

              {activeDraft.compiledMandate.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
                  {activeDraft.compiledMandate.warnings.map((w, idx) => (
                    <div key={idx}>• {w}</div>
                  ))}
                </div>
              )}

              {activeDraft.compiledMandate.unresolved_requirements.length > 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                    <AlertTriangle className="h-4 w-4" />
                    Human Clarification Required Before Activation
                  </div>

                  <div className="space-y-2 text-xs text-amber-100">
                    {activeDraft.compiledMandate.unresolved_requirements.map((u) => (
                      <div key={`${u.code}-${u.field}`} className="rounded bg-[#060b16]/60 p-2.5">
                        <span className="font-mono text-amber-300">[{u.code}]</span> {u.question}
                      </div>
                    ))}
                  </div>

                  {activeDraft.compiledMandate.unresolved_requirements.some(
                    (u) => u.field === 'allowed_brands'
                  ) && (
                    <div className="space-y-1.5">
                      <span className="block text-xs font-semibold text-white">
                        Select Approved Brands:
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {KNOWN_BRANDS.map((brand) => (
                          <button
                            key={brand}
                            type="button"
                            onClick={() => toggleBrand(brand)}
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                              selectedBrands.includes(brand)
                                ? 'border-blue-400 bg-blue-500/20 text-blue-200'
                                : 'border-[#24375f] bg-[#060b16] text-slate-400'
                            }`}
                          >
                            {brand}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeDraft.compiledMandate.unresolved_requirements.some(
                    (u) => u.field === 'allowed_categories'
                  ) && (
                    <div className="space-y-1.5">
                      <span className="block text-xs font-semibold text-white">
                        Select Allowed Storefront Categories:
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {KNOWN_CATEGORIES.map((cat) => (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => toggleCategory(cat)}
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                              selectedCategories.includes(cat)
                                ? 'border-blue-400 bg-blue-500/20 text-blue-200'
                                : 'border-[#24375f] bg-[#060b16] text-slate-400'
                            }`}
                          >
                            {cat}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeDraft.compiledMandate.unresolved_requirements.some(
                    (u) => u.field === 'max_total'
                  ) && (
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-white">
                        Specify Max Total Budget (USD):
                      </label>
                      <input
                        type="number"
                        min={1}
                        step="1"
                        value={clarifiedBudget}
                        onChange={(e) => setClarifiedBudget(e.target.value)}
                        className="w-40 rounded-lg border border-[#24375f] bg-[#060b16] px-3 py-1.5 text-sm text-white"
                      />
                    </div>
                  )}
                </div>
              )}

              <pre className="max-h-72 overflow-auto rounded-xl border border-[#1d2d4e] bg-[#060b16] p-3.5 font-mono text-xs text-slate-200">
                {JSON.stringify(activeDraft.compiledMandate, null, 2)}
              </pre>

              {activeDraft.status !== 'CONFIRMED' ? (
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirmLoading}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {confirmLoading
                    ? 'Confirming Mandate…'
                    : activeDraft.compiledMandate.unresolved_requirements.length > 0
                      ? 'Apply Clarifications & Confirm Mandate'
                      : 'Confirm & Activate Mandate'}
                </button>
              ) : (
                <Link
                  href={`/agent?mandateId=${encodeURIComponent(activeDraft.mandateId)}`}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
                >
                  Mandate Active — Proceed to Shopping Agent
                  <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </>
          )}
        </div>
      </div>

      {/* Session Mandates Table */}
      <section className="rounded-2xl border border-[#1d2d4e] bg-[#0b1324] p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Session Mandates</h2>
        {mandates.length === 0 ? (
          <p className="text-sm text-slate-400">No mandates created in this session yet.</p>
        ) : (
          <div className="space-y-3">
            {mandates.map((m) => (
              <div
                key={m.id}
                className="flex flex-col gap-3 rounded-xl border border-[#1d2d4e] bg-[#060b16] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={m.status} />
                    <CachedAiBadge cached={m.compilerCached} />
                    <span className="font-mono text-xs text-slate-400">
                      Max ${m.compiledMandate.max_total} • Qty {m.compiledMandate.max_quantity} •
                      Brands:{' '}
                      {m.compiledMandate.allowed_brands.length > 0
                        ? m.compiledMandate.allowed_brands.join(', ')
                        : 'Any'}
                    </span>
                  </div>
                  <p className="text-sm text-slate-200">{m.originalInstruction}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDraft({
                        mandateId: m.id,
                        status: m.status,
                        compilerModel: m.compilerModel,
                        cached: m.compilerCached,
                        originalInstruction: m.originalInstruction,
                        compiledMandate: m.compiledMandate,
                      });
                      setSelectedBrands(m.compiledMandate.allowed_brands ?? []);
                      setSelectedCategories(m.compiledMandate.allowed_categories ?? []);
                      setClarifiedBudget(String(m.compiledMandate.max_total ?? 500));
                    }}
                    className="rounded-lg border border-[#24375f] px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
                  >
                    Inspect
                  </button>
                  {m.status === 'CONFIRMED' && (
                    <Link
                      href={`/agent?mandateId=${encodeURIComponent(m.id)}`}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                    >
                      Run Agent →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
