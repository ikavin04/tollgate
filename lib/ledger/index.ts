import 'server-only';
import type Database from 'better-sqlite3';
import { canonicalJson, newUuid, sha256Hex } from '@/lib/crypto';

export const GENESIS_HASH = '0'.repeat(64);

export type LedgerEventType =
  | 'SESSION_CREATED'
  | 'MANDATE_SUBMITTED'
  | 'MANDATE_CONFIRMED'
  | 'AGENT_TOOL_EXECUTED'
  | 'PAGE_READ'
  | 'PROPOSAL_CREATED'
  | 'POLICY_RESULT_GENERATED'
  | 'AI_REVIEW_COMPLETED'
  | 'FINAL_DECISION_ISSUED'
  | 'HUMAN_REVIEW_APPROVED'
  | 'HUMAN_REVIEW_DENIED'
  | 'PAYPAL_ORDER_CREATED'
  | 'BUYER_APPROVED'
  | 'AUTHORIZATION_CREATED'
  | 'CAPTURE_COMPLETED'
  | 'VOID_COMPLETED'
  | 'PAYPAL_VERIFICATION_FAILED'
  | 'PAYMENT_OPERATION_FAILED';

export type LedgerActor =
  | 'USER'
  | 'TOLLGATE'
  | 'AGENT'
  | 'POLICY_ENGINE'
  | 'AI_REVIEWER'
  | 'PAYPAL';

