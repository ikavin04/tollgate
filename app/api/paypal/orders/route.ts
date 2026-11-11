import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { createPayPalOrderForProposal } from '@/lib/paypal';
import { requireCurrentSession } from '@/lib/session';

const createOrderBodySchema = z.object({
  proposalId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requireCurrentSession();
    const body = createOrderBodySchema.parse(await request.json());
    const db = getDb();

    const result = await createPayPalOrderForProposal(db, session.id, body.proposalId);

    return NextResponse.json({
      proposalId: body.proposalId,
      paymentId: result.payment.id,
      paypalOrderId: result.order.id,
      orderStatus: result.order.status,
      intent: result.order.intent,
      payerActionUrl: result.payerActionUrl,
      replayedFromIdempotency: result.replayedFromIdempotency,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

