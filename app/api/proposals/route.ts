import { NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { getSessionDashboardData } from '@/lib/proposals/queries';
import { getCurrentSession } from '@/lib/session';

export async function GET() {
  await connection();
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({
        stats: {
          totalProposals: 0,
          allowedCount: 0,
          reviewedCount: 0,
          blockedCount: 0,
          capturedCount: 0,
          voidedCount: 0,
          pendingHumanDecisions: 0,
        },
        proposals: [],
      });
    }
    const db = getDb();
    const data = getSessionDashboardData(db, session.id);
    return NextResponse.json(data);
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

