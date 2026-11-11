import 'server-only';
import type Database from 'better-sqlite3';
import { newUuid, sha256Canonical } from '@/lib/crypto';
import { getPayPalConfig } from '@/lib/env';
import { getPayPalAccessToken, invalidateCachedPayPalToken } from './oauth';
import {
  PayPalApiError,
  PayPalIdempotencyConflictError,
  PayPalUncertainOutcomeError,
  type PaymentOperationRow,
  type PayPalErrorPayload,
  type PayPalOperationType,
} from './types';

const DEFAULT_TIMEOUT_MS = 15000;

export interface PayPalHttpResult<T> {
  status: number;
  data: T | null;
  rawText: string;
}

/**
 * Performs an authenticated live HTTP request against the configured PayPal REST endpoint.
 * Preserves actual HTTP statuses and PayPal error payloads. Never caches responses.
 */
export async function paypalHttpRequest<T>(options: {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  payPalRequestId?: string;
  preferRepresentation?: boolean;
  timeoutMs?: number;
}): Promise<PayPalHttpResult<T>> {
  const config = getPayPalConfig();
  const url = `${config.baseUrl}${options.path.startsWith('/') ? options.path : `/${options.path}`}`;

  const sendAttempt = async (forceRefresh: boolean): Promise<Response> => {
    const { accessToken } = await getPayPalAccessToken({ forceRefresh });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.payPalRequestId) {
      headers['PayPal-Request-Id'] = options.payPalRequestId;
    }
    if (options.preferRepresentation) {
      headers['Prefer'] = 'return=representation';
    }

    return fetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  };

  let response = await sendAttempt(false);
  if (response.status === 401) {
    // Token may have been revoked early on PayPal's side; refresh once and retry.
    invalidateCachedPayPalToken();
    response = await sendAttempt(true);
  }

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { raw: rawText };
    }
  }

  if (!response.ok) {
    const errPayload = (parsed && typeof parsed === 'object' ? parsed : {}) as PayPalErrorPayload;
    const detailMsg = errPayload.details?.[0]?.description || errPayload.details?.[0]?.issue;
    const msg =
      errPayload.message ||
      errPayload.error_description ||
      detailMsg ||
      `PayPal API error (${response.status}) on ${options.method} ${options.path}`;
    throw new PayPalApiError(msg, {
      httpStatus: response.status,
      paypalName: errPayload.name || errPayload.error,
      debugId: errPayload.debug_id,
      details: errPayload.details,
      rawPayload: parsed,
    });
  }

  return {
    status: response.status,
    data: parsed as T | null,
    rawText,
  };
}

export interface IdempotentOperationParams<TResult> {
  db: Database.Database;
  sessionId: string;
  proposalId: string;
  paymentId: string | null;
  operationType: PayPalOperationType;
  logicalOperationKey: string;
  requestPayload: unknown;
  /**
   * Called ONLY when an existing PENDING or UNCERTAIN record exists before re-issuing a mutating POST.
   * Should query live PayPal GET endpoints to determine if the previous call actually succeeded.
   */
  reconcileExisting?: () => Promise<{
    resolved: boolean;
    resourceId?: string;
    responseData?: TResult;
    httpStatus?: number;
  }>;
  /**
   * Executes the live PayPal POST call using the durable paypalRequestId.
   */
  executeCall: (paypalRequestId: string) => Promise<{
    httpStatus: number;
    resourceId: string | null;
    responseData: TResult;
  }>;
}

/**
 * Executes a PayPal mutating operation backed by persistent UUID idempotency in `payment_operations`.
 * - Reuses the original UUID on retries (never generates a new UUID for the same logical operation).
 * - Rejects payload mismatches for the same logical operation key.
 * - Reconciles remote PayPal status before retrying UNCERTAIN/PENDING operations.
 * - Prevents duplicate captures and mutually exclusive CAPTURE vs VOID operations.
 */
