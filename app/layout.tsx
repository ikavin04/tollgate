import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';
import { NavBar } from '@/components/NavBar';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'TOLLGATE — Every AI purchase must pass the gate',
  description:
    'Intent-verification and payment-authorization gateway isolating AI shopping agents from PayPal Sandbox payment execution.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="tg-grid-bg min-h-full flex flex-col bg-[#060b16] text-[#e5edf8]">
        <Suspense fallback={<div className="h-[61px] border-b border-[#1d2d4e] bg-[#060b16]" />}>
          <NavBar />
        </Suspense>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
        <footer className="border-t border-[#1d2d4e] bg-[#060b16]/90 py-4 text-xs text-slate-400">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span>
              Tollgate — AI-Agent Payment Security Gateway (PayPal Sandbox MVP). Shopping agents hold zero payment credentials.
            </span>
            <span>
              Tamper-evident SHA-256 session ledger • Local SQLite may reset on ephemeral free hosting restarts.
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
