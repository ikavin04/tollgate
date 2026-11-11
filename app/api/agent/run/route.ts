import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { runAgentAndEvaluateProposal } from '@/lib/proposals/orchestrator';
import { requireCurrentSession } from '@/lib/session';

const agentRunBodySchema = z.object({
  mandateId: z.string().uuid(),
  forceFresh: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requireCurrentSession();
    const body = agentRunBodySchema.parse(await request.json());
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null;

    const db = getDb();
    const evaluated = await runAgentAndEvaluateProposal(db, {
      sessionId: session.id,
      mandateId: body.mandateId,
      forceFresh: body.forceFresh,
      ipAddress,
    });

    return NextResponse.json(
      {
        proposalId: evaluated.proposalId,
        finalDecision: evaluated.finalDecision,
        deterministicDecision: evaluated.deterministicDecision,
        aiReviewerDecision: evaluated.aiReviewerDecision,
        agentCached: evaluated.agentCached,
        aiReviewerCached: evaluated.aiReviewerCached,
        totalAmountCents: evaluated.totalAmountCents,
        currency: evaluated.currency,
      },
      { status: 201 }
    );
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

