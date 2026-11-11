import { z } from 'zod';

export const SUPPORTED_CATEGORIES = [
  'laptop',
  'accessory',
  'gift_card',
  'bundle',
] as const;

export const SUPPORTED_CONDITIONS = ['new', 'used', 'refurbished'] as const;

export const softRequirementSchema = z.object({
  attribute: z.string().trim().min(1),
  preferred_value: z.union([z.string(), z.number(), z.boolean()]),
  priority: z.enum(['low', 'medium', 'high']),
  fallback_value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  fallback_condition: z.string().trim().nullable().optional(),
});

export const unresolvedRequirementSchema = z.object({
  code: z.string().trim().min(1),
  field: z.string().trim().min(1),
  question: z.string().trim().min(1),
  suggested_options: z.array(z.string()).optional(),
});

export const compiledMandateSchema = z.object({
  intent_summary: z.string().trim().min(1).max(300),
  max_total: z.number().finite().positive().max(100_000),
  currency: z.enum(['USD']),
  max_quantity: z.number().int().min(1).max(20),
  allowed_categories: z.array(z.string().trim().min(1)).min(1),
  allowed_accessory_categories: z.array(z.string().trim().min(1)),
  allowed_brands: z.array(z.string().trim().min(1)),
  allowed_conditions: z.array(z.enum(SUPPORTED_CONDITIONS)).min(1),
  hard_requirements: z.object({
    minimum_ram_gb: z.number().int().positive().nullable().optional(),
    minimum_storage_gb: z.number().int().positive().nullable().optional(),
    condition: z.enum(SUPPORTED_CONDITIONS).nullable().optional(),
  }),
  soft_requirements: z.array(softRequirementSchema),
  accessories_allowed: z.boolean(),
  approval_above: z.number().finite().nonnegative().nullable(),
  expires_at: z.string().datetime().nullable(),
  warnings: z.array(z.string()),
  unresolved_requirements: z.array(unresolvedRequirementSchema),
});

export type SoftRequirement = z.infer<typeof softRequirementSchema>;
export type UnresolvedRequirement = z.infer<typeof unresolvedRequirementSchema>;
export type CompiledMandate = z.infer<typeof compiledMandateSchema>;

export const rawMandateLlmOutputSchema = z.object({
  intent_summary: z.string().default('Purchase request'),
  max_total: z.number().nullable().optional(),
  currency: z.string().default('USD'),
  max_quantity: z.number().nullable().optional(),
  allowed_categories: z.array(z.string()).default([]),
  allowed_accessory_categories: z.array(z.string()).default([]),
  allowed_brands: z.array(z.string()).default([]),
  allowed_conditions: z.array(z.string()).default(['new']),
  hard_requirements: z
    .object({
      minimum_ram_gb: z.number().nullable().optional(),
      minimum_storage_gb: z.number().nullable().optional(),
      condition: z.string().nullable().optional(),
    })
    .default({}),
  soft_requirements: z.array(softRequirementSchema).default([]),
  accessories_allowed: z.boolean().default(false),
  approval_above: z.number().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
  unresolved_requirements: z.array(unresolvedRequirementSchema).default([]),
  unparseable_reason: z.string().nullable().optional(),
});

export type RawMandateLlmOutput = z.infer<typeof rawMandateLlmOutputSchema>;

export const KNOWN_STORE_BRANDS = ['Northstar', 'ApexTech', 'Vanguard', 'Kestrel'] as const;

