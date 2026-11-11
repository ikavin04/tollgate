import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { getEnvStatus } from '@/lib/env';
import { completePayPalReturnFlow } from '@/lib/paypal';
import { getCurrentSession } from '@/lib/session';

export async function GET(request: NextRequest) {
  await connection();
  const baseUrl = getEnvStatus().appBaseUrl;
  const token = request.nextUrl.searchParams.get('token')?.trim();

  if (!token) {
    return NextResponse.redirect(
      new URL('/transactions?paypalError=missing_order_token', baseUrl)
    );
  }

  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.redirect(
      new URL('/transactions?paypalError=session_not_found', baseUrl)
    );
  }

  const db = getDb();
  try {
    const result = await completePayPalReturnFlow(db, session.id, token);
    const statusParam =
      result.stageReached === 'CAPTURED'
        ? 'captured'
        : result.stageReached === 'AWAITING_HUMAN_REVIEW'
          ? 'authorized_review'
          : 'voided';
    return NextResponse.redirect(
      new URL(`/transactions/${encodeURIComponent(result.proposalId)}?paypal=${statusParam}`, baseUrl)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PayPal return processing failed';
    const payment = db
      .prepare('SELECT proposal_id FROM payments WHERE paypal_order_id = ? AND session_id = ?')
      .get(token, session.id) as { proposal_id: string } | undefined;

    if (payment?.proposal_id) {
      return NextResponse.redirect(
        new URL(
          `/transactions/${encodeURIComponent(payment.proposal_id)}?paypalError=${encodeURIComponent(message)}`,
          baseUrl
        )
      );
    }

    return NextResponse.redirect(
      new URL(`/transactions?paypalError=${encodeURIComponent(message)}`, baseUrl)
    );
  }
}

