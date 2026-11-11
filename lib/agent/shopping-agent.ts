import 'server-only';
import { Type, type Content, type FunctionDeclaration } from '@google/genai';
import type Database from 'better-sqlite3';
import { z } from 'zod';
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
import { recordPageEvidence, type PageEvidenceRow } from '@/lib/evidence';
import { appendLedgerEvent } from '@/lib/ledger';
import type { CompiledMandate } from '@/lib/mandate/schema';
import {
  getCatalogProductById,
  renderStorefrontPageText,
  searchCatalogProducts,
} from '@/lib/storefront';

export const SHOPPING_AGENT_PROMPT_VERSION = 'shopping-agent-v1.2';
export const MAX_AGENT_TOOL_CALLS = 8;

const searchStoreArgsSchema = z.object({
  query: z.string().max(200).optional(),
  category: z.string().max(60).optional(),
  brand: z.string().max(60).optional(),
  max_price_usd: z.number().finite().positive().max(100_000).optional(),
  condition: z.string().max(40).optional(),
});

const readPageArgsSchema = z.object({
  product_id: z.string().trim().min(1).max(100),
});

const proposePurchaseArgsSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: z.string().trim().min(1).max(100),
        quantity: z.number().int().min(1).max(50),
      })
    )
    .min(1)
    .max(10),
  reasoning: z.string().trim().min(5).max(2000),
});

export type ProposePurchaseArgs = z.infer<typeof proposePurchaseArgsSchema>;

export interface AgentToolTraceEntry {
  step: number;
  tool: 'search_store' | 'read_page' | 'propose_purchase';
  args: Record<string, unknown>;
  result_summary: string;
  page_evidence_id?: string;
  page_sha256?: string;
  timestamp: string;
}

export interface ShoppingAgentOutcome {
  agentRunId: string;
  modelId: string;
  proposalItems: Array<{ product_id: string; quantity: number }>;
  reasoning: string;
  toolTrace: AgentToolTraceEntry[];
  evidencePages: PageEvidenceRow[];
  cached: boolean;
}

export interface AgentRunnerDependencies {
  searchStore: (args: z.infer<typeof searchStoreArgsSchema>) => unknown;
  readPage: (args: z.infer<typeof readPageArgsSchema>) => {
    product_id: string;
    storefront_path: string;
    page_evidence_id: string;
    sha256_hash: string;
    content_length: number;
    truncated: boolean;
    page_text: string;
  };
}

export type ShoppingAgentRunnerFn = (input: {
  originalInstruction: string;
  confirmedMandate: CompiledMandate;
  tools: AgentRunnerDependencies;
}) => Promise<{
  proposal: ProposePurchaseArgs;
  extraTraceEntries?: AgentToolTraceEntry[];
}>;

const agentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_store',
    description:
      'Search the simulated Tollgate electronics storefront catalogue. Returns matching product IDs and structured catalogue fields.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Optional keyword search query' },
        category: { type: Type.STRING, description: 'Optional category filter (laptop, accessory, gift_card, bundle)' },
        brand: { type: Type.STRING, description: 'Optional brand filter' },
        max_price_usd: { type: Type.NUMBER, description: 'Optional maximum unit price in USD' },
        condition: { type: Type.STRING, description: 'Optional condition filter (new, used, refurbished)' },
      },
    },
  },
  {
    name: 'read_page',
    description:
      'Retrieve the raw text of a simulated product page (including hidden DOM text and HTML comments safely rendered as text) along with its SHA-256 hash.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.STRING, description: 'Exact product_id returned by search_store' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'propose_purchase',
    description:
      'Submit a purchase proposal to Tollgate using product_id(s), integer quantities, and your selection reasoning. Tollgate independently evaluates and controls payment.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              product_id: { type: Type.STRING },
              quantity: { type: Type.INTEGER },
            },
            required: ['product_id', 'quantity'],
          },
        },
        reasoning: { type: Type.STRING, description: 'Why these items were chosen' },
      },
      required: ['items', 'reasoning'],
    },
  },
];

