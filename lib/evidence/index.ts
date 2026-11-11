import 'server-only';
import type Database from 'better-sqlite3';
import { newUuid, sha256Hex } from '@/lib/crypto';
import { appendLedgerEvent } from '@/lib/ledger';
import type { CatalogProduct } from '@/lib/policy/engine';

export const MAX_PAGE_EVIDENCE_CHARS = 4_000;
export const MAX_COMBINED_EVIDENCE_CHARS = 16_000;

export interface PageEvidenceRow {
  id: string;
  session_id: string;
  agent_run_id: string | null;
  proposal_id: string | null;
  product_id: string | null;
  storefront_path: string;
  raw_text: string;
  content_length: number;
  sha256_hash: string;
  truncated_for_model: number;
  model_excerpt_length: number;
  created_at: string;
}

export interface ProvenanceFieldTag {
  field: string;
  value_summary: string;
  sources: Array<'from_mandate' | 'from_tool_result' | 'from_page_text' | 'from_agent_inference'>;
  matched_evidence_ids: string[];
  notes: string;
}

export interface HeuristicProvenanceReport {
  disclaimer: string;
  fields: ProvenanceFieldTag[];
}

/**
 * Extracts safely represented plain text from simulated storefront HTML.
 * Converts hidden elements and HTML comments into explicit text blocks without executing scripts/HTML.
 */
