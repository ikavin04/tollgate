import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { approveReviewAndCapture, denyReviewAndVoid } from '@/lib/paypal';
import { requireCurrentSession } from '@/lib/session';

const reviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'DENY']),
  reason: z.string().trim().min(1).max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireCurrentSession();
    const { id: proposalId } = await context.params;
    const body = reviewDecisionSchema.parse(await request.json());
    const db = getDb();

    if (body.decision === 'APPROVE') {
      const outcome = await approveReviewAndCapture(
        db,
        session.id,
        proposalId,
        body.reason ?? 'Approved by human reviewer in Tollgate'
      );
      return NextResponse.json({
        proposalId,
        decision: 'APPROVE',
        payment: {
          verificationStatus: outcome.payment.verification_status,
          paypalOrderId: outcome.payment.paypal_order_id,
          paypalAuthorizationId: outcome.payment.paypal_authorization_id,
          paypalCaptureId: outcome.payment.paypal_capture_id,
          paypalCaptureStatus: outcome.payment.paypal_capture_status,
        },
        capture: outcome.capture,
      });
    }

    const outcome = await denyReviewAndVoid(
      db,
      session.id,
      proposalId,
      body.reason ?? 'Denied by human reviewer in Tollgate'
    );
    return NextResponse.json({
      proposalId,
      decision: 'DENY',
      voided: outcome.voided,
      payment: outcome.payment
        ? {
            verificationStatus: outcome.payment.verification_status,
            paypalOrderId: outcome.payment.paypal_order_id,
            paypalAuthorizationId: outcome.payment.paypal_authorization_id,
            paypalVoidStatus: outcome.payment.paypal_void_status,
          }
        : null,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

