export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logEnvStartupValidation } = await import('@/lib/env');
    const { getDb } = await import('@/lib/db');
    logEnvStartupValidation();
    getDb();
  }
}

