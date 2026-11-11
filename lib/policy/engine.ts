import type { CompiledMandate } from '@/lib/mandate/schema';
import { formatCents } from '@/lib/crypto';

export type PolicyDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  price_cents: number;
  currency: string;
  condition: string;
  ram_gb: number | null;
  storage_gb: number | null;
  weight_kg: number | null;
  warranty_summary: string;
  extended_warranty_included: number;
  specifications_json: string;
  storefront_path: string;
  raw_html_template: string;
  is_malicious_scenario: number;
  scenario_tag: string | null;
  in_stock: number;
}

export interface ProposedLineItem {
  product: CatalogProduct;
  quantity: number;
}

export interface PolicyCheckResult {
  rule: string;
  severity: 'HARD' | 'SOFT' | 'REVIEW_TRIGGER';
  passed: boolean;
  outcomeIfFailed: PolicyDecision;
  detail: string;
  evidenceRefs?: string[];
}

export interface EligibleAlternativeSummary {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  price_cents: number;
  price_formatted: string;
  ram_gb: number | null;
  storage_gb: number | null;
  condition: string;
}

export interface DeterministicPolicyResult {
  decision: PolicyDecision;
  passed_checks: PolicyCheckResult[];
  failed_checks: PolicyCheckResult[];
  warnings: string[];
  evidence_references: string[];
  reasons: string[];
  alternative_eligible_products: EligibleAlternativeSummary[];
}

