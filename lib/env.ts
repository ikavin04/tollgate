import 'server-only';
import { z } from 'zod';

const REQUIRED_ENV_KEYS = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_BASE_URL',
  'APP_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

const urlSchema = z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
  message: 'Must be an http:// or https:// URL',
});

export class MissingEnvironmentError extends Error {
  public readonly missingKeys: string[];
  public readonly invalidKeys: string[];

  constructor(missingKeys: string[], invalidKeys: string[] = []) {
    const parts: string[] = [];
    if (missingKeys.length > 0) {
      parts.push(`Missing environment variables: ${missingKeys.join(', ')}`);
    }
    if (invalidKeys.length > 0) {
      parts.push(`Invalid environment variables: ${invalidKeys.join(', ')}`);
    }
    super(parts.join('; '));
    this.name = 'MissingEnvironmentError';
    this.missingKeys = missingKeys;
    this.invalidKeys = invalidKeys;
  }
}

export interface EnvValidationStatus {
  ok: boolean;
  missing: string[];
  invalid: string[];
  present: Record<RequiredEnvKey, boolean>;
  paypalBaseUrl: string;
  paypalMode: 'sandbox' | 'live' | 'custom';
  appBaseUrl: string;
  geminiModel: string;
}

function readTrimmed(key: string): string | undefined {
  const val = process.env[key];
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * Validates required environment variables without ever exposing secret values.
 */
export function getEnvStatus(): EnvValidationStatus {
  const missing: string[] = [];
  const invalid: string[] = [];

  const present = {} as Record<RequiredEnvKey, boolean>;
  for (const key of REQUIRED_ENV_KEYS) {
    const val = readTrimmed(key);
    const isPresent = Boolean(val);
    present[key] = isPresent;
    if (!isPresent) {
      missing.push(key);
    }
  }

  const rawPayPalBaseUrl = readTrimmed('PAYPAL_BASE_URL') ?? 'https://api-m.sandbox.paypal.com';
  if (present.PAYPAL_BASE_URL && !urlSchema.safeParse(rawPayPalBaseUrl).success) {
    invalid.push('PAYPAL_BASE_URL');
  }

  const rawAppBaseUrl = readTrimmed('APP_BASE_URL') ?? 'http://localhost:3000';
  if (present.APP_BASE_URL && !urlSchema.safeParse(rawAppBaseUrl).success) {
    invalid.push('APP_BASE_URL');
  }

  const paypalBaseUrl = normalizeUrl(rawPayPalBaseUrl);
  const appBaseUrl = normalizeUrl(rawAppBaseUrl);
  const geminiModel = readTrimmed('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';

  let paypalMode: 'sandbox' | 'live' | 'custom' = 'custom';
  if (paypalBaseUrl.includes('sandbox.paypal.com')) {
    paypalMode = 'sandbox';
  } else if (paypalBaseUrl.includes('api-m.paypal.com')) {
    paypalMode = 'live';
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    present,
    paypalBaseUrl,
    paypalMode,
    appBaseUrl,
    geminiModel,
  };
}

/**
 * Reads and asserts PayPal server credentials and base URLs at execution time.
 * Never returns or logs secrets in error messages.
 */
export function getPayPalConfig(): {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  appBaseUrl: string;
} {
  const status = getEnvStatus();
  const requiredForPayPal: RequiredEnvKey[] = [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_BASE_URL',
    'APP_BASE_URL',
  ];
  const missing = requiredForPayPal.filter((k) => !status.present[k]);
  const invalid = status.invalid.filter((k) => k === 'PAYPAL_BASE_URL' || k === 'APP_BASE_URL');

  if (missing.length > 0 || invalid.length > 0) {
    throw new MissingEnvironmentError(missing, invalid);
  }

  return {
    clientId: readTrimmed('PAYPAL_CLIENT_ID')!,
    clientSecret: readTrimmed('PAYPAL_CLIENT_SECRET')!,
    baseUrl: status.paypalBaseUrl,
    appBaseUrl: status.appBaseUrl,
  };
}

/**
 * Reads and asserts Gemini configuration at execution time without revealing the API key.
 */
export function getGeminiConfig(): {
  apiKey: string;
  model: string;
} {
  const status = getEnvStatus();
  const missing: string[] = [];
  if (!status.present.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!status.present.GEMINI_MODEL) missing.push('GEMINI_MODEL');

  if (missing.length > 0) {
    throw new MissingEnvironmentError(missing);
  }

  return {
    apiKey: readTrimmed('GEMINI_API_KEY')!,
    model: status.geminiModel,
  };
}

let startupChecked = false;

/**
 * Logs startup environment status once per process without revealing any secret values.
 */
export function logEnvStartupValidation(): EnvValidationStatus {
  const status = getEnvStatus();
  if (!startupChecked) {
    startupChecked = true;
    if (!status.ok) {
      console.warn(
        `[Tollgate Env] Startup validation warning — missing: [${status.missing.join(', ')}], invalid: [${status.invalid.join(', ')}]`
      );
    } else {
      console.info(
        `[Tollgate Env] All required environment variables present (PayPal mode: ${status.paypalMode}, Gemini model: ${status.geminiModel})`
      );
    }
  }
  return status;
}

