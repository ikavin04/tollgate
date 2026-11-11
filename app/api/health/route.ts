import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { getEnvStatus } from '@/lib/env';
import { getCachedPayPalTokenInfo, getPayPalAccessToken } from '@/lib/paypal';

export async function GET(request: NextRequest) {
  await connection();
  const env = getEnvStatus();

  let dbOk = false;
  let productCount = 0;
  let migrationCount = 0;
  let dbError: string | null = null;

  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
    const mig = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as {
      count: number;
    };
    productCount = row.count;
    migrationCount = mig.count;
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'Database initialization failed';
  }

  const verifyOAuth = request.nextUrl.searchParams.get('verifyPaypalOAuth') === 'true';
  let paypalOAuth: Record<string, unknown> = {
    configured: env.present.PAYPAL_CLIENT_ID && env.present.PAYPAL_CLIENT_SECRET,
    mode: env.paypalMode,
    tokenCache: getCachedPayPalTokenInfo(),
  };

  if (verifyOAuth) {
    try {
      const token = await getPayPalAccessToken();
      paypalOAuth = {
        ...paypalOAuth,
        liveCheckOk: true,
        expiresInSeconds: token.expiresInSeconds,
        expiresAtIso: token.expiresAtIso,
        fromCache: token.fromCache,
      };
    } catch (err) {
      paypalOAuth = {
        ...paypalOAuth,
        liveCheckOk: false,
        error: err instanceof Error ? err.message : 'OAuth check failed',
      };
    }
  }

  const healthy = dbOk && (!verifyOAuth || paypalOAuth.liveCheckOk === true);

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      service: 'tollgate',
      timestamp: new Date().toISOString(),
      database: {
        ok: dbOk,
        migrationsApplied: migrationCount,
        seededProducts: productCount,
        persistenceNotice:
          'SQLite local disk storage; ephemeral Render free-tier instances may reset on restart/redeploy.',
        error: dbError,
      },
      environment: {
        ok: env.ok,
        missing: env.missing,
        invalid: env.invalid,
        present: env.present,
        paypalBaseUrl: env.paypalBaseUrl,
        paypalMode: env.paypalMode,
        appBaseUrl: env.appBaseUrl,
        geminiModel: env.geminiModel,
      },
      paypalOAuth,
    },
    { status: dbOk ? 200 : 503 }
  );
}

