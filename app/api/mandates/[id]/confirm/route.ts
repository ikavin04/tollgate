import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import { confirmMandate } from '@/lib/mandate/compiler';
import { requireCurrentSession } from '@/lib/session';

const confirmBodySchema = z
  .object({
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
  })
  .optional();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireCurrentSession();
    const { id: mandateId } = await context.params;
    let body: z.infer<typeof confirmBodySchema>;
    try {
      const text = await request.text();
      body = text ? confirmBodySchema.parse(JSON.parse(text)) : undefined;
    } catch (parseErr) {
      return jsonErrorResponse(parseErr);
    }

    const db = getDb();
    const { mandateRow, compiled } = confirmMandate(db, {
      sessionId: session.id,
      mandateId,
      clarifications: body?.clarifications,
    });

    return NextResponse.json({
      mandateId: mandateRow.id,
      status: mandateRow.status,
      confirmedAt: mandateRow.confirmed_at,
      compiledMandate: compiled,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

