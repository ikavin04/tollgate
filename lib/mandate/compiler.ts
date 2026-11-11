import 'server-only';
import type Database from 'better-sqlite3';
import { Type, type Schema } from '@google/genai';
import {
  buildLlmCacheKey,
  enforceRateLimit,
  GeminiMalformedOutputError,
  generateWithGemini,
  readLlmCache,
  writeLlmCache,
} from '@/lib/ai/gemini';
import { newUuid } from '@/lib/crypto';
import { getEnvStatus } from '@/lib/env';
import { appendLedgerEvent } from '@/lib/ledger';
import { assertSessionOwned } from '@/lib/session';
import {
  compiledMandateSchema,
  KNOWN_STORE_BRANDS,
  rawMandateLlmOutputSchema,
  SUPPORTED_CATEGORIES,
  SUPPORTED_CONDITIONS,
  type CompiledMandate,
  type RawMandateLlmOutput,
  type UnresolvedRequirement,
} from './schema';

export const MANDATE_COMPILER_PROMPT_VERSION = 'mandate-compiler-v1.0';
export const MAX_INSTRUCTION_LENGTH = 1500;

export interface MandateRow {
  id: string;
  session_id: string;
  original_instruction: string;
  compiled_mandate_json: string;
  status: 'DRAFT' | 'NEEDS_CLARIFICATION' | 'CONFIRMED' | 'SUPERSEDED' | 'EXPIRED';
  compiler_model: string;
  compiler_cached: number;
  clarification_answers_json: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClarificationInput {
  allowed_brands?: string[];
  max_total?: number;
  allowed_categories?: string[];
  allowed_conditions?: Array<'new' | 'used' | 'refurbished'>;
  accessories_allowed?: boolean;
  approval_above?: number | null;
}

export type MandateCompilerLlmFn = (instruction: string) => Promise<RawMandateLlmOutput>;

const mandateResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    intent_summary: { type: Type.STRING },
    max_total: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING },
    max_quantity: { type: Type.INTEGER, nullable: true },
    allowed_categories: { type: Type.ARRAY, items: { type: Type.STRING } },
    allowed_accessory_categories: { type: Type.ARRAY, items: { type: Type.STRING } },
    allowed_brands: { type: Type.ARRAY, items: { type: Type.STRING } },
    allowed_conditions: { type: Type.ARRAY, items: { type: Type.STRING } },
    hard_requirements: {
      type: Type.OBJECT,
      properties: {
        minimum_ram_gb: { type: Type.INTEGER, nullable: true },
        minimum_storage_gb: { type: Type.INTEGER, nullable: true },
        condition: { type: Type.STRING, nullable: true },
      },
    },
    soft_requirements: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          attribute: { type: Type.STRING },
          preferred_value: { type: Type.STRING },
          priority: { type: Type.STRING },
          fallback_value: { type: Type.STRING, nullable: true },
          fallback_condition: { type: Type.STRING, nullable: true },
        },
        required: ['attribute', 'preferred_value', 'priority'],
      },
    },
    accessories_allowed: { type: Type.BOOLEAN },
    approval_above: { type: Type.NUMBER, nullable: true },
    expires_at: { type: Type.STRING, nullable: true },
    warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
    unresolved_requirements: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING },
          field: { type: Type.STRING },
          question: { type: Type.STRING },
          suggested_options: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['code', 'field', 'question'],
      },
    },
    unparseable_reason: { type: Type.STRING, nullable: true },
  },
  required: [
    'intent_summary',
    'currency',
    'allowed_categories',
    'allowed_accessory_categories',
    'allowed_brands',
    'allowed_conditions',
    'hard_requirements',
    'soft_requirements',
    'accessories_allowed',
    'warnings',
    'unresolved_requirements',
  ],
};