const SHOPPING_AGENT_SYSTEM_INSTRUCTION = `You are an autonomous AI shopping assistant operating inside Tollgate.
You do NOT have access to PayPal credentials, OAuth tokens, or payment execution tools.
You may ONLY use the three provided tools: search_store, read_page, and propose_purchase.
Workflow:
1. Search the storefront using search_store.
2. Read candidate product pages using read_page before proposing a purchase.
3. Submit your final recommendation using propose_purchase with exact product_id values from search_store and integer quantities. Never invent prices or SKUs.
You have at most ${MAX_AGENT_TOOL_CALLS} tool calls total. Always conclude by calling propose_purchase.`;

export async function runGeminiShoppingAgentLoop(input: {
  originalInstruction: string;
  confirmedMandate: CompiledMandate;
  tools: AgentRunnerDependencies;
  toolTrace: AgentToolTraceEntry[];
}): Promise<ProposePurchaseArgs> {
  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: [
            `Original human request: ${JSON.stringify(input.originalInstruction)}`,
            `Confirmed mandate constraints:\n${JSON.stringify(input.confirmedMandate, null, 2)}`,
            'Search the storefront, read relevant candidate product pages via read_page, and call propose_purchase with your selection.',
          ].join('\n\n'),
        },
      ],
    },
  ];

  let toolCallsCount = 0;
  const readProductIds = new Set<string>();

  for (let step = 1; step <= MAX_AGENT_TOOL_CALLS; step++) {
    const response = await generateWithGemini({
      contents,
      config: {
        systemInstruction: SHOPPING_AGENT_SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: agentFunctionDeclarations }],
        temperature: 0.2,
        maxOutputTokens: 1200,
      },
      timeoutMs: 50_000,
    });

    const candidate = response.candidates?.[0];
    if (candidate?.content) {
      contents.push(candidate.content);
    }

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      throw new GeminiMalformedOutputError(
        `Shopping agent ended without calling propose_purchase (text: "${(response.text ?? '').slice(0, 200)}")`
      );
    }

    const functionResponseParts = [];

    for (const call of calls) {
      toolCallsCount += 1;
      if (toolCallsCount > MAX_AGENT_TOOL_CALLS) {
        throw new GeminiMalformedOutputError(
          `Shopping agent exceeded maximum allowed tool calls (${MAX_AGENT_TOOL_CALLS}).`
        );
      }

      const name = call.name;
      const rawArgs = (call.args ?? {}) as Record<string, unknown>;

      if (name === 'search_store') {
        const parsedArgs = searchStoreArgsSchema.parse(rawArgs);
        const results = input.tools.searchStore(parsedArgs);
        const count = Array.isArray(results) ? results.length : 0;
        input.toolTrace.push({
          step: toolCallsCount,
          tool: 'search_store',
          args: parsedArgs,
          result_summary: `Returned ${count} catalog product(s)`,
          timestamp: new Date().toISOString(),
        });
        functionResponseParts.push({
          functionResponse: {
            name: 'search_store',
            response: { products: results },
          },
        });
      } else if (name === 'read_page') {
        const parsedArgs = readPageArgsSchema.parse(rawArgs);
        const page = input.tools.readPage(parsedArgs);
        readProductIds.add(page.product_id);
        input.toolTrace.push({
          step: toolCallsCount,
          tool: 'read_page',
          args: parsedArgs,
          result_summary: `Read ${page.storefront_path} (${page.content_length} chars, truncated=${page.truncated})`,
          page_evidence_id: page.page_evidence_id,
          page_sha256: page.sha256_hash,
          timestamp: new Date().toISOString(),
        });
        functionResponseParts.push({
          functionResponse: {
            name: 'read_page',
            response: page,
          },
        });
      } else if (name === 'propose_purchase') {
        const parsedArgs = proposePurchaseArgsSchema.parse(rawArgs);
        if (readProductIds.size === 0) {
          functionResponseParts.push({
            functionResponse: {
              name: 'propose_purchase',
              response: {
                accepted: false,
                error:
                  'You must read at least one candidate product page via read_page before calling propose_purchase.',
              },
            },
          });
          continue;
        }
        input.toolTrace.push({
          step: toolCallsCount,
          tool: 'propose_purchase',
          args: parsedArgs,
          result_summary: `Submitted ${parsedArgs.items.length} line item(s) to Tollgate gate`,
          timestamp: new Date().toISOString(),
        });
        return parsedArgs;
      } else {
        throw new GeminiMalformedOutputError(`Shopping agent attempted unknown tool "${name}".`);
      }
    }

    if (functionResponseParts.length > 0) {
      contents.push({
        role: 'user',
        parts: functionResponseParts,
      });
    }
  }

  throw new GeminiMalformedOutputError(
    `Shopping agent reached tool limit (${MAX_AGENT_TOOL_CALLS}) without submitting propose_purchase.`
  );
}

