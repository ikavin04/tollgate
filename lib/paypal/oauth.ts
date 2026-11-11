import 'server-only';
import { getPayPalConfig } from '@/lib/env';
import { PayPalApiError, type PayPalErrorPayload, type PayPalOAuthResponse } from './types';

interface CachedOAuthToken {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  obtainedAtMs: number;
  expiresAtMs: number;
  refreshAfterMs: number;
  baseUrl: string;
  clientId: string;
}

const globalForOAuth = globalThis as unknown as {
  __tollgatePayPalToken?: CachedOAuthToken;
  __tollgatePayPalTokenInFlight?: Promise<CachedOAuthToken>;
};

const PAYPAL_TIMEOUT_MS = 15000;

/**
 * Computes refresh threshold from PayPal's actual expires_in (never hardcoded expiry).
 * Refreshes proactively 60s before expiry (or at 90% lifetime if expires_in < 600s).
 */
export function computeRefreshTimestampMs(obtainedAtMs: number, expiresInSeconds: number): {
  expiresAtMs: number;
  refreshAfterMs: number;
} {
  const safeExpiresIn = Math.max(1, Math.floor(expiresInSeconds));
  const bufferSeconds = Math.min(60, Math.floor(safeExpiresIn * 0.1));
  const expiresAtMs = obtainedAtMs + safeExpiresIn * 1000;
  const refreshAfterMs = obtainedAtMs + Math.max(1, safeExpiresIn - bufferSeconds) * 1000;
  return { expiresAtMs, refreshAfterMs };
}

export function invalidateCachedPayPalToken(): void {
  globalForOAuth.__tollgatePayPalToken = undefined;
}

export function getCachedPayPalTokenInfo(): {
  cached: boolean;
  expiresInSeconds?: number;
  expiresAtIso?: string;
} {
  const token = globalForOAuth.__tollgatePayPalToken;
  if (!token || Date.now() >= token.refreshAfterMs) {
    return { cached: false };
  }
  return {
    cached: true,
    expiresInSeconds: token.expiresInSeconds,
    expiresAtIso: new Date(token.expiresAtMs).toISOString(),
  };
}

async function fetchNewOAuthToken(): Promise<CachedOAuthToken> {
  const config = getPayPalConfig();
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString(
    'base64'
  );

  const response = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    cache: 'no-store',
    signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
  });

  const text = await response.text();
  let parsed: Partial<PayPalOAuthResponse & PayPalErrorPayload> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Partial<PayPalOAuthResponse & PayPalErrorPayload>;
    } catch {
      parsed = { message: text };
    }
  }

  if (!response.ok) {
    throw new PayPalApiError(
      parsed.error_description ||
        parsed.message ||
        `PayPal OAuth failed with HTTP ${response.status}`,
      {
        httpStatus: response.status,
        paypalName: parsed.error || parsed.name,
        debugId: parsed.debug_id,
        details: parsed.details,
        rawPayload: parsed,
      }
    );
  }

  if (
    typeof parsed.access_token !== 'string' ||
    !parsed.access_token ||
    typeof parsed.expires_in !== 'number' ||
    !Number.isFinite(parsed.expires_in) ||
    parsed.expires_in <= 0
  ) {
    throw new PayPalApiError(
      'PayPal OAuth response missing required access_token or valid expires_in',
      {
        httpStatus: response.status,
        rawPayload: parsed,
      }
    );
  }

  const obtainedAtMs = Date.now();
  const { expiresAtMs, refreshAfterMs } = computeRefreshTimestampMs(
    obtainedAtMs,
    parsed.expires_in
  );

  const entry: CachedOAuthToken = {
    accessToken: parsed.access_token,
    tokenType: parsed.token_type ?? 'Bearer',
    expiresInSeconds: parsed.expires_in,
    obtainedAtMs,
    expiresAtMs,
    refreshAfterMs,
    baseUrl: config.baseUrl,
    clientId: config.clientId,
  };

  globalForOAuth.__tollgatePayPalToken = entry;
  return entry;
}

/**
 * Returns a valid PayPal OAuth access token using expires_in-based caching and single-flight refresh.
 */
export async function getPayPalAccessToken(options?: { forceRefresh?: boolean }): Promise<{
  accessToken: string;
  expiresInSeconds: number;
  expiresAtIso: string;
  fromCache: boolean;
}> {
  const config = getPayPalConfig();
  const existing = globalForOAuth.__tollgatePayPalToken;

  if (
    !options?.forceRefresh &&
    existing &&
    existing.baseUrl === config.baseUrl &&
    existing.clientId === config.clientId &&
    Date.now() < existing.refreshAfterMs
  ) {
    return {
      accessToken: existing.accessToken,
      expiresInSeconds: existing.expiresInSeconds,
      expiresAtIso: new Date(existing.expiresAtMs).toISOString(),
      fromCache: true,
    };
  }

  if (!globalForOAuth.__tollgatePayPalTokenInFlight) {
    globalForOAuth.__tollgatePayPalTokenInFlight = fetchNewOAuthToken().finally(() => {
      globalForOAuth.__tollgatePayPalTokenInFlight = undefined;
    });
  }

  const fresh = await globalForOAuth.__tollgatePayPalTokenInFlight;
  return {
    accessToken: fresh.accessToken,
    expiresInSeconds: fresh.expiresInSeconds,
    expiresAtIso: new Date(fresh.expiresAtMs).toISOString(),
    fromCache: false,
  };
}

