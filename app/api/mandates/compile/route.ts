import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { compileAndStoreMandate, MAX_INSTRUCTION_LENGTH } from '@/lib/mandate/compiler';
import { getOrCreateSession } from '@/lib/session';

const compileRequestSchema = z.object({
  instruction: z.string().trim().min(3).max(MAX_INSTRUCTION_LENGTH),
  forceFresh: z.boolean().optional(),
  clarifications: z
    .object({
      allowed_brands: z.array(z.string()).optional(),
      max_total: z.number().positive().optional(),
      allowed_categories: z.array(z.string()).optional(),
      allowed_conditions: z.array(z.enum(['new', 'used', 'refurbished'])).optional(),
      accessories_allowed: z.boolean().optional(),
      approval_above: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = compileRequestSchema.parse(await request.json());
    const { session } = await getOrCreateSession(request.headers.get('user-agent'));
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null;

    const db = getDb();
    const { mandateRow, compiled, cached } = await compileAndStoreMandate(db, {
      sessionId: session.id,
      instruction: body.instruction,
      clarifications: body.clarifications,
      forceFresh: body.forceFresh,
      ipAddress,
    });

    return NextResponse.json(
      {
        mandateId: mandateRow.id,
        status: mandateRow.status,
        compilerModel: mandateRow.compiler_model,
        cached,
        originalInstruction: mandateRow.original_instruction,
        compiledMandate: compiled,
      },
      { status: 201 }
    );
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