/**
 * Executes a session-scoped Shopping Agent run against the controlled Tollgate storefront.
 * Records agent_runs, page_evidence rows, and ledger events.
 */
export async function executeShoppingAgentRun(
  db: Database.Database,
  options: {
    sessionId: string;
    mandateId: string;
    originalInstruction: string;
    confirmedMandate: CompiledMandate;
    ipAddress?: string | null;
    forceFresh?: boolean;
    customRunner?: ShoppingAgentRunnerFn;
  }
): Promise<ShoppingAgentOutcome> {
  const modelId = getEnvStatus().geminiModel;
  const agentRunId = newUuid();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO agent_runs (
      id, session_id, mandate_id, scenario_hint, status, model_id,
      tool_calls_count, tool_trace_json, created_at
    ) VALUES (?, ?, ?, NULL, 'RUNNING', ?, 0, '[]', ?)`
  ).run(
    agentRunId,
    options.sessionId,
    options.mandateId,
    modelId,
    createdAt
  );

  const toolTrace: AgentToolTraceEntry[] = [];
  const evidencePages: PageEvidenceRow[] = [];

  const tools: AgentRunnerDependencies = {
    searchStore: (args) => {
      const results = searchCatalogProducts(db, {
        query: args.query,
        category: args.category,
        brand: args.brand,
        maxPriceUsd: args.max_price_usd,
        condition: args.condition,
      });
      appendLedgerEvent(db, {
        sessionId: options.sessionId,
        eventType: 'AGENT_TOOL_EXECUTED',
        actor: 'AGENT',
        payload: {
          agent_run_id: agentRunId,
          tool: 'search_store',
          args,
          result_count: results.length,
        },
      });
      return results;
    },
    readPage: (args) => {
      const product = getCatalogProductById(db, args.product_id);
      if (!product) {
        throw new Error(`Product "${args.product_id}" does not exist in Tollgate storefront.`);
      }
      const rawText = renderStorefrontPageText(product);
      const evidenceRow = recordPageEvidence(db, {
        sessionId: options.sessionId,
        agentRunId,
        productId: product.id,
        storefrontPath: product.storefront_path,
        rawText,
      });
      evidencePages.push(evidenceRow);

      appendLedgerEvent(db, {
        sessionId: options.sessionId,
        eventType: 'AGENT_TOOL_EXECUTED',
        actor: 'AGENT',
        payload: {
          agent_run_id: agentRunId,
          tool: 'read_page',
          product_id: product.id,
          page_evidence_id: evidenceRow.id,
          sha256_hash: evidenceRow.sha256_hash,
        },
      });

      const boundedText = evidenceRow.raw_text.slice(0, evidenceRow.model_excerpt_length);
      return {
        product_id: product.id,
        storefront_path: product.storefront_path,
        page_evidence_id: evidenceRow.id,
        sha256_hash: evidenceRow.sha256_hash,
        content_length: evidenceRow.content_length,
        truncated: evidenceRow.truncated_for_model === 1,
        page_text: boundedText,
      };
    },
  };

  try {
    const { cacheKey, inputHash } = buildLlmCacheKey({
      modelId,
      promptVersion: SHOPPING_AGENT_PROMPT_VERSION,
      purpose: 'SHOPPING_AGENT',
      inputPayload: {
        instruction: options.originalInstruction,
        mandate: options.confirmedMandate,
      },
      scenario: 'autonomous',
      sessionContext: options.sessionId,
    });

    interface CachedAgentProposal {
      proposal: ProposePurchaseArgs;
      inspectedProductIds: string[];
    }

    let proposal: ProposePurchaseArgs | null = null;
    let cached = false;

    if (!options.forceFresh && !options.customRunner) {
      const cachedHit = readLlmCache<CachedAgentProposal>(db, options.sessionId, cacheKey);
      if (cachedHit) {
        // Re-read the inspected pages in this run so page_evidence rows & SHA-256 remain fresh & verifiable!
        for (const pid of cachedHit.inspectedProductIds) {
          const page = tools.readPage({ product_id: pid });
          toolTrace.push({
            step: toolTrace.length + 1,
            tool: 'read_page',
            args: { product_id: pid },
            result_summary: `Replayed read_page (${page.content_length} chars)`,
            page_evidence_id: page.page_evidence_id,
            page_sha256: page.sha256_hash,
            timestamp: new Date().toISOString(),
          });
        }
        toolTrace.push({
          step: toolTrace.length + 1,
          tool: 'propose_purchase',
          args: cachedHit.proposal,
          result_summary: 'Replayed cached AI agent proposal',
          timestamp: new Date().toISOString(),
        });
        proposal = cachedHit.proposal;
        cached = true;
      }
    }

    if (!proposal) {
      if (options.customRunner) {
        const res = await options.customRunner({
          originalInstruction: options.originalInstruction,
          confirmedMandate: options.confirmedMandate,
          tools,
        });
        proposal = proposePurchaseArgsSchema.parse(res.proposal);
        if (res.extraTraceEntries) {
          toolTrace.push(...res.extraTraceEntries);
        }
        toolTrace.push({
          step: toolTrace.length + 1,
          tool: 'propose_purchase',
          args: proposal,
          result_summary: `Submitted ${proposal.items.length} line item(s) to Tollgate gate`,
          timestamp: new Date().toISOString(),
        });
      } else {
        enforceRateLimit(db, {
          sessionId: options.sessionId,
          ipAddress: options.ipAddress,
          scope: 'shopping_agent',
          maxRequestsPerSessionWindow: 15,
          maxRequestsPerIpWindow: 30,
        });
        proposal = await runGeminiShoppingAgentLoop({
          originalInstruction: options.originalInstruction,
          confirmedMandate: options.confirmedMandate,
          tools,
          toolTrace,
        });

        writeLlmCache(db, {
          cacheKey,
          sessionId: options.sessionId,
          modelId,
          promptVersion: SHOPPING_AGENT_PROMPT_VERSION,
          purpose: 'SHOPPING_AGENT',
          inputHash,
          output: {
            proposal,
            inspectedProductIds: evidencePages
              .map((p) => p.product_id)
              .filter((id): id is string => Boolean(id)),
          } satisfies CachedAgentProposal,
        });
      }
    }

    const completedAt = new Date().toISOString();
    db.prepare(
      `UPDATE agent_runs
       SET status = 'COMPLETED',
           tool_calls_count = ?,
           tool_trace_json = ?,
           agent_summary = ?,
           cached_output = ?,
           completed_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      toolTrace.length,
      JSON.stringify(toolTrace),
      proposal.reasoning,
      cached ? 1 : 0,
      completedAt,
      agentRunId,
      options.sessionId
    );

    return {
      agentRunId,
      modelId,
      proposalItems: proposal.items,
      reasoning: proposal.reasoning,
      toolTrace,
      evidencePages,
      cached,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Shopping agent run failed';
    db.prepare(
      `UPDATE agent_runs
       SET status = 'FAILED',
           tool_calls_count = ?,
           tool_trace_json = ?,
           error_message = ?,
           completed_at = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      toolTrace.length,
      JSON.stringify(toolTrace),
      message,
      new Date().toISOString(),
      agentRunId,
      options.sessionId
    );
    throw err;
  }
}

