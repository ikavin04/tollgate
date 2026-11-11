import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  GeminiMalformedOutputError,
  GeminiUnavailableError,
  RateLimitExceededError,
} from '@/lib/ai/gemini';
import { MissingEnvironmentError } from '@/lib/env';
import {
  PayPalApiError,
  PayPalIdempotencyConflictError,
  PayPalOrderVerificationError,
  PayPalUncertainOutcomeError,
  PayPalWorkflowStateError,
} from '@/lib/paypal';
import { ResourceNotFoundError, SessionRequiredError } from '@/lib/session';

export function jsonErrorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 }
    );
  }

  if (err instanceof RateLimitExceededError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'RATE_LIMITED',
        retryAfterSeconds: err.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(err.retryAfterSeconds) },
      }
    );
  }

  if (err instanceof GeminiUnavailableError) {
    const httpStatus =
      err.upstreamStatus && err.upstreamStatus >= 400 && err.upstreamStatus < 500 && err.upstreamStatus !== 429
        ? err.upstreamStatus
        : err.upstreamStatus === 429
          ? 429
          : 503;

    return NextResponse.json(
      {
        error: err.message,
        code: err.retryable ? 'GEMINI_UNAVAILABLE' : 'GEMINI_REQUEST_ERROR',
        retryable: err.retryable,
        upstreamStatus: err.upstreamStatus ?? null,
        attemptsMade: err.attemptsMade,
      },
      { status: httpStatus }
    );
  }

  if (err instanceof GeminiMalformedOutputError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'GEMINI_MALFORMED_OUTPUT',
      },
      { status: 502 }
    );
  }

  if (err instanceof MissingEnvironmentError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'MISSING_ENVIRONMENT',
        missing: err.missingKeys,
        invalid: err.invalidKeys,
      },
      { status: 503 }
    );
  }

  if (err instanceof SessionRequiredError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'SESSION_REQUIRED',
      },
      { status: 401 }
    );
  }

  if (err instanceof ResourceNotFoundError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'NOT_FOUND',
      },
      { status: 404 }
    );
  }

  if (err instanceof PayPalOrderVerificationError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'PAYPAL_VERIFICATION_FAILED',
        checks: err.checks,
      },
      { status: 422 }
    );
  }

  if (err instanceof PayPalWorkflowStateError || err instanceof PayPalIdempotencyConflictError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'WORKFLOW_CONFLICT',
      },
      { status: 409 }
    );
  }

  if (err instanceof PayPalUncertainOutcomeError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'PAYPAL_UNCERTAIN_OUTCOME',
        operationId: err.operationId,
        paypalRequestId: err.paypalRequestId,
      },
      { status: 504 }
    );
  }

  if (err instanceof PayPalApiError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'PAYPAL_API_ERROR',
        paypalStatus: err.httpStatus,
        paypalName: err.paypalName,
        debugId: err.debugId,
        details: err.details,
      },
      { status: err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502 }
    );
  }

  const message = err instanceof Error ? err.message : 'Unexpected server error';
  return NextResponse.json(
    {
      error: message,
      code: 'INTERNAL_ERROR',
    },
    { status: 500 }
  );
}