export interface LedgerEventRow {
  id: string;
  seq: number;
  session_id: string;
  proposal_id: string | null;
  event_type: string;
  actor: string;
  payload_json: string;
  canonical_event_json: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export interface AppendLedgerInput {
  sessionId: string;
  proposalId?: string | null;
  eventType: LedgerEventType;
  actor: LedgerActor;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface LedgerVerificationResult {
  valid: boolean;
  sessionId: string;
  eventCount: number;
  headSeq: number;
  headHash: string;
  genesisHash: string;
  tamperedEventSeq: number | null;
  failureReason: string | null;
  integrityNotice: string;
}

export interface LedgerCheckpointRow {
  id: string;
  session_id: string;
  head_seq: number;
  head_hash: string;
  event_count: number;
  checkpoint_note: string;
  created_at: string;
}

/**
 * Appends a tamper-evident hash-chained event to the session's evidence ledger.
 * Formula: H_n = SHA256(H_previous + canonical_event_json)
 */
export function appendLedgerEvent(
  db: Database.Database,
  input: AppendLedgerInput
): LedgerEventRow {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = newUuid();
  const proposalId = input.proposalId ?? null;
  const payloadJson = canonicalJson(input.payload);
  const parsedPayload = JSON.parse(payloadJson) as Record<string, unknown>;

  const run = db.transaction(() => {
    const prev = db
      .prepare(
        'SELECT seq, event_hash FROM transaction_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
      )
      .get(input.sessionId) as { seq: number; event_hash: string } | undefined;

    const seq = (prev?.seq ?? 0) + 1;
    const previousHash = prev?.event_hash ?? GENESIS_HASH;

    const canonicalEventJson = canonicalJson({
      seq,
      session_id: input.sessionId,
      proposal_id: proposalId,
      event_type: input.eventType,
      actor: input.actor,
      payload: parsedPayload,
      created_at: createdAt,
    });

    const eventHash = sha256Hex(previousHash + canonicalEventJson);

    db.prepare(
      `INSERT INTO transaction_events (
        id, seq, session_id, proposal_id, event_type, actor,
        payload_json, canonical_event_json, previous_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      seq,
      input.sessionId,
      proposalId,
      input.eventType,
      input.actor,
      payloadJson,
      canonicalEventJson,
      previousHash,
      eventHash,
      createdAt
    );

    return {
      id,
      seq,
      session_id: input.sessionId,
      proposal_id: proposalId,
      event_type: input.eventType,
      actor: input.actor,
      payload_json: payloadJson,
      canonical_event_json: canonicalEventJson,
      previous_hash: previousHash,
      event_hash: eventHash,
      created_at: createdAt,
    };
  });

  return run();
}

/**
 * Lists all ledger events for a session (optionally filtered to a single proposal for display).
 * Note: chain verification always validates the full session chain because seq/hashes span the session.
 */
export function listSessionLedgerEvents(
  db: Database.Database,
  sessionId: string,
  proposalId?: string
): LedgerEventRow[] {
  if (proposalId) {
    return db
      .prepare(
        'SELECT * FROM transaction_events WHERE session_id = ? AND proposal_id = ? ORDER BY seq ASC'
      )
      .all(sessionId, proposalId) as LedgerEventRow[];
  }
  return db
    .prepare('SELECT * FROM transaction_events WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as LedgerEventRow[];
}

/**
 * Verifies the entire hash chain for a session by recomputing canonical JSON and SHA-256 links.
 */
export function verifySessionLedger(
  db: Database.Database,
  sessionId: string
): LedgerVerificationResult {
  const events = listSessionLedgerEvents(db, sessionId);
  const integrityNotice =
    'Tollgate uses a tamper-evident SHA-256 hash chain over recorded session events. It detects post-hoc database row modifications, not an attacker with host root privileges who rewrites the entire chain unless exported checkpoints are preserved externally.';

  if (events.length === 0) {
    return {
      valid: true,
      sessionId,
      eventCount: 0,
      headSeq: 0,
      headHash: GENESIS_HASH,
      genesisHash: GENESIS_HASH,
      tamperedEventSeq: null,
      failureReason: null,
      integrityNotice,
    };
  }

  let expectedPreviousHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      return {
        valid: false,
        sessionId,
        eventCount: events.length,
        headSeq: events[events.length - 1].seq,
        headHash: events[events.length - 1].event_hash,
        genesisHash: GENESIS_HASH,
        tamperedEventSeq: event.seq,
        failureReason: `Sequence gap or mismatch: expected seq ${expectedSeq}, found ${event.seq}`,
        integrityNotice,
      };
    }

    if (event.previous_hash !== expectedPreviousHash) {
      return {
        valid: false,
        sessionId,
        eventCount: events.length,
        headSeq: events[events.length - 1].seq,
        headHash: events[events.length - 1].event_hash,
        genesisHash: GENESIS_HASH,
        tamperedEventSeq: event.seq,
        failureReason: `Previous hash mismatch at seq ${event.seq}`,
        integrityNotice,
      };
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(event.payload_json);
    } catch {
      return {
        valid: false,
        sessionId,
        eventCount: events.length,
        headSeq: events[events.length - 1].seq,
        headHash: events[events.length - 1].event_hash,
        genesisHash: GENESIS_HASH,
        tamperedEventSeq: event.seq,
        failureReason: `Malformed payload JSON at seq ${event.seq}`,
        integrityNotice,
      };
    }

    const recomputedCanonical = canonicalJson({
      seq: event.seq,
      session_id: event.session_id,
      proposal_id: event.proposal_id,
      event_type: event.event_type,
      actor: event.actor,
      payload: parsedPayload,
      created_at: event.created_at,
    });

    if (recomputedCanonical !== event.canonical_event_json) {
      return {
        valid: false,
        sessionId,
        eventCount: events.length,
        headSeq: events[events.length - 1].seq,
        headHash: events[events.length - 1].event_hash,
        genesisHash: GENESIS_HASH,
        tamperedEventSeq: event.seq,
        failureReason: `Canonical event JSON mismatch at seq ${event.seq}`,
        integrityNotice,
      };
    }

    const recomputedHash = sha256Hex(expectedPreviousHash + recomputedCanonical);
    if (recomputedHash !== event.event_hash) {
      return {
        valid: false,
        sessionId,
        eventCount: events.length,
        headSeq: events[events.length - 1].seq,
        headHash: events[events.length - 1].event_hash,
        genesisHash: GENESIS_HASH,
        tamperedEventSeq: event.seq,
        failureReason: `SHA-256 event hash mismatch at seq ${event.seq}`,
        integrityNotice,
      };
    }

    expectedPreviousHash = event.event_hash;
    expectedSeq += 1;
  }

  const head = events[events.length - 1];
  return {
    valid: true,
    sessionId,
    eventCount: events.length,
    headSeq: head.seq,
    headHash: head.event_hash,
    genesisHash: GENESIS_HASH,
    tamperedEventSeq: null,
    failureReason: null,
    integrityNotice,
  };
}

/**
 * Creates a stored checkpoint summarizing the session's current ledger head hash.
 */
export function createLedgerCheckpoint(
  db: Database.Database,
  sessionId: string
): LedgerCheckpointRow {
  const verification = verifySessionLedger(db, sessionId);
  if (!verification.valid) {
    throw new Error(
      `Cannot create checkpoint for invalid ledger at seq ${verification.tamperedEventSeq}: ${verification.failureReason}`
    );
  }

  const row: LedgerCheckpointRow = {
    id: newUuid(),
    session_id: sessionId,
    head_seq: verification.headSeq,
    head_hash: verification.headHash,
    event_count: verification.eventCount,
    checkpoint_note:
      'Tamper-evident SHA-256 ledger checkpoint. Export and store independently to detect full-chain rewrites.',
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO ledger_checkpoints (
      id, session_id, head_seq, head_hash, event_count, checkpoint_note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.session_id,
    row.head_seq,
    row.head_hash,
    row.event_count,
    row.checkpoint_note,
    row.created_at
  );

  return row;
}

export function listLedgerCheckpoints(
  db: Database.Database,
  sessionId: string
): LedgerCheckpointRow[] {
  return db
    .prepare('SELECT * FROM ledger_checkpoints WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as LedgerCheckpointRow[];
}

