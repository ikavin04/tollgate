import 'server-only';
import { GoogleGenAI, type GenerateContentConfig, type ContentListUnion } from '@google/genai';
import type Database from 'better-sqlite3';
import { sha256Canonical, sha256Hex } from '@/lib/crypto';
import { getGeminiConfig } from '@/lib/env';

export const MAX_GEMINI_INPUT_CHARS = 24_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_GEMINI_TIMEOUT_MS = 50_000;
export const MAX_GEMINI_RETRIES = 2;
export const GEMINI_RETRY_BASE_DELAY_MS = 1_200;
export const GEMINI_RETRY_MAX_DELAY_MS = 6_000;
export const LLM_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

export class GeminiUnavailableError extends Error {
  public readonly upstreamStatus?: number;
  public readonly retryable: boolean;
  public readonly attemptsMade: number;

  constructor(
    message: string,
    options?: {
      upstreamStatus?: number;
      retryable?: boolean;
      attemptsMade?: number;
    }
  ) {
    super(message);
    this.name = 'GeminiUnavailableError';
    this.upstreamStatus = options?.upstreamStatus;
    this.retryable = options?.retryable ?? true;
    this.attemptsMade = options?.attemptsMade ?? 1;
  }
}

export class GeminiMalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiMalformedOutputError';
  }
}

export class RateLimitExceededError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Enforces SQLite-backed fixed-window application rate limiting per session and client IP.
 * Note: Provider-side Google Gemini API quota/billing caps remain authoritative across restarts.
 */
export function enforceRateLimit(
  db: Database.Database,
  options: {
    sessionId: string;
    ipAddress?: string | null;
    scope: string;
    maxRequestsPerSessionWindow?: number;
    maxRequestsPerIpWindow?: number;
    windowSeconds?: number;
  }
): void {
  const windowSeconds = options.windowSeconds ?? 60;
  const sessionLimit = options.maxRequestsPerSessionWindow ?? 20;
  const ipLimit = options.maxRequestsPerIpWindow ?? 40;
  const nowMs = Date.now();
  const nextResetIso = new Date(nowMs + windowSeconds * 1000).toISOString();

  const checkBucket = (bucketKey: string, limit: number) => {
    const existing = db
      .prepare('SELECT count, window_reset_at FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(bucketKey) as { count: number; window_reset_at: string } | undefined;

    if (!existing || new Date(existing.window_reset_at).getTime() <= nowMs) {
      db.prepare(
        `INSERT INTO rate_limit_buckets (bucket_key, count, window_reset_at)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET count = 1, window_reset_at = excluded.window_reset_at`
      ).run(bucketKey, nextResetIso);
      return;
    }

    if (existing.count >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(existing.window_reset_at).getTime() - nowMs) / 1000)
      );
      throw new RateLimitExceededError(
        `Application rate limit reached for ${options.scope}. Retry in ${retryAfter}s.`,
        retryAfter
      );
    }

    db.prepare('UPDATE rate_limit_buckets SET count = count + 1 WHERE bucket_key = ?').run(
      bucketKey
    );
  };

  const run = db.transaction(() => {
    checkBucket(`session:${options.scope}:${options.sessionId}`, sessionLimit);
    if (options.ipAddress) {
      checkBucket(`ip:${options.scope}:${sha256Hex(options.ipAddress)}`, ipLimit);
    }
  });
  run();
}

export function buildLlmCacheKey(params: {
  modelId: string;
  promptVersion: string;
  purpose: 'MANDATE_COMPILE' | 'SHOPPING_AGENT' | 'AI_REVIEWER';
  inputPayload: unknown;
  scenario: string;
  sessionContext: string;
}): { cacheKey: string; inputHash: string } {
  const inputHash = sha256Canonical(params.inputPayload);
  const cacheKey = sha256Canonical({
    modelId: params.modelId,
    promptVersion: params.promptVersion,
    purpose: params.purpose,
    inputHash,
    scenario: params.scenario,
    sessionContext: params.sessionContext,
  });
  return { cacheKey, inputHash };
}

export function readLlmCache<T>(
  db: Database.Database,
  sessionId: string,
  cacheKey: string
): T | null {
  const row = db
    .prepare(
      `SELECT output_json, expires_at FROM llm_output_cache
       WHERE cache_key = ? AND session_id = ?`
    )
    .get(cacheKey, sessionId) as { output_json: string; expires_at: string } | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM llm_output_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }

  try {
    return JSON.parse(row.output_json) as T;
  } catch {
    return null;
  }
}

export function writeLlmCache(
  db: Database.Database,
  params: {
    cacheKey: string;
    sessionId: string;
    modelId: string;
    promptVersion: string;
    purpose: 'MANDATE_COMPILE' | 'SHOPPING_AGENT' | 'AI_REVIEWER';
    inputHash: string;
    output: unknown;
  }
): void {
  const now = new Date();
  const expires = new Date(now.getTime() + LLM_CACHE_TTL_MS);
  db.prepare(
    `INSERT INTO llm_output_cache (
      cache_key, session_id, model_id, prompt_version, purpose, input_hash,
      output_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      output_json = excluded.output_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at`
  ).run(
    params.cacheKey,
    params.sessionId,
    params.modelId,
    params.promptVersion,
    params.purpose,
    params.inputHash,
    JSON.stringify(params.output),
    now.toISOString(),
    expires.toISOString()
  );
}

export function createGeminiClient(): { ai: GoogleGenAI; model: string } {
  const config = getGeminiConfig();
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  return { ai, model: config.model };
}

export interface GeminiErrorClassification {
  retryable: boolean;
  upstreamStatus?: number;
  reason: string;
  message: string;
}

function extractUpstreamStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof record.status === 'number' && Number.isFinite(record.status)) {
    return record.status;
  }
  if (typeof record.statusCode === 'number' && Number.isFinite(record.statusCode)) {
    return record.statusCode;
  }
  if (typeof record.message === 'string') {
    try {
      const parsed = JSON.parse(record.message) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === 'number') {
        return parsed.error.code;
      }
    } catch {
      // ignore non-JSON message
    }
  }
  return undefined;
}

/**
 * Classifies Gemini SDK / HTTP errors into transient retryable vs permanent failures.
 * Never retries invalid API keys, malformed requests, or permanent 4xx failures.
 */
export function classifyGeminiError(err: unknown): GeminiErrorClassification {
  const status = extractUpstreamStatus(err);
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : 'Unknown Gemini API error';
  const lower = message.toLowerCase();

  // Permanent auth / invalid request / key / permission errors never retry
  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid_argument') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      retryable: false,
      upstreamStatus: status,
      reason: 'permanent_client_or_auth_error',
      message,
    };
  }

  if (status !== undefined) {
    if (status === 503 || status === 502 || status === 504 || status === 500 || status === 408) {
      return {
        retryable: true,
        upstreamStatus: status,
        reason: `transient_http_${status}`,
        message,
      };
    }

    if (status === 429) {
      // Do not retry permanent zero-quota or billing-disabled 429 responses
      const permanentQuota =
        lower.includes('limit: 0') ||
        lower.includes('billing') ||
        lower.includes('quota exceeded for quota metric') && lower.includes('daily');
      return {
        retryable: !permanentQuota,
        upstreamStatus: 429,
        reason: permanentQuota ? 'permanent_quota_exhausted' : 'transient_rate_limit_429',
        message,
      };
    }

    if (status >= 400 && status < 500) {
      return {
        retryable: false,
        upstreamStatus: status,
        reason: `permanent_http_${status}`,
        message,
      };
    }
  }

  // Transient timeout / abort / network reset without numeric status
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /\b(aborted|timed out|timeout|econnreset|etimedout|enotfound|eai_again|fetch failed|network)\b/i.test(
      message
    )
  ) {
    return {
      retryable: true,
      upstreamStatus: 504,
      reason: 'transient_timeout_or_network',
      message,
    };
  }

  return {
    retryable: false,
    upstreamStatus: status,
    reason: 'non_retryable_error',
    message,
  };
}

/**
 * Exponential backoff with full jitter, strictly capped to avoid long hangs or excessive API usage.
 */
export function computeBackoffWithJitterMs(
  retryIndex: number,
  randomFn: () => number = Math.random
): number {
  const exponential = Math.min(
    GEMINI_RETRY_MAX_DELAY_MS,
    GEMINI_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryIndex)
  );
  const jitter = Math.floor(randomFn() * Math.min(800, exponential * 0.4));
  return Math.min(GEMINI_RETRY_MAX_DELAY_MS, exponential + jitter);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiClientLike {
  models: {
    generateContent: (
      params: Parameters<GoogleGenAI['models']['generateContent']>[0]
    ) => ReturnType<GoogleGenAI['models']['generateContent']>;
  };
}

/**
 * Invokes Gemini with bounded input size, bounded output tokens, 50s timeout,
 * and strictly capped exponential backoff + jitter retries ONLY on transient 503/429/timeouts.
 */
export async function generateWithGemini(options: {
  contents: ContentListUnion;
  config: GenerateContentConfig;
  timeoutMs?: number;
  modelOverride?: string;
  maxRetries?: number;
  clientOverride?: GeminiClientLike;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
}) {
  const serializedSize = JSON.stringify(options.contents).length;
  if (serializedSize > MAX_GEMINI_INPUT_CHARS) {
    throw new GeminiUnavailableError(
      `Gemini input payload (${serializedSize} chars) exceeds maximum allowed limit (${MAX_GEMINI_INPUT_CHARS} chars).`,
      { retryable: false, attemptsMade: 0 }
    );
  }

  const { ai, model } = options.clientOverride
    ? { ai: options.clientOverride, model: options.modelOverride ?? getGeminiConfig().model }
    : createGeminiClient();
  const targetModel = options.modelOverride ?? model;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const maxRetries = Math.min(Math.max(options.maxRetries ?? MAX_GEMINI_RETRIES, 0), MAX_GEMINI_RETRIES);
  const sleep = options.sleepFn ?? defaultSleep;
  const rand = options.randomFn ?? Math.random;

  let lastClassification: GeminiErrorClassification | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent({
        model: targetModel,
        contents: options.contents,
        config: {
          ...options.config,
          maxOutputTokens: options.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });
    } catch (err) {
      const classified = classifyGeminiError(err);
      lastClassification = classified;

      if (!classified.retryable || attempt >= maxRetries) {
        const attemptsMade = attempt + 1;
        const prefix = classified.retryable
          ? `Gemini (${targetModel}) temporarily unavailable after ${attemptsMade} attempt(s)`
          : `Gemini (${targetModel}) request failed`;
        throw new GeminiUnavailableError(`${prefix}: ${classified.message}`, {
          upstreamStatus: classified.upstreamStatus,
          retryable: classified.retryable,
          attemptsMade,
        });
      }

      const delayMs = computeBackoffWithJitterMs(attempt, rand);
      await sleep(delayMs);
    }
  }

  throw new GeminiUnavailableError(
    `Gemini (${targetModel}) unavailable: ${lastClassification?.message ?? 'Unknown error'}`,
    {
      upstreamStatus: lastClassification?.upstreamStatus,
      retryable: lastClassification?.retryable ?? true,
      attemptsMade: maxRetries + 1,
    }
  );
}