const MANDATE_SYSTEM_INSTRUCTION = `You are the Tollgate Mandate Compiler.
Convert a human purchasing instruction into strict JSON policy rules for Tollgate.

Supported storefront categories are ONLY: laptop, accessory, gift_card, bundle.
Supported conditions are ONLY: new, used, refurbished.
Known storefront brands are: Northstar, ApexTech, Vanguard, Kestrel.

CRITICAL SECURITY & COMPLETENESS RULES:
1. NEVER invent brands that the user did not name. If the user says "only approved brands" or "approved brands" without naming specific brands, leave allowed_brands as [] and add an unresolved_requirements entry asking the user which brands are approved.
2. NEVER silently discard a user requirement. If the user asks for an unsupported category (e.g. "monitors", "smartphones", "chairs"), keep it or flag it in unresolved_requirements with code UNSUPPORTED_CATEGORY.
3. If the instruction has conflicting requirements (e.g. "new and used only", "no accessories" combined with "include wireless mouse", or approval_above > max_total), add an unresolved_requirements entry or explicit warning.
4. If the instruction is unparseable, lacks a clear purchasing intent, or lacks a budget (max_total), set max_total to null and add an unresolved_requirements entry rather than guessing a budget.
5. Distinguish hard requirements from soft preferences: e.g. "Prefer 16 GB RAM" becomes a soft_requirement with attribute "ram_gb", preferred_value 16, priority "high", fallback_value 8, fallback_condition "No suitable 16GB model within budget".
6. Never authorize gift_card unless the user explicitly asked for gift cards.
7. For numeric soft preference values (like 16 for ram_gb), keep them numeric or string cleanly.
8. Currency defaults to "USD" unless explicitly specified otherwise.`;