export function extractSafePageText(rawHtml: string): string {
  let text = rawHtml;

  // Represent HTML comments explicitly as untrusted comment text
  text = text.replace(/<!--([\s\S]*?)-->/g, (_match, commentBody: string) => {
    const cleaned = commentBody.replace(/\s+/g, ' ').trim();
    return cleaned ? `\n[HTML_COMMENT]: ${cleaned}\n` : '';
  });

  // Explicitly mark hidden elements before stripping HTML tags
  text = text.replace(
    /<([a-z0-9]+)([^>]*?(?:display\s*:\s*none|visibility\s*:\s*hidden|\bhidden\b|\bsr-only\b|aria-hidden\s*=\s*["']true["']|data-hidden-injection|data-prompt-injection)[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_match, _tag: string, _attrs: string, inner: string) => {
      const cleaned = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return cleaned ? `\n[HIDDEN_ELEMENT_TEXT]: ${cleaned}\n` : '';
    }
  );

  // Strip remaining tags safely and decode basic HTML entities
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' [STRIPPED_SCRIPT_BLOCK] ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|article|section|ul|ol|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return text;
}

/**
 * Records complete raw page evidence and its SHA-256 fingerprint for a session.
 * Note: SHA-256 proves integrity of the stored text only, NOT origin or truthfulness.
 */
export function recordPageEvidence(
  db: Database.Database,
  options: {
    sessionId: string;
    agentRunId?: string | null;
    proposalId?: string | null;
    productId?: string | null;
    storefrontPath: string;
    rawText: string;
  }
): PageEvidenceRow {
  const id = newUuid();
  const contentLength = options.rawText.length;
  const sha256Hash = sha256Hex(options.rawText);
  const truncatedForModel = contentLength > MAX_PAGE_EVIDENCE_CHARS ? 1 : 0;
  const modelExcerptLength = Math.min(contentLength, MAX_PAGE_EVIDENCE_CHARS);
  const createdAt = new Date().toISOString();

  const row: PageEvidenceRow = {
    id,
    session_id: options.sessionId,
    agent_run_id: options.agentRunId ?? null,
    proposal_id: options.proposalId ?? null,
    product_id: options.productId ?? null,
    storefront_path: options.storefrontPath,
    raw_text: options.rawText,
    content_length: contentLength,
    sha256_hash: sha256Hash,
    truncated_for_model: truncatedForModel,
    model_excerpt_length: modelExcerptLength,
    created_at: createdAt,
  };

  db.prepare(
    `INSERT INTO page_evidence (
      id, session_id, agent_run_id, proposal_id, product_id,
      storefront_path, raw_text, content_length, sha256_hash,
      truncated_for_model, model_excerpt_length, created_at
    ) VALUES (
      @id, @session_id, @agent_run_id, @proposal_id, @product_id,
      @storefront_path, @raw_text, @content_length, @sha256_hash,
      @truncated_for_model, @model_excerpt_length, @created_at
    )`
  ).run(row);

  appendLedgerEvent(db, {
    sessionId: options.sessionId,
    proposalId: options.proposalId ?? null,
    eventType: 'PAGE_READ',
    actor: 'TOLLGATE',
    payload: {
      page_evidence_id: id,
      product_id: options.productId ?? null,
      storefront_path: options.storefrontPath,
      content_length: contentLength,
      sha256_hash: sha256Hash,
      truncated_for_model: Boolean(truncatedForModel),
    },
  });

  return row;
}

/**
 * Prepares bounded page excerpts for the AI reviewer, enforcing 4,000 chars/page and 16,000 chars total.
 * Reports whether any truncation occurred so policy/reviewer escalate to REVIEW.
 */
export function buildBoundedEvidenceForReview(pages: PageEvidenceRow[]): {
  excerpts: Array<{
    evidenceId: string;
    productId: string | null;
    storefrontPath: string;
    sha256Hash: string;
    fullLength: number;
    excerpt: string;
    truncated: boolean;
  }>;
  anyTruncated: boolean;
  truncatedPageIds: string[];
} {
  let remainingBudget = MAX_COMBINED_EVIDENCE_CHARS;
  const truncatedPageIds: string[] = [];
  const excerpts: Array<{
    evidenceId: string;
    productId: string | null;
    storefrontPath: string;
    sha256Hash: string;
    fullLength: number;
    excerpt: string;
    truncated: boolean;
  }> = [];

  for (const page of pages) {
    const allowedLen = Math.min(MAX_PAGE_EVIDENCE_CHARS, Math.max(0, remainingBudget));
    const truncated = page.raw_text.length > allowedLen;
    const excerpt = page.raw_text.slice(0, allowedLen);
    remainingBudget = Math.max(0, remainingBudget - excerpt.length);

    if (truncated) {
      truncatedPageIds.push(page.id);
    }

    excerpts.push({
      evidenceId: page.id,
      productId: page.product_id,
      storefrontPath: page.storefront_path,
      sha256Hash: page.sha256_hash,
      fullLength: page.content_length,
      excerpt,
      truncated,
    });
  }

  return {
    excerpts,
    anyTruncated: truncatedPageIds.length > 0,
    truncatedPageIds,
  };
}

/**
 * Heuristic provenance tagging over proposal fields.
 * Explicitly does not claim causal proof of LLM decision-making.
 */
export function buildHeuristicProvenance(options: {
  originalInstruction: string;
  proposedItems: Array<{ product: CatalogProduct; quantity: number }>;
  agentReasoning: string;
  pages: PageEvidenceRow[];
}): HeuristicProvenanceReport {
  const fields: ProvenanceFieldTag[] = [];
  const instrLower = options.originalInstruction.toLowerCase();
  const reasoningLower = options.agentReasoning.toLowerCase();

  // 1. Selected product IDs & categories
  const matchedPageIdsForProducts = options.pages
    .filter((p) => options.proposedItems.some((item) => item.product.id === p.product_id))
    .map((p) => p.id);

  const productSources: ProvenanceFieldTag['sources'] = ['from_tool_result'];
  if (matchedPageIdsForProducts.length > 0) productSources.push('from_page_text');
  if (
    options.proposedItems.some((item) =>
      instrLower.includes(item.product.category.toLowerCase()) ||
      instrLower.includes(item.product.brand.toLowerCase())
    )
  ) {
    productSources.push('from_mandate');
  }

  fields.push({
    field: 'proposed_products',
    value_summary: options.proposedItems
      .map((i) => `${i.product.id} (${i.product.sku}) x${i.quantity}`)
      .join(', '),
    sources: productSources,
    matched_evidence_ids: matchedPageIdsForProducts,
    notes: 'Product identities resolved canonically by Tollgate from catalog using agent-supplied IDs.',
  });

  // 2. Prices & Totals (always from Tollgate catalog / tool result, never from page text or agent)
  fields.push({
    field: 'prices_and_total',
    value_summary: options.proposedItems
      .map((i) => `${i.product.sku}: $${(i.product.price_cents / 100).toFixed(2)}`)
      .join(', '),
    sources: ['from_tool_result'],
    matched_evidence_ids: [],
    notes: 'Tollgate computes unit prices and totals strictly from its canonical product catalog.',
  });

  // 3. Agent reasoning overlap heuristics against untrusted page text (e.g. hidden claims / warranty / reciprocity)
  const hiddenPhrases = [
    'extended warranty',
    '3-year',
    'complimentary',
    'reciprocity',
    'pre-approved',
    'gift card',
    'promotional batch',
  ];

  const reasoningPageMatches = options.pages
    .filter((page) => {
      const pageLower = page.raw_text.toLowerCase();
      return hiddenPhrases.some(
        (phrase) => reasoningLower.includes(phrase) && pageLower.includes(phrase)
      );
    })
    .map((p) => p.id);

  const reasoningSources: ProvenanceFieldTag['sources'] = ['from_agent_inference'];
  if (reasoningPageMatches.length > 0) {
    reasoningSources.push('from_page_text');
  }
  if (instrLower.includes('laptop') && reasoningLower.includes('laptop')) {
    reasoningSources.push('from_mandate');
  }

  fields.push({
    field: 'agent_reasoning',
    value_summary: options.agentReasoning.slice(0, 200),
    sources: reasoningSources,
    matched_evidence_ids: reasoningPageMatches,
    notes:
      reasoningPageMatches.length > 0
        ? 'Agent reasoning shares phrases observed inside untrusted webpage text (heuristic overlap).'
        : 'Agent reasoning synthesized from mandate and catalog tool results.',
  });

  return {
    disclaimer:
      'Heuristic provenance tagging identifies observable textual/data overlap across mandate, tool outputs, untrusted page text, and agent rationale. It does not establish causal proof of which tokens caused an LLM choice.',
    fields,
  };
}

