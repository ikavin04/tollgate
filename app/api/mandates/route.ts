import { NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { listSessionMandates } from '@/lib/mandate/compiler';
import { getCurrentSession } from '@/lib/session';

export async function GET() {
  await connection();
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ mandates: [] });
    }
    const db = getDb();
    const rows = listSessionMandates(db, session.id);
    return NextResponse.json({
      mandates: rows.map((r) => ({
        id: r.id,
        originalInstruction: r.original_instruction,
        compiledMandate: JSON.parse(r.compiled_mandate_json),
        status: r.status,
        compilerModel: r.compiler_model,
        compilerCached: r.compiler_cached === 1,
        confirmedAt: r.confirmed_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

