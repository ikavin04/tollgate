import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  classifyGeminiError,
  computeBackoffWithJitterMs,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_RETRY_BASE_DELAY_MS,
  GEMINI_RETRY_MAX_DELAY_MS,
  GeminiUnavailableError,
  generateWithGemini,
  MAX_GEMINI_RETRIES,
} from '@/lib/ai/gemini';
import { openDatabase, setDbForTests } from '@/lib/db';
import { compileAndStoreMandate, confirmMandate } from '@/lib/mandate/compiler';
import { evaluateAndStoreProposal } from '@/lib/proposals/orchestrator';
import { createSessionRecord } from '@/lib/session';

describe('Gemini Availability, Retry & Fail-Closed Resilience', () => {
  let db: Database.Database;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    db = openDatabase(':memory:');
    setDbForTests(db);
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setDbForTests(undefined);
    db.close();
  });

  it('uses 45-60s timeout and bounded exponential backoff with jitter', () => {
    expect(DEFAULT_GEMINI_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(DEFAULT_GEMINI_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(MAX_GEMINI_RETRIES).toBe(2);

    const d0Min = computeBackoffWithJitterMs(0, () => 0);
    const d0Max = computeBackoffWithJitterMs(0, () => 0.999);
    expect(d0Min).toBe(GEMINI_RETRY_BASE_DELAY_MS);
    expect(d0Max).toBeGreaterThan(d0Min);
    expect(d0Max).toBeLessThanOrEqual(GEMINI_RETRY_MAX_DELAY_MS);

    const d1 = computeBackoffWithJitterMs(1, () => 0.5);
    expect(d1).toBeGreaterThanOrEqual(GEMINI_RETRY_BASE_DELAY_MS * 2);
    expect(d1).toBeLessThanOrEqual(GEMINI_RETRY_MAX_DELAY_MS);
  });

  it('retries transient HTTP 503 with backoff and succeeds when upstream recovers', async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await generateWithGemini({
      contents: 'hello',
      config: { temperature: 0 },
      sleepFn: async (ms) => {
        delays.push(ms);
      },
      randomFn: () => 0.25,
      clientOverride: {
        models: {
          generateContent: async () => {
            calls += 1;
            if (calls < 3) {
              const err = new Error(
                '{"error":{"code":503,"message":"High demand","status":"UNAVAILABLE"}}'
              ) as Error & { status?: number };
              err.status = 503;
              throw err;
            }
            return { text: '{"ok":true}' } as never;
          },
        },
      },
    });

    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(result.text).toBe('{"ok":true}');
  });

  it('caps retries on persistent 503 / timeouts and throws retryable GeminiUnavailableError', async () => {
    let calls = 0;
    const delays: number[] = [];

    await expect(
      generateWithGemini({
        contents: 'hello',
        config: {},
        sleepFn: async (ms) => {
          delays.push(ms);
        },
        clientOverride: {
          models: {
            generateContent: async () => {
              calls += 1;
              const err = new Error('The operation was aborted due to timeout');
              err.name = 'TimeoutError';
              throw err;
            },
          },
        },
      })
    ).rejects.toMatchObject({
      name: 'GeminiUnavailableError',
      retryable: true,
      attemptsMade: MAX_GEMINI_RETRIES + 1,
    });

    expect(calls).toBe(MAX_GEMINI_RETRIES + 1);
    expect(delays).toHaveLength(MAX_GEMINI_RETRIES);
  });

  it('retries retryable 429 rate-limits but never retries permanent quota=0, 400, 401, or 403 errors', async () => {
    // 1. Retryable 429 recovers on 2nd attempt
    let calls429 = 0;
    await generateWithGemini({
      contents: 'hi',
      config: {},
      sleepFn: async () => {},
      clientOverride: {
        models: {
          generateContent: async () => {
            calls429 += 1;
            if (calls429 === 1) {
              const err = new Error('Resource exhausted temporarily, try again') as Error & {
                status?: number;
              };
              err.status = 429;
              throw err;
            }
            return { text: 'ok' } as never;
          },
        },
      },
    });
    expect(calls429).toBe(2);

    // 2. Permanent 429 (limit: 0 / billing) must NOT retry
    const perm429 = Object.assign(
      new Error('Quota exceeded for quota metric, limit: 0'),
      { status: 429 }
    );
    expect(classifyGeminiError(perm429).retryable).toBe(false);

    // 3. Permanent 401/403/400 API key or malformed errors must NOT retry
    for (const [status, msg] of [
      [400, 'INVALID_ARGUMENT: malformed schema'],
      [401, 'API key not valid'],
      [403, 'PERMISSION_DENIED'],
      [404, 'Model not found'],
    ] as const) {
      let calls = 0;
      await expect(
        generateWithGemini({
          contents: 'hi',
          config: {},
          sleepFn: async () => {
            throw new Error('Sleep should never run for permanent 4xx errors');
          },
          clientOverride: {
            models: {
              generateContent: async () => {
                calls += 1;
                const err = new Error(msg) as Error & { status?: number };
                err.status = status;
                throw err;
              },
            },
          },
        })
      ).rejects.toBeInstanceOf(GeminiUnavailableError);
      expect(calls).toBe(1);
    }
  });

  it('preserves fail-closed REVIEW (never ALLOW) when Gemini is unavailable during review', async () => {
    const { session } = createSessionRecord(db);
    const compiled = await compileAndStoreMandate(db, {
      sessionId: session.id,
      instruction: 'Buy one new laptop under $500 from Northstar.',
      llmCaller: async () => ({
        intent_summary: 'Laptop',
        max_total: 500,
        currency: 'USD',
        max_quantity: 1,
        allowed_categories: ['laptop'],
        allowed_accessory_categories: [],
        allowed_brands: ['Northstar'],
        allowed_conditions: ['new'],
        hard_requirements: { condition: 'new' },
        soft_requirements: [],
        accessories_allowed: false,
        approval_above: 450,
        expires_at: null,
        warnings: [],
        unresolved_requirements: [],
      }),
    });
    confirmMandate(db, { sessionId: session.id, mandateId: compiled.mandateRow.id });

    const outcome = await evaluateAndStoreProposal(db, {
      sessionId: session.id,
      mandateId: compiled.mandateRow.id,
      requestedItems: [{ product_id: 'prod-ns-devbook-16', quantity: 1 }],
      agentReasoning: 'Clean Northstar laptop.',
      llmReviewer: async () => {
        throw new GeminiUnavailableError('Gemini (gemini-3.5-flash-lite) temporarily unavailable (503)', {
          upstreamStatus: 503,
          retryable: true,
          attemptsMade: 3,
        });
      },
    });

    expect(outcome.deterministicDecision).toBe('ALLOW');
    expect(outcome.aiReviewerDecision).toBe('REVIEW');
    expect(outcome.finalDecision).toBe('REVIEW');
  });
});

