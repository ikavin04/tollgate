import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_tollgate_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent_hash TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
      );

      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        original_instruction TEXT NOT NULL,
        compiled_mandate_json TEXT NOT NULL,
        status TEXT NOT NULL,
        compiler_model TEXT NOT NULL,
        compiler_cached INTEGER NOT NULL DEFAULT 0,
        clarification_answers_json TEXT,
        confirmed_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mandates_session_id
        ON mandates(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        category TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        condition TEXT NOT NULL,
        ram_gb INTEGER,
        storage_gb INTEGER,
        weight_kg REAL,
        warranty_summary TEXT NOT NULL,
        extended_warranty_included INTEGER NOT NULL DEFAULT 0,
        specifications_json TEXT NOT NULL,
        storefront_path TEXT NOT NULL,
        raw_html_template TEXT NOT NULL,
        is_malicious_scenario INTEGER NOT NULL DEFAULT 0,
        scenario_tag TEXT,
        in_stock INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
        scenario_hint TEXT,
        status TEXT NOT NULL,
        model_id TEXT NOT NULL,
        tool_calls_count INTEGER NOT NULL DEFAULT 0,
        tool_trace_json TEXT NOT NULL DEFAULT '[]',
        agent_summary TEXT,
        cached_output INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id
        ON agent_runs(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        agent_reasoning TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        currency TEXT NOT NULL DEFAULT 'USD',
        total_amount_cents INTEGER NOT NULL,
        items_payload_hash TEXT NOT NULL,
        deterministic_decision TEXT,
        deterministic_result_json TEXT,
        ai_reviewer_decision TEXT,
        ai_reviewer_result_json TEXT,
        ai_reviewer_cached INTEGER NOT NULL DEFAULT 0,
        final_decision TEXT,
        human_decision TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
        human_decision_reason TEXT,
        human_decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_session_id
        ON proposals(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_proposals_mandate_id
        ON proposals(mandate_id);

      CREATE TABLE IF NOT EXISTS proposal_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id),
        sku TEXT NOT NULL,
        product_name TEXT NOT NULL,
        category TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        line_total_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        canonical_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_items_proposal_id
        ON proposal_items(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_proposal_items_session_id
        ON proposal_items(session_id);

      CREATE TABLE IF NOT EXISTS page_evidence (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        storefront_path TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        content_length INTEGER NOT NULL,
        sha256_hash TEXT NOT NULL,
        truncated_for_model INTEGER NOT NULL DEFAULT 0,
        model_excerpt_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_page_evidence_session_proposal
        ON page_evidence(session_id, proposal_id);
      CREATE INDEX IF NOT EXISTS idx_page_evidence_agent_run
        ON page_evidence(agent_run_id);

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL UNIQUE,
        custom_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        expected_amount_cents INTEGER NOT NULL,
        items_payload_hash TEXT NOT NULL,
        paypal_order_id TEXT UNIQUE,
        paypal_order_status TEXT,
        paypal_intent TEXT,
        payer_action_url TEXT,
        paypal_authorization_id TEXT UNIQUE,
        paypal_authorization_status TEXT,
        paypal_capture_id TEXT UNIQUE,
        paypal_capture_status TEXT,
        paypal_void_status TEXT,
        verification_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
        verification_notes_json TEXT,
        last_paypal_snapshot_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payments_session_id
        ON payments(session_id);
      CREATE INDEX IF NOT EXISTS idx_payments_order_id
        ON payments(paypal_order_id);

      CREATE TABLE IF NOT EXISTS payment_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        payment_id TEXT REFERENCES payments(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        logical_operation_key TEXT NOT NULL,
        paypal_request_id TEXT NOT NULL UNIQUE,
        request_payload_hash TEXT NOT NULL,
        operation_status TEXT NOT NULL,
        http_status INTEGER,
        paypal_resource_id TEXT,
        paypal_response_json TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, logical_operation_key)
      );

      CREATE INDEX IF NOT EXISTS idx_payment_ops_session_proposal
        ON payment_operations(session_id, proposal_id);

      CREATE TABLE IF NOT EXISTS transaction_events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        canonical_event_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_tx_events_session_seq
        ON transaction_events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tx_events_session_proposal
        ON transaction_events(session_id, proposal_id);

      CREATE TABLE IF NOT EXISTS ledger_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        head_seq INTEGER NOT NULL,
        head_hash TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        checkpoint_note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_session
        ON ledger_checkpoints(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS llm_output_cache (
        cache_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        purpose TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_llm_cache_session
        ON llm_output_cache(session_id, expires_at);

      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_reset_at TEXT NOT NULL
      );
    `,
  },
];

export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const runTx = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    });
    runTx();
  }
}