function coerceSoftValue(v: string | number | boolean | null | undefined): string | number | boolean | null | undefined {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

/**
 * Deterministic security validator over LLM-compiled mandate JSON.
 * Ensures missing, invalid, unsupported, conflicting, or ambiguous requirements are never silently dropped.
 */
export function validateAndNormalizeCompiledMandate(
  originalInstruction: string,
  raw: RawMandateLlmOutput,
  clarifications?: ClarificationInput
): {
  mandate: CompiledMandate;
  needsClarification: boolean;
} {
  const unresolved: UnresolvedRequirement[] = [...(raw.unresolved_requirements ?? [])];
  const warnings: string[] = [...(raw.warnings ?? [])];

  const addUnresolved = (item: UnresolvedRequirement) => {
    if (!unresolved.some((u) => u.code === item.code && u.field === item.field)) {
      unresolved.push(item);
    }
  };

  if (raw.unparseable_reason) {
    addUnresolved({
      code: 'UNPARSEABLE_INSTRUCTION',
      field: 'instruction',
      question: `Unable to unambiguously parse instruction: ${raw.unparseable_reason}`,
    });
  }

  // Merge user clarifications if provided
  const mergedMaxTotal =
    clarifications?.max_total !== undefined ? clarifications.max_total : raw.max_total;
  const mergedBrands =
    clarifications?.allowed_brands !== undefined
      ? clarifications.allowed_brands.map((b) => b.trim()).filter(Boolean)
      : raw.allowed_brands.map((b) => b.trim()).filter(Boolean);
  const mergedCategories =
    clarifications?.allowed_categories !== undefined
      ? clarifications.allowed_categories.map((c) => c.trim().toLowerCase()).filter(Boolean)
      : raw.allowed_categories.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const mergedConditions =
    clarifications?.allowed_conditions !== undefined
      ? clarifications.allowed_conditions
      : raw.allowed_conditions.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const mergedAccessoriesAllowed =
    clarifications?.accessories_allowed !== undefined
      ? clarifications.accessories_allowed
      : raw.accessories_allowed;
  const mergedApprovalAbove =
    clarifications?.approval_above !== undefined ? clarifications.approval_above : raw.approval_above ?? null;

  // 1. Validate currency
  const currencyNormalized = raw.currency?.trim().toUpperCase();
  if (currencyNormalized !== 'USD') {
    addUnresolved({
      code: 'UNSUPPORTED_CURRENCY',
      field: 'currency',
      question: `Only USD is supported in PayPal Sandbox MVP (got "${raw.currency}"). Confirm USD or revise instruction.`,
      suggested_options: ['USD'],
    });
  }

  // 2. Validate budget
  let effectiveMaxTotal = typeof mergedMaxTotal === 'number' && Number.isFinite(mergedMaxTotal) ? mergedMaxTotal : 0;
  if (!mergedMaxTotal || mergedMaxTotal <= 0) {
    addUnresolved({
      code: 'MISSING_BUDGET',
      field: 'max_total',
      question: 'No valid maximum budget (max_total in USD) could be established. Specify a maximum spend limit.',
      suggested_options: ['300', '500', '700'],
    });
    effectiveMaxTotal = 500; // placeholder only while NEEDS_CLARIFICATION blocks activation
  }

  // 3. Validate quantity
  const rawQty = raw.max_quantity ?? 1;
  const maxQuantity = Number.isInteger(rawQty) && rawQty >= 1 ? rawQty : 1;
  if (raw.max_quantity !== undefined && raw.max_quantity !== null && (!Number.isInteger(raw.max_quantity) || raw.max_quantity < 1)) {
    addUnresolved({
      code: 'INVALID_QUANTITY',
      field: 'max_quantity',
      question: `Invalid quantity "${raw.max_quantity}". Must be a positive integer.`,
      suggested_options: ['1', '2'],
    });
  }

  // 4. Validate categories & detect unsupported categories
  const supportedSet = new Set<string>(SUPPORTED_CATEGORIES);
  const unsupportedCats = mergedCategories.filter((c) => !supportedSet.has(c));
  const validCategories = mergedCategories.filter((c) => supportedSet.has(c));

  if (unsupportedCats.length > 0) {
    addUnresolved({
      code: 'UNSUPPORTED_CATEGORY',
      field: 'allowed_categories',
      question: `Unsupported product category requested: [${unsupportedCats.join(', ')}]. Tollgate catalog supports: ${SUPPORTED_CATEGORIES.join(', ')}.`,
      suggested_options: [...SUPPORTED_CATEGORIES],
    });
  }
  if (validCategories.length === 0) {
    addUnresolved({
      code: 'MISSING_CATEGORY',
      field: 'allowed_categories',
      question: 'No supported product category was identified in your instruction. Select at least one supported category.',
      suggested_options: [...SUPPORTED_CATEGORIES],
    });
  }

  // 5. Validate conditions & conflicting condition rules
  const conditionSet = new Set<string>(SUPPORTED_CONDITIONS);
  const validConditions = mergedConditions.filter((c): c is 'new' | 'used' | 'refurbished' =>
    conditionSet.has(c)
  );
  const hardConditionRaw = raw.hard_requirements?.condition?.trim().toLowerCase() ?? null;
  const hardCondition =
    hardConditionRaw && conditionSet.has(hardConditionRaw)
      ? (hardConditionRaw as 'new' | 'used' | 'refurbished')
      : null;

  if (validConditions.length === 0) {
    addUnresolved({
      code: 'MISSING_CONDITION',
      field: 'allowed_conditions',
      question: 'Specify allowed product condition(s).',
      suggested_options: [...SUPPORTED_CONDITIONS],
    });
  }
  if (hardCondition && validConditions.length > 0 && !validConditions.includes(hardCondition)) {
    addUnresolved({
      code: 'CONFLICTING_CONDITION',
      field: 'allowed_conditions',
      question: `Conflicting condition requirement: hard requirement "${hardCondition}" conflicts with allowed_conditions [${validConditions.join(', ')}].`,
      suggested_options: [hardCondition],
    });
  }
  if (/\bnew\b/i.test(originalInstruction) && /\bused\b/i.test(originalInstruction) && !/\bnew\s+or\s+used\b/i.test(originalInstruction)) {
    addUnresolved({
      code: 'CONFLICTING_REQUIREMENTS',
      field: 'allowed_conditions',
      question: 'Instruction mentions both "new" and "used" without stating "new or used". Clarify which condition is permitted.',
      suggested_options: ['new', 'used'],
    });
  }

  // 6. Ambiguous brand restrictions / missing approved-brand list
  const mentionsApprovedBrandsPhrase =
    /\b(approved\s+brands?|whitelist(?:ed)?\s+brands?|authorized\s+brands?|approved\s+vendors?|only\s+approved)\b/i.test(
      originalInstruction
    );
  const mentionsBrandConstraint =
    /\b(only\s+brand|specific\s+brand|trusted\s+brands?)\b/i.test(originalInstruction);

  if ((mentionsApprovedBrandsPhrase || mentionsBrandConstraint) && mergedBrands.length === 0) {
    addUnresolved({
      code: 'MISSING_APPROVED_BRANDS',
      field: 'allowed_brands',
      question:
        'You required approved brands only, but did not list which brands are approved. Select one or more approved brands before confirming this mandate.',
      suggested_options: [...KNOWN_STORE_BRANDS],
    });
  }

  // Filter out duplicate resolved brand question if user supplied brands via clarification
  const resolvedUnresolved = unresolved.filter((item) => {
    if (
      (item.code === 'MISSING_APPROVED_BRANDS' || item.field === 'allowed_brands') &&
      mergedBrands.length > 0
    ) {
      return false;
    }
    if (item.field === 'max_total' && clarifications?.max_total && clarifications.max_total > 0) {
      return false;
    }
    if (
      item.field === 'allowed_categories' &&
      clarifications?.allowed_categories &&
      validCategories.length > 0 &&
      unsupportedCats.length === 0
    ) {
      return false;
    }
    if (
      item.field === 'allowed_conditions' &&
      clarifications?.allowed_conditions &&
      validConditions.length > 0
    ) {
      return false;
    }
    return true;
  });

  // 7. Conflicting accessory rule check
  if (
    /\bno\s+accessories\b/i.test(originalInstruction) &&
    (mergedAccessoriesAllowed || validCategories.includes('accessory'))
  ) {
    if (clarifications?.accessories_allowed === undefined) {
      addUnresolvedTo(resolvedUnresolved, {
        code: 'CONFLICTING_ACCESSORIES_RULE',
        field: 'accessories_allowed',
        question:
          'Your instruction states "no accessories" while also permitting accessories. Confirm whether accessories are strictly forbidden.',
        suggested_options: ['false', 'true'],
      });
    }
  }

  if (mergedApprovalAbove !== null && mergedApprovalAbove > effectiveMaxTotal) {
    warnings.push(
      `approval_above ($${mergedApprovalAbove}) exceeds max_total ($${effectiveMaxTotal}); all proposals above max_total will be blocked.`
    );
  }

  // Normalize soft requirements
  const normalizedSoft = (raw.soft_requirements ?? []).map((sr) => ({
    attribute: sr.attribute,
    preferred_value: coerceSoftValue(sr.preferred_value) ?? sr.preferred_value,
    priority: sr.priority,
    fallback_value: coerceSoftValue(sr.fallback_value ?? null),
    fallback_condition: sr.fallback_condition ?? null,
  }));

  let expiresAt: string | null = null;
  if (raw.expires_at) {
    const parsedDate = new Date(raw.expires_at);
    if (!Number.isNaN(parsedDate.getTime())) {
      expiresAt = parsedDate.toISOString();
    } else {
      warnings.push(`Ignored invalid expires_at timestamp "${raw.expires_at}"`);
    }
  }

  const candidateMandate: CompiledMandate = {
    intent_summary: (raw.intent_summary || 'Purchasing mandate').slice(0, 300),
    max_total: effectiveMaxTotal,
    currency: 'USD',
    max_quantity: maxQuantity,
    allowed_categories: validCategories.length > 0 ? validCategories : ['laptop'],
    allowed_accessory_categories: mergedAccessoriesAllowed
      ? (raw.allowed_accessory_categories ?? [])
      : [],
    allowed_brands: mergedBrands,
    allowed_conditions: validConditions.length > 0 ? validConditions : ['new'],
    hard_requirements: {
      minimum_ram_gb: raw.hard_requirements?.minimum_ram_gb ?? null,
      minimum_storage_gb: raw.hard_requirements?.minimum_storage_gb ?? null,
      condition: hardCondition,
    },
    soft_requirements: normalizedSoft,
    accessories_allowed: mergedAccessoriesAllowed,
    approval_above: mergedApprovalAbove,
    expires_at: expiresAt,
    warnings,
    unresolved_requirements: resolvedUnresolved,
  };

  const validated = compiledMandateSchema.parse(candidateMandate);
  return {
    mandate: validated,
    needsClarification: validated.unresolved_requirements.length > 0,
  };
}

function addUnresolvedTo(list: UnresolvedRequirement[], item: UnresolvedRequirement) {
  if (!list.some((u) => u.code === item.code && u.field === item.field)) {
    list.push(item);
  }
}

export async function callGeminiMandateCompiler(
  instruction: string
): Promise<RawMandateLlmOutput> {
  const response = await generateWithGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Compile this human purchasing instruction into the Tollgate mandate JSON schema:\n\n"""${instruction}"""`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: MANDATE_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: mandateResponseSchema,
      temperature: 0.1,
      maxOutputTokens: 1500,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new GeminiMalformedOutputError('Mandate compiler returned an empty response from Gemini');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new GeminiMalformedOutputError('Mandate compiler returned non-JSON output from Gemini');
  }

  const parsed = rawMandateLlmOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new GeminiMalformedOutputError(
      `Mandate compiler output failed Zod schema check: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }

  return parsed.data;
}

