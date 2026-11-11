import { NextRequest, NextResponse, connection } from 'next/server';
import { getCurrentSession, getOrCreateSession } from '@/lib/session';
import { jsonErrorResponse } from '@/lib/http';

export async function GET() {
  await connection();
  try {
    const session = await getCurrentSession();
    return NextResponse.json({
      authenticated: Boolean(session),
      session: session
        ? {
            id: session.id,
            createdAt: session.created_at,
            expiresAt: session.expires_at,
            status: session.status,
          }
        : null,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userAgent = request.headers.get('user-agent');
    const { session, isNew } = await getOrCreateSession(userAgent);
    return NextResponse.json(
      {
        isNew,
        session: {
          id: session.id,
          createdAt: session.created_at,
          expiresAt: session.expires_at,
          status: session.status,
        },
      },
      { status: isNew ? 201 : 200 }
    );
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