export async function executeIdempotentPayPalOperation<TResult>(
  params: IdempotentOperationParams<TResult>
): Promise<{
  operation: PaymentOperationRow;
  result: TResult;
  replayedFromIdempotency: boolean;
}> {
  const { db, sessionId, proposalId, paymentId, operationType, logicalOperationKey } = params;
  const requestPayloadHash = sha256Canonical(params.requestPayload ?? {});

  // Mutual exclusion & duplicate protection across CAPTURE and VOID for the same proposal.
  if (operationType === 'CAPTURE' || operationType === 'VOID') {
    const conflictingType: PayPalOperationType = operationType === 'CAPTURE' ? 'VOID' : 'CAPTURE';
    const conflict = db
      .prepare(
        `SELECT id, operation_status FROM payment_operations
         WHERE session_id = ? AND proposal_id = ? AND operation_type = ?
           AND operation_status IN ('SUCCEEDED', 'PENDING', 'UNCERTAIN')
         LIMIT 1`
      )
      .get(sessionId, proposalId, conflictingType) as
      | { id: string; operation_status: string }
      | undefined;

    if (conflict) {
      throw new PayPalIdempotencyConflictError(
        `Cannot execute ${operationType}: a ${conflictingType} operation (${conflict.id}) is already ${conflict.operation_status} for this proposal.`
      );
    }
  }

  const prepareOperation = db.transaction((): {
    row: PaymentOperationRow;
    action: 'RETURN_SUCCEEDED' | 'RECONCILE_THEN_RUN' | 'RUN';
  } => {
    const existing = db
      .prepare(
        `SELECT * FROM payment_operations
         WHERE session_id = ? AND logical_operation_key = ?`
      )
      .get(sessionId, logicalOperationKey) as PaymentOperationRow | undefined;

    if (existing) {
      if (existing.request_payload_hash !== requestPayloadHash) {
        throw new PayPalIdempotencyConflictError(
          `Idempotency conflict on ${logicalOperationKey}: retry payload hash does not match original operation.`
        );
      }

      if (existing.operation_status === 'SUCCEEDED') {
        return { row: existing, action: 'RETURN_SUCCEEDED' };
      }

      const now = new Date().toISOString();
      const shouldReconcile =
        existing.operation_status === 'UNCERTAIN' || existing.operation_status === 'PENDING';

      db.prepare(
        `UPDATE payment_operations
         SET attempt_count = attempt_count + 1,
             operation_status = 'PENDING',
             payment_id = COALESCE(payment_id, ?),
             updated_at = ?
         WHERE id = ? AND session_id = ?`
      ).run(paymentId, now, existing.id, sessionId);

      const updated = db
        .prepare('SELECT * FROM payment_operations WHERE id = ? AND session_id = ?')
        .get(existing.id, sessionId) as PaymentOperationRow;

      return {
        row: updated,
        action: shouldReconcile ? 'RECONCILE_THEN_RUN' : 'RUN',
      };
    }

    const now = new Date().toISOString();
    const row: PaymentOperationRow = {
      id: newUuid(),
      session_id: sessionId,
      proposal_id: proposalId,
      payment_id: paymentId,
      operation_type: operationType,
      logical_operation_key: logicalOperationKey,
      paypal_request_id: newUuid(),
      request_payload_hash: requestPayloadHash,
      operation_status: 'PENDING',
      http_status: null,
      paypal_resource_id: null,
      paypal_response_json: null,
      error_message: null,
      attempt_count: 1,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO payment_operations (
        id, session_id, proposal_id, payment_id, operation_type,
        logical_operation_key, paypal_request_id, request_payload_hash,
        operation_status, http_status, paypal_resource_id, paypal_response_json,
        error_message, attempt_count, created_at, updated_at
      ) VALUES (
        @id, @session_id, @proposal_id, @payment_id, @operation_type,
        @logical_operation_key, @paypal_request_id, @request_payload_hash,
        @operation_status, @http_status, @paypal_resource_id, @paypal_response_json,
        @error_message, @attempt_count, @created_at, @updated_at
      )`
    ).run(row);

    return { row, action: 'RUN' };
  });

  const prepared = prepareOperation();

  if (prepared.action === 'RETURN_SUCCEEDED') {
    const parsedResponse = prepared.row.paypal_response_json
      ? (JSON.parse(prepared.row.paypal_response_json) as TResult)
      : (null as unknown as TResult);
    return {
      operation: prepared.row,
      result: parsedResponse,
      replayedFromIdempotency: true,
    };
  }

  if (prepared.action === 'RECONCILE_THEN_RUN' && params.reconcileExisting) {
    try {
      const reconciled = await params.reconcileExisting();
      if (reconciled.resolved && reconciled.responseData !== undefined) {
        const now = new Date().toISOString();
        const respJson = JSON.stringify(reconciled.responseData);
        db.prepare(
          `UPDATE payment_operations
           SET operation_status = 'SUCCEEDED',
               http_status = ?,
               paypal_resource_id = COALESCE(?, paypal_resource_id),
               paypal_response_json = ?,
               error_message = NULL,
               updated_at = ?
           WHERE id = ? AND session_id = ?`
        ).run(
          reconciled.httpStatus ?? 200,
          reconciled.resourceId ?? null,
          respJson,
          now,
          prepared.row.id,
          sessionId
        );
        const saved = db
          .prepare('SELECT * FROM payment_operations WHERE id = ? AND session_id = ?')
          .get(prepared.row.id, sessionId) as PaymentOperationRow;
        return {
          operation: saved,
          result: reconciled.responseData,
          replayedFromIdempotency: true,
        };
      }
    } catch (reconcileError) {
      // If reconciliation itself fails with a network error, mark UNCERTAIN rather than firing blindly.
      if (!(reconcileError instanceof PayPalApiError && reconcileError.httpStatus === 404)) {
        const msg =
          reconcileError instanceof Error ? reconcileError.message : 'Reconciliation check failed';
        db.prepare(
          `UPDATE payment_operations
           SET operation_status = 'UNCERTAIN', error_message = ?, updated_at = ?
           WHERE id = ? AND session_id = ?`
        ).run(msg, new Date().toISOString(), prepared.row.id, sessionId);
        throw new PayPalUncertainOutcomeError(
          `Unable to verify prior ${operationType} status on PayPal before retry: ${msg}`,
          prepared.row.id,
          prepared.row.paypal_request_id
        );
      }
    }
  }

  try {
    const callOutcome = await params.executeCall(prepared.row.paypal_request_id);
    const now = new Date().toISOString();
    const respJson = JSON.stringify(callOutcome.responseData);
    db.prepare(
      `UPDATE payment_operations
       SET operation_status = 'SUCCEEDED',
           http_status = ?,
           paypal_resource_id = ?,
           paypal_response_json = ?,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      callOutcome.httpStatus,
      callOutcome.resourceId,
      respJson,
      now,
      prepared.row.id,
      sessionId
    );
    const saved = db
      .prepare('SELECT * FROM payment_operations WHERE id = ? AND session_id = ?')
      .get(prepared.row.id, sessionId) as PaymentOperationRow;

    return {
      operation: saved,
      result: callOutcome.responseData,
      replayedFromIdempotency: false,
    };
  } catch (err) {
    const now = new Date().toISOString();
    if (err instanceof PayPalApiError) {
      const isServerOrTransient = err.httpStatus >= 500 || err.httpStatus === 408;
      const nextStatus = isServerOrTransient ? 'UNCERTAIN' : 'FAILED';
      db.prepare(
        `UPDATE payment_operations
         SET operation_status = ?,
             http_status = ?,
             paypal_response_json = ?,
             error_message = ?,
             updated_at = ?
         WHERE id = ? AND session_id = ?`
      ).run(
        nextStatus,
        err.httpStatus,
        err.rawPayload ? JSON.stringify(err.rawPayload) : null,
        err.message,
        now,
        prepared.row.id,
        sessionId
      );
      throw err;
    }

    const message = err instanceof Error ? err.message : 'Network or timeout error calling PayPal';
    db.prepare(
      `UPDATE payment_operations
       SET operation_status = 'UNCERTAIN',
           error_message = ?,
           updated_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(message, now, prepared.row.id, sessionId);

    throw new PayPalUncertainOutcomeError(
      `PayPal ${operationType} outcome uncertain (${message}). Retry preserves PayPal-Request-Id ${prepared.row.paypal_request_id} and checks PayPal state first.`,
      prepared.row.id,
      prepared.row.paypal_request_id
    );
  }
}