function productMatchesHardRules(
  product: CatalogProduct,
  mandate: CompiledMandate
): boolean {
  if (product.in_stock !== 1) return false;
  if (product.currency !== mandate.currency) return false;
  if (product.price_cents > Math.round(mandate.max_total * 100)) return false;

  if (product.category === 'gift_card') {
    if (!mandate.allowed_categories.includes('gift_card')) return false;
  } else if (product.category === 'accessory') {
    if (!mandate.accessories_allowed) return false;
    if (!mandate.allowed_categories.includes('accessory')) return false;
  } else if (!mandate.allowed_categories.includes(product.category)) {
    return false;
  }

  if (mandate.allowed_brands.length > 0) {
    const allowedBrandsLower = mandate.allowed_brands.map((b) => b.toLowerCase());
    if (!allowedBrandsLower.includes(product.brand.toLowerCase())) return false;
  }

  if (!mandate.allowed_conditions.includes(product.condition as 'new' | 'used' | 'refurbished')) {
    return false;
  }
  if (
    mandate.hard_requirements.condition &&
    product.condition !== mandate.hard_requirements.condition
  ) {
    return false;
  }

  if (
    mandate.hard_requirements.minimum_ram_gb !== null &&
    mandate.hard_requirements.minimum_ram_gb !== undefined
  ) {
    if (product.ram_gb === null || product.ram_gb < mandate.hard_requirements.minimum_ram_gb) {
      return false;
    }
  }

  if (
    mandate.hard_requirements.minimum_storage_gb !== null &&
    mandate.hard_requirements.minimum_storage_gb !== undefined
  ) {
    if (
      product.storage_gb === null ||
      product.storage_gb < mandate.hard_requirements.minimum_storage_gb
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Pure deterministic policy engine (no LLM calls).
 * Evaluates every proposed line item against hard rules, structured soft preferences,
 * approval thresholds, bundle ambiguity, and evidence truncation.
 * Escalation precedence: BLOCK > REVIEW > ALLOW.
 */
export function evaluateDeterministicPolicy(options: {
  mandate: CompiledMandate;
  mandateConfirmed: boolean;
  mandateExpiresAt?: string | null;
  items: ProposedLineItem[];
  catalog: CatalogProduct[];
  evidenceMeta?: {
    anyTruncated: boolean;
    truncatedPageIds?: string[];
    evidenceIds?: string[];
  };
}): DeterministicPolicyResult {
  const { mandate, items, catalog } = options;
  const checks: PolicyCheckResult[] = [];
  const warnings: string[] = [];
  const evidenceRefs = new Set<string>(options.evidenceMeta?.evidenceIds ?? []);

  // 1. Mandate confirmed and not expired
  const isNotExpired =
    !options.mandateExpiresAt || new Date(options.mandateExpiresAt).getTime() > Date.now();
  checks.push({
    rule: 'mandate_confirmed_and_active',
    severity: 'HARD',
    passed: options.mandateConfirmed && isNotExpired && mandate.unresolved_requirements.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail: !options.mandateConfirmed
      ? 'Mandate has not been confirmed by a human.'
      : !isNotExpired
        ? 'Mandate has expired.'
        : mandate.unresolved_requirements.length > 0
          ? 'Mandate still has unresolved requirements.'
          : 'Mandate is confirmed and active.',
  });

  // 2. Non-empty items and valid integer quantities
  const validQuantities =
    items.length > 0 &&
    items.every((i) => Number.isInteger(i.quantity) && i.quantity >= 1 && i.product.in_stock === 1);
  const totalQuantity = items.reduce((acc, i) => acc + i.quantity, 0);

  checks.push({
    rule: 'max_quantity_check',
    severity: 'HARD',
    passed: validQuantities && totalQuantity <= mandate.max_quantity,
    outcomeIfFailed: 'BLOCK',
    detail: `Total proposed quantity ${totalQuantity} vs max_quantity ${mandate.max_quantity}.`,
  });

  // 3. Currency check
  const allCurrencyOk =
    items.length > 0 && items.every((i) => i.product.currency === mandate.currency);
  checks.push({
    rule: 'currency_check',
    severity: 'HARD',
    passed: allCurrencyOk,
    outcomeIfFailed: 'BLOCK',
    detail: allCurrencyOk
      ? `All items match mandate currency ${mandate.currency}.`
      : `Currency mismatch: expected ${mandate.currency}.`,
  });

  // 4. Max total budget check (integer cents)
  const totalCents = items.reduce((acc, i) => acc + i.product.price_cents * i.quantity, 0);
  const maxTotalCents = Math.round(mandate.max_total * 100);
  checks.push({
    rule: 'max_total_check',
    severity: 'HARD',
    passed: totalCents <= maxTotalCents,
    outcomeIfFailed: 'BLOCK',
    detail: `Proposed total $${formatCents(totalCents)} vs max_total $${formatCents(maxTotalCents)}.`,
  });

  // 5. Category & Gift-Card isolation check
  const categoryViolations: string[] = [];
  let hasAmbiguousBundle = false;

  for (const { product } of items) {
    if (product.category === 'gift_card') {
      // Do NOT let accessories_allowed automatically authorize gift cards.
      if (!mandate.allowed_categories.includes('gift_card')) {
        categoryViolations.push(
          `${product.name} (category: gift_card) is forbidden; accessories_allowed never authorizes gift cards.`
        );
      }
      continue;
    }

    if (product.category === 'accessory') {
      const allowedByAccessoryList =
        mandate.accessories_allowed &&
        (mandate.allowed_categories.includes('accessory') ||
          mandate.allowed_accessory_categories.some((ac) =>
            product.name.toLowerCase().includes(ac.toLowerCase())
          ));
      if (!allowedByAccessoryList) {
        categoryViolations.push(
          `${product.name} (category: accessory) violates accessories_allowed=${mandate.accessories_allowed} / allowed_categories=[${mandate.allowed_categories.join(', ')}].`
        );
      }
      continue;
    }

    if (product.category === 'bundle') {
      let specs: Record<string, unknown> = {};
      try {
        specs = JSON.parse(product.specifications_json) as Record<string, unknown>;
      } catch {
        specs = {};
      }
      const bundleAllowed = mandate.allowed_categories.includes('bundle');
      if (!bundleAllowed) {
        categoryViolations.push(
          `${product.name} (category: bundle) is not in allowed_categories [${mandate.allowed_categories.join(', ')}].`
        );
      } else if (specs.ambiguous_bundle === true || !mandate.accessories_allowed) {
        hasAmbiguousBundle = true;
      }
      continue;
    }

    if (!mandate.allowed_categories.includes(product.category)) {
      categoryViolations.push(
        `${product.name} (category: ${product.category}) is not in allowed_categories [${mandate.allowed_categories.join(', ')}].`
      );
    }
  }

  checks.push({
    rule: 'allowed_categories_check',
    severity: 'HARD',
    passed: categoryViolations.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail:
      categoryViolations.length === 0
        ? `All proposed item categories are permitted.`
        : categoryViolations.join(' | '),
  });

  // 6. Unauthorized extra products check (unexpected multiple distinct SKUs or quantities exceeding 1 when max_quantity === 1)
  const extraItemsViolations: string[] = [];
  if (items.length > mandate.max_quantity) {
    extraItemsViolations.push(
      `Proposal contains ${items.length} line items exceeding max_quantity ${mandate.max_quantity}.`
    );
  }
  checks.push({
    rule: 'unauthorized_extra_products_check',
    severity: 'HARD',
    passed: extraItemsViolations.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail:
      extraItemsViolations.length === 0
        ? 'No unauthorized extra products detected.'
        : extraItemsViolations.join(' | '),
  });

  // 7. Allowed brands check
  const allowedBrandsLower = mandate.allowed_brands.map((b) => b.toLowerCase());
  const brandViolations =
    allowedBrandsLower.length === 0
      ? []
      : items
          .filter((i) => !allowedBrandsLower.includes(i.product.brand.toLowerCase()))
          .map(
            (i) =>
              `${i.product.name} (brand: ${i.product.brand}) is not in allowed_brands [${mandate.allowed_brands.join(', ')}]`
          );

  checks.push({
    rule: 'allowed_brands_check',
    severity: 'HARD',
    passed: brandViolations.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail:
      mandate.allowed_brands.length === 0
        ? 'No brand allow-list restricted on mandate.'
        : brandViolations.length === 0
          ? `All items match allowed brands [${mandate.allowed_brands.join(', ')}].`
          : brandViolations.join(' | '),
  });

  // 8. Product condition check
  const conditionViolations = items
    .filter((i) => {
      const allowedByList = mandate.allowed_conditions.includes(
        i.product.condition as 'new' | 'used' | 'refurbished'
      );
      const allowedByHard =
        !mandate.hard_requirements.condition ||
        i.product.condition === mandate.hard_requirements.condition;
      return !allowedByList || !allowedByHard;
    })
    .map(
      (i) =>
        `${i.product.name} condition "${i.product.condition}" violates allowed conditions [${mandate.allowed_conditions.join(', ')}]`
    );

  checks.push({
    rule: 'condition_check',
    severity: 'HARD',
    passed: conditionViolations.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail:
      conditionViolations.length === 0
        ? `All items satisfy condition rules [${mandate.allowed_conditions.join(', ')}].`
        : conditionViolations.join(' | '),
  });

  // 9. Mandatory technical specifications check
  const specViolations: string[] = [];
  const minRam = mandate.hard_requirements.minimum_ram_gb;
  const minStorage = mandate.hard_requirements.minimum_storage_gb;
  for (const { product } of items) {
    if (product.category === 'laptop' || product.category === 'bundle') {
      if (minRam !== null && minRam !== undefined) {
        if (product.ram_gb === null || product.ram_gb < minRam) {
          specViolations.push(
            `${product.name} has ${product.ram_gb ?? 'unknown'} GB RAM, below hard minimum ${minRam} GB.`
          );
        }
      }
      if (minStorage !== null && minStorage !== undefined) {
        if (product.storage_gb === null || product.storage_gb < minStorage) {
          specViolations.push(
            `${product.name} has ${product.storage_gb ?? 'unknown'} GB storage, below hard minimum ${minStorage} GB.`
          );
        }
      }
    }
  }
  checks.push({
    rule: 'mandatory_specifications_check',
    severity: 'HARD',
    passed: specViolations.length === 0,
    outcomeIfFailed: 'BLOCK',
    detail:
      specViolations.length === 0
        ? 'All mandatory technical specifications satisfied.'
        : specViolations.join(' | '),
  });

  // Compute all eligible products from canonical catalog for reviewer & soft-pref checks
  const eligibleCatalog = catalog.filter((p) => productMatchesHardRules(p, mandate));
  const alternativeEligibleProducts: EligibleAlternativeSummary[] = eligibleCatalog.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price_cents: p.price_cents,
    price_formatted: formatCents(p.price_cents),
    ram_gb: p.ram_gb,
    storage_gb: p.storage_gb,
    condition: p.condition,
  }));

  // 10. Structured soft preference evaluation (e.g., prefer 16 GB RAM, fallback 8 GB if no suitable 16 GB model within budget)
  for (const pref of mandate.soft_requirements) {
    if (pref.attribute === 'ram_gb' && typeof pref.preferred_value === 'number') {
      const preferredRam = pref.preferred_value;
      const fallbackRam = typeof pref.fallback_value === 'number' ? pref.fallback_value : null;

      const laptopItems = items.filter(
        (i) => i.product.category === 'laptop' || i.product.category === 'bundle'
      );

      if (laptopItems.length > 0) {
        const meetsPreferred = laptopItems.every(
          (i) => i.product.ram_gb !== null && i.product.ram_gb >= preferredRam
        );

        if (meetsPreferred) {
          checks.push({
            rule: 'soft_preference_ram_gb',
            severity: 'SOFT',
            passed: true,
            outcomeIfFailed: 'REVIEW',
            detail: `Proposed laptop satisfies preferred ${preferredRam} GB RAM.`,
          });
        } else {
          // Check whether ANY eligible product in catalog satisfies preferredRam within mandate rules!
          const eligiblePreferredExists = eligibleCatalog.some(
            (p) =>
              (p.category === 'laptop' || p.category === 'bundle') &&
              p.ram_gb !== null &&
              p.ram_gb >= preferredRam
          );

          const proposedMeetsFallback =
            fallbackRam !== null &&
            laptopItems.every((i) => i.product.ram_gb !== null && i.product.ram_gb >= fallbackRam);

          if (eligiblePreferredExists) {
            const betterList = eligibleCatalog
              .filter(
                (p) =>
                  (p.category === 'laptop' || p.category === 'bundle') &&
                  p.ram_gb !== null &&
                  p.ram_gb >= preferredRam
              )
              .map((p) => `${p.name} ($${formatCents(p.price_cents)})`)
              .join(', ');

            checks.push({
              rule: 'soft_preference_ram_gb',
              severity: 'SOFT',
              passed: false,
              outcomeIfFailed: 'REVIEW',
              detail: `Proposed model has < ${preferredRam} GB RAM even though eligible ${preferredRam} GB model(s) exist within mandate budget: ${betterList}.`,
            });
          } else if (proposedMeetsFallback) {
            warnings.push(
              `No eligible ${preferredRam} GB RAM model exists within mandate constraints; fallback (${fallbackRam} GB RAM) allowed per fallback rule (${pref.fallback_condition ?? 'fallback satisfied'}).`
            );
            checks.push({
              rule: 'soft_preference_ram_gb',
              severity: 'SOFT',
              passed: true,
              outcomeIfFailed: 'REVIEW',
              detail: `Preferred ${preferredRam} GB unavailable within budget/constraints; fallback to >= ${fallbackRam} GB satisfied.`,
            });
          } else {
            checks.push({
              rule: 'soft_preference_ram_gb',
              severity: 'SOFT',
              passed: false,
              outcomeIfFailed: 'REVIEW',
              detail: `Proposed RAM fails preferred ${preferredRam} GB and does not satisfy fallback threshold.`,
            });
          }
        }
      }
    }
  }

  // 11. Ambiguous bundle check
  if (hasAmbiguousBundle) {
    checks.push({
      rule: 'ambiguous_bundle_review',
      severity: 'REVIEW_TRIGGER',
      passed: false,
      outcomeIfFailed: 'REVIEW',
      detail:
        'Proposal includes a composite product bundle containing bundled peripherals; requires explicit Tollgate human review.',
    });
  }

  // 12. Approval threshold check (approval_above)
  if (mandate.approval_above !== null && mandate.approval_above !== undefined) {
    const approvalThresholdCents = Math.round(mandate.approval_above * 100);
    const exceeded = totalCents > approvalThresholdCents;
    checks.push({
      rule: 'approval_above_threshold',
      severity: 'REVIEW_TRIGGER',
      passed: !exceeded,
      outcomeIfFailed: 'REVIEW',
      detail: exceeded
        ? `Total $${formatCents(totalCents)} exceeds human approval threshold $${formatCents(approvalThresholdCents)}.`
        : `Total $${formatCents(totalCents)} is within approval_above threshold $${formatCents(approvalThresholdCents)}.`,
    });
  }

  // 13. Truncated page evidence check (Section 9)
  if (options.evidenceMeta?.anyTruncated) {
    const truncatedRefs = options.evidenceMeta.truncatedPageIds ?? [];
    for (const ref of truncatedRefs) evidenceRefs.add(ref);
    checks.push({
      rule: 'page_evidence_truncation',
      severity: 'REVIEW_TRIGGER',
      passed: false,
      outcomeIfFailed: 'REVIEW',
      detail: `Page content was truncated at model limit (${truncatedRefs.length} page(s)); escalating to REVIEW instead of claiming a clean evaluation.`,
      evidenceRefs: truncatedRefs,
    });
  }

  const passedChecks = checks.filter((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);

  let decision: PolicyDecision = 'ALLOW';
  for (const failed of failedChecks) {
    if (failed.outcomeIfFailed === 'BLOCK') {
      decision = 'BLOCK';
      break;
    }
    if (failed.outcomeIfFailed === 'REVIEW') {
      decision = 'REVIEW';
    }
  }

  const reasons =
    failedChecks.length === 0
      ? ['All deterministic policy checks passed cleanly.']
      : failedChecks.map((f) => `[${f.rule}] ${f.detail}`);

  return {
    decision,
    passed_checks: passedChecks,
    failed_checks: failedChecks,
    warnings,
    evidence_references: Array.from(evidenceRefs),
    reasons,
    alternative_eligible_products: alternativeEligibleProducts,
  };
}

