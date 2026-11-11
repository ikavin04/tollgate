import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import {
  createLedgerCheckpoint,
  listLedgerCheckpoints,
  listSessionLedgerEvents,
  verifySessionLedger,
} from '@/lib/ledger';
import { getCurrentSession, requireCurrentSession } from '@/lib/session';

export async function GET(request: NextRequest) {
  await connection();
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({
        verification: null,
        events: [],
        checkpoints: [],
      });
    }

    const db = getDb();
    const verification = verifySessionLedger(db, session.id);
    const events = listSessionLedgerEvents(db, session.id);
    const checkpoints = listLedgerCheckpoints(db, session.id);

    if (request.nextUrl.searchParams.get('export') === 'checkpoint') {
      const bundle = {
        export_version: 'tollgate-ledger-checkpoint-v1',
        exported_at: new Date().toISOString(),
        session_id: session.id,
        verification,
        checkpoints,
        events,
      };
      return new NextResponse(JSON.stringify(bundle, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="tollgate-ledger-${session.id.slice(0, 8)}.json"`,
        },
      });
    }

    return NextResponse.json({
      verification,
      events,
      checkpoints,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST() {
  try {
    const session = await requireCurrentSession();
    const db = getDb();
    const checkpoint = createLedgerCheckpoint(db, session.id);
    return NextResponse.json({ checkpoint }, { status: 201 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

