import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { getEnvStatus } from '@/lib/env';
import { appendLedgerEvent } from '@/lib/ledger';
import { getCurrentSession } from '@/lib/session';

export async function GET(request: NextRequest) {
  await connection();
  const baseUrl = getEnvStatus().appBaseUrl;
  const token = request.nextUrl.searchParams.get('token')?.trim();
  const session = await getCurrentSession();

  if (session && token) {
    const db = getDb();
    const payment = db
      .prepare('SELECT id, proposal_id, verification_status FROM payments WHERE paypal_order_id = ? AND session_id = ?')
      .get(token, session.id) as
      | { id: string; proposal_id: string; verification_status: string }
      | undefined;

    if (payment) {
      if (payment.verification_status === 'ORDER_CREATED') {
        db.prepare(
          `UPDATE payments SET verification_status = 'BUYER_CANCELLED', updated_at = ? WHERE id = ? AND session_id = ?`
        ).run(new Date().toISOString(), payment.id, session.id);

        appendLedgerEvent(db, {
          sessionId: session.id,
          proposalId: payment.proposal_id,
          eventType: 'PAYMENT_OPERATION_FAILED',
          actor: 'USER',
          payload: {
            stage: 'PAYPAL_CHECKOUT_CANCELLED',
            paypal_order_id: token,
          },
        });
      }

      return NextResponse.redirect(
        new URL(`/transactions/${encodeURIComponent(payment.proposal_id)}?paypal=cancelled`, baseUrl)
      );
    }
  }

  return NextResponse.redirect(new URL('/transactions?paypal=cancelled', baseUrl));
}