/**
 * Compiles a natural-language instruction into a draft or clarification-pending mandate
 * stored in SQLite (with LLM caching and ledger recording). Never auto-confirms!
 */
export async function compileAndStoreMandate(
  db: Database.Database,
  options: {
    sessionId: string;
    instruction: string;
    clarifications?: ClarificationInput;
    ipAddress?: string | null;
    forceFresh?: boolean;
    llmCaller?: MandateCompilerLlmFn;
  }
): Promise<{
  mandateRow: MandateRow;
  compiled: CompiledMandate;
  cached: boolean;
}> {
  const trimmed = options.instruction.trim();
  if (trimmed.length < 3 || trimmed.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(
      `Instruction length must be between 3 and ${MAX_INSTRUCTION_LENGTH} characters.`
    );
  }

  const modelId = getEnvStatus().geminiModel;
  const { cacheKey, inputHash } = buildLlmCacheKey({
    modelId,
    promptVersion: MANDATE_COMPILER_PROMPT_VERSION,
    purpose: 'MANDATE_COMPILE',
    inputPayload: { instruction: trimmed },
    scenario: 'mandate-compile',
    sessionContext: options.sessionId,
  });

  let rawOutput: RawMandateLlmOutput | null = null;
  let cached = false;

  if (!options.forceFresh) {
    rawOutput = readLlmCache<RawMandateLlmOutput>(db, options.sessionId, cacheKey);
    if (rawOutput) {
      cached = true;
    }
  }

  if (!rawOutput) {
    if (!options.llmCaller) {
      enforceRateLimit(db, {
        sessionId: options.sessionId,
        ipAddress: options.ipAddress,
        scope: 'mandate_compile',
        maxRequestsPerSessionWindow: 15,
        maxRequestsPerIpWindow: 30,
      });
    }
    const caller = options.llmCaller ?? callGeminiMandateCompiler;
    rawOutput = await caller(trimmed);
    writeLlmCache(db, {
      cacheKey,
      sessionId: options.sessionId,
      modelId,
      promptVersion: MANDATE_COMPILER_PROMPT_VERSION,
      purpose: 'MANDATE_COMPILE',
      inputHash,
      output: rawOutput,
    });
  }

  const { mandate, needsClarification } = validateAndNormalizeCompiledMandate(
    trimmed,
    rawOutput,
    options.clarifications
  );

  const id = newUuid();
  const now = new Date().toISOString();
  const status: MandateRow['status'] = needsClarification ? 'NEEDS_CLARIFICATION' : 'DRAFT';

  const row: MandateRow = {
    id,
    session_id: options.sessionId,
    original_instruction: trimmed,
    compiled_mandate_json: JSON.stringify(mandate),
    status,
    compiler_model: modelId,
    compiler_cached: cached ? 1 : 0,
    clarification_answers_json: options.clarifications ? JSON.stringify(options.clarifications) : null,
    confirmed_at: null,
    expires_at: mandate.expires_at,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO mandates (
      id, session_id, original_instruction, compiled_mandate_json, status,
      compiler_model, compiler_cached, clarification_answers_json, confirmed_at,
      expires_at, created_at, updated_at
    ) VALUES (
      @id, @session_id, @original_instruction, @compiled_mandate_json, @status,
      @compiler_model, @compiler_cached, @clarification_answers_json, @confirmed_at,
      @expires_at, @created_at, @updated_at
    )`
  ).run(row);

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    eventType: 'MANDATE_SUBMITTED',
    actor: 'USER',
    payload: {
      mandate_id: id,
      status,
      cached_ai_result: cached,
      unresolved_count: mandate.unresolved_requirements.length,
    },
  });

  return { mandateRow: row, compiled: mandate, cached };
}

/**
 * Resolves any clarifications and confirms a mandate so the Shopping Agent may execute against it.
 */
export function confirmMandate(
  db: Database.Database,
  options: {
    sessionId: string;
    mandateId: string;
    clarifications?: ClarificationInput;
  }
): { mandateRow: MandateRow; compiled: CompiledMandate } {
  const existing = assertSessionOwned(
    db
      .prepare('SELECT * FROM mandates WHERE id = ? AND session_id = ?')
      .get(options.mandateId, options.sessionId) as MandateRow | undefined,
    options.sessionId,
    'Mandate'
  );

  const parsedCurrent = compiledMandateSchema.parse(
    JSON.parse(existing.compiled_mandate_json)
  );

  // Re-run deterministic validator if clarifications were submitted
  let finalMandate = parsedCurrent;
  if (options.clarifications) {
    const revalidated = validateAndNormalizeCompiledMandate(
      existing.original_instruction,
      {
        ...parsedCurrent,
        unparseable_reason: null,
      },
      options.clarifications
    );
    finalMandate = revalidated.mandate;
  }

  if (finalMandate.unresolved_requirements.length > 0) {
    throw new Error(
      `Mandate still has ${finalMandate.unresolved_requirements.length} unresolved requirement(s): ${finalMandate.unresolved_requirements.map((u) => u.question).join(' | ')}`
    );
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE mandates
     SET compiled_mandate_json = ?,
         status = 'CONFIRMED',
         clarification_answers_json = COALESCE(?, clarification_answers_json),
         confirmed_at = ?,
         updated_at = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    JSON.stringify(finalMandate),
    options.clarifications ? JSON.stringify(options.clarifications) : null,
    now,
    now,
    existing.id,
    options.sessionId
  );

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    eventType: 'MANDATE_CONFIRMED',
    actor: 'USER',
    payload: {
      mandate_id: existing.id,
      max_total: finalMandate.max_total,
      allowed_brands: finalMandate.allowed_brands,
      allowed_categories: finalMandate.allowed_categories,
      accessories_allowed: finalMandate.accessories_allowed,
    },
  });

  const updated = db
    .prepare('SELECT * FROM mandates WHERE id = ? AND session_id = ?')
    .get(existing.id, options.sessionId) as MandateRow;

  return { mandateRow: updated, compiled: finalMandate };
}

export function listSessionMandates(
  db: Database.Database,
  sessionId: string
): MandateRow[] {
  return db
    .prepare('SELECT * FROM mandates WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as MandateRow[];
}

export function getSessionMandate(
  db: Database.Database,
  sessionId: string,
  mandateId: string
): { mandateRow: MandateRow; compiled: CompiledMandate } {
  const row = assertSessionOwned(
    db
      .prepare('SELECT * FROM mandates WHERE id = ? AND session_id = ?')
      .get(mandateId, sessionId) as MandateRow | undefined,
    sessionId,
    'Mandate'
  );
  return {
    mandateRow: row,
    compiled: compiledMandateSchema.parse(JSON.parse(row.compiled_mandate_json)),
  };
}

