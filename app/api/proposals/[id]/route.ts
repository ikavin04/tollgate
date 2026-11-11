import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
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
    return NextResponse.json(detail);
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

