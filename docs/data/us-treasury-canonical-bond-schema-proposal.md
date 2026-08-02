# Canonical Individual Bond Schema Proposal — no migration executed

The current production schema safely stores the U.S. Treasury identity in `securities`, but it has no existing JSON/metadata field or normalized event tables that can carry bond terms, auctions, lifecycle events, source documents and point-in-time observations without data loss. Until the project owner approves a migration, `securities` remains the canonical identity row and the Railway volume archive remains the rebuildable source of truth for the missing layers.

No Prisma Schema or database structure is changed by this proposal.

## 1. `bond_details`

- Columns: `id uuid`, `security_id text`, `source_namespace text`, `official_security_id text`, `issuer text`, `country char(2)`, `currency char(3)`, `bond_type text`, `security_term text`, `issue_date date`, `maturity_date date`, `coupon_rate numeric`, `coupon_type text`, `payment_frequency smallint`, `face_value numeric`, `current_outstanding_amount numeric`, `frn_reference_rate numeric`, `frn_reference_rate_date date`, `frn_spread numeric`, `valid_from timestamptz`, `valid_to timestamptz`, `observed_at timestamptz`, `source_document_id text`, `raw_payload_hash char(64)`, `parser_version text`, `created_at timestamptz`.
- Primary key: `id`.
- Unique key: `(source_namespace, official_security_id, valid_from)`.
- Foreign key: `security_id -> securities.id`.
- Indexes: current row `(security_id) WHERE valid_to IS NULL`; maturity `(maturity_date)`; source identity `(source_namespace, official_security_id)`.
- Point in time: immutable validity interval; corrections close the prior row and insert a new row.
- Idempotency: the source identity, validity start and payload hash must not create duplicates.
- Expected V1 volume: 465 current rows plus amended versions; under 10,000 rows for the first decade.
- Retention: permanent.

## 2. `bond_auctions`

- Columns: `id uuid`, `security_id text`, `source_namespace text`, `source_event_id text`, `announcement_date date`, `auction_date date`, `issue_date date`, `maturity_date date`, `reopening boolean`, `offering_amount numeric`, `accepted_amount numeric`, `auction_price numeric`, `auction_yield numeric`, `interest_rate numeric`, `high_discount_rate numeric`, `high_investment_rate numeric`, `frn_reference_rate numeric`, `frn_discount_margin numeric`, `source_updated_at timestamptz`, `observed_at timestamptz`, `source_document_id text`, `raw_payload_hash char(64)`, `parser_version text`.
- Primary key: `id`.
- Unique key: `(source_namespace, source_event_id, source_updated_at)`; current-source view selects the latest version.
- Foreign key: `security_id -> securities.id`.
- Indexes: `(security_id, auction_date desc)`, `(auction_date)`, `(source_document_id)`.
- Point in time and amendments: every changed source version is retained; `source_event_id` groups superseded versions.
- Expected V1 volume: 881 initial events; low thousands per year.
- Retention: permanent.

## 3. `bond_lifecycle_events`

- Columns: `id uuid`, `security_id text`, `source_namespace text`, `source_event_id text`, `event_type text`, `effective_date date`, `announced_at timestamptz`, `observed_at timestamptz`, `metadata jsonb`, `source_document_id text`, `raw_payload_hash char(64)`, `parser_version text`.
- Primary key: `id`.
- Unique key: `(source_namespace, source_event_id, event_type, effective_date)`.
- Foreign key: `security_id -> securities.id`.
- Indexes: `(security_id, effective_date desc)`, `(event_type, effective_date)`.
- Expected V1 volume: 2,167 initial events.
- Retention: permanent.

## 4. `bond_market_observations`

- Columns: `id uuid`, `security_id text`, `source_namespace text`, `observation_type text`, `observation_date date`, `published_at timestamptz`, `price numeric`, `bid numeric`, `ask numeric`, `yield numeric`, `price_type text`, `volume numeric`, `currency char(3)`, `is_actual_transaction boolean`, `quality_status text`, `source_document_id text`, `raw_payload_hash char(64)`, `parser_version text`, `created_at timestamptz`.
- Primary key: `id`.
- Unique key: `(security_id, source_namespace, observation_type, observation_date, published_at, raw_payload_hash)`.
- Foreign key: `security_id -> securities.id`.
- Indexes: `(security_id, observation_date desc)`, `(source_namespace, observation_date)`, latest partial index by observation type.
- Point in time: publication timestamp distinguishes later corrections and prevents look-ahead.
- Expected volume: source-dependent; auction observations are low volume, licensed daily/transaction data can be millions of rows.
- Retention: permanent for daily official records; licensed transaction retention follows contract.

## 5. `bond_source_documents`

- Columns: `id uuid`, `source_namespace text`, `source_document_id text`, `logical_path text`, `object_path text`, `content_hash char(64)`, `byte_length bigint`, `content_type text`, `fetched_at timestamptz`, `source_updated_at timestamptz`, `parser_version text`, `previous_content_hash char(64)`, `manifest_run_id text`, `created_at timestamptz`.
- Primary key: `id`.
- Unique keys: `(source_namespace, source_document_id, content_hash)` and `(object_path)`.
- Indexes: `(source_namespace, fetched_at desc)`, `(content_hash)`, `(manifest_run_id)`.
- Lineage: connects every canonical row to immutable content-addressed bytes and its superseded predecessor.
- Expected V1 volume: fewer than 100 source-page versions per month plus manifests.
- Retention: permanent.

## 6. `bond_data_quality_failures`

- Columns: `id uuid`, `job_id text`, `security_id text`, `source_namespace text`, `official_security_id text`, `stage text`, `classification text`, `error_code text`, `error_message text`, `attempts integer`, `first_failed_at timestamptz`, `last_attempted_at timestamptz`, `next_retry_at timestamptz`, `resolved boolean`, `resolved_at timestamptz`, `resolution_reason text`, `run_id text`, `checkpoint text`, `details jsonb`.
- Primary key: `id`.
- Unique key: `(job_id, source_namespace, official_security_id, stage)` for the active failure identity.
- Foreign keys: optional `security_id -> securities.id`; run linkage should target the production run ledger if a stable FK is approved.
- Indexes: unresolved retry `(job_id, resolved, next_retry_at)`, identity `(source_namespace, official_security_id)`, run `(run_id)`.
- Idempotency: retry updates the active row; resolution is retained instead of deleting history.
- Expected volume: sparse; capacity should assume up to one row per instrument and stage per run.
- Retention: permanent for audit; resolved payload details may be compacted after the owner-defined retention window.
