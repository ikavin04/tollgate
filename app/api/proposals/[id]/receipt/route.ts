import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { verifySessionLedger } from '@/lib/ledger';
import { getSessionProposalDetail } from '@/lib/proposals/queries';
import { requireCurrentSession } from '@/lib/session';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  await connection();
  try {
    const session = await requireCurrentSession();
    const { id } = await context.params;
    const db = getDb();
    const detail = getSessionProposalDetail(db, session.id, id);
    const ledgerVerification = verifySessionLedger(db, session.id);

    const receipt = {
      receipt_version: 'tollgate-receipt-v1',
      generated_at: new Date().toISOString(),
      integrity_notice: ledgerVerification.integrityNotice,
      session_id: session.id,
      proposal: detail.proposal,
      mandate: detail.mandate,
      items: detail.items,
      page_evidence_fingerprints: detail.pageEvidence.map((p) => ({
        id: p.id,
        storefront_path: p.storefront_path,
        content_length: p.content_length,
        sha256_hash: p.sha256_hash,
        truncated_for_model: p.truncated_for_model === 1,
        note: 'SHA-256 proves integrity of stored evidence text, not origin or truthfulness.',
      })),
      payment: detail.payment,
      payment_operations: detail.paymentOperations,
      ledger_events: detail.ledgerEvents,
      session_ledger_verification: ledgerVerification,
    };

    return new NextResponse(JSON.stringify(receipt, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="tollgate-receipt-${id.slice(0, 8)}.json"`,
      },
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

