'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ShieldCheck,
  FileText,
  Bot,
  LayoutDashboard,
  FileSearch,
  Link2,
  Menu,
  X,
  Lock,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: ShieldCheck },
  { href: '/mandate', label: 'Create Mandate', icon: FileText },
  { href: '/agent', label: 'Shopping Agent', icon: Bot },
  { href: '/transactions', label: 'Transactions', icon: LayoutDashboard },
  { href: '/evidence', label: 'Evidence', icon: FileSearch },
  { href: '/ledger', label: 'Ledger', icon: Link2 },
];

export function NavBar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function ensureSession() {
      try {
        const res = await fetch('/api/session', { cache: 'no-store' });
        const data = await res.json();
        if (data?.authenticated && data?.session?.id) {
          if (active) setSessionId(data.session.id);
          return;
        }
        const postRes = await fetch('/api/session', { method: 'POST' });
        const postData = await postRes.json();
        if (active && postData?.session?.id) {
          setSessionId(postData.session.id);
        }
      } catch {
        // Ignore network error during initial hydration
      }
    }
    ensureSession();
    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-[#1d2d4e] bg-[#060b16]/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-blue-500/40 bg-blue-500/15 text-blue-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <span className="block text-sm font-bold tracking-wider text-white">TOLLGATE</span>
              <span className="block text-[10px] uppercase tracking-widest text-slate-400">
                Agent Payment Gate
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                      : 'text-slate-300 hover:bg-[#111c33] hover:text-white border border-transparent'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div
            title="Anonymous HttpOnly SameSite session isolation"
            className="hidden items-center gap-1.5 rounded-md border border-[#1d2d4e] bg-[#0b1324] px-2.5 py-1 font-mono text-xs text-slate-300 sm:flex"
          >
            <Lock className="h-3.5 w-3.5 text-emerald-400" />
            <span>Session: {sessionId ? sessionId.slice(0, 8) : 'initializing…'}</span>
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="inline-flex items-center justify-center rounded-lg border border-[#1d2d4e] bg-[#0b1324] p-2 text-slate-300 hover:text-white md:hidden"
            aria-label="Toggle navigation menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-[#1d2d4e] bg-[#0b1324] px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
                    active
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-slate-300 hover:bg-[#111c33] hover:text-white'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </header>
  );
}

