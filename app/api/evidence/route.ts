import { NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { listSessionEvidence } from '@/lib/proposals/queries';
import { getCurrentSession } from '@/lib/session';

export async function GET() {
  await connection();
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ evidence: [] });
    }
    const db = getDb();
    const evidence = listSessionEvidence(db, session.id);
    return NextResponse.json({ evidence });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

