# SmartFund Data Worker Ownership

This document is the fail-closed ownership contract for production data workers.
The same market and job may have only one active owner at any time. A worker must
not start while its scoped lifecycle lock, heartbeat, or RUNNING/IN_PROGRESS run
is active under another owner.

## Railway

- Owns Daily jobs.
- Owns Incremental jobs.
- Owns Retry jobs.
- Owns Scheduler coordination.
- Must not execute NYSE Financial Historical.

## Main computer

- Owns Master coordination and non-stock assignments delegated by the Owner.
- Must not concurrently execute a market/layer owned by Worker-02 while its lock is active.

## Second desktop computer

- Owns bounded Global Stock Historical / Completion work for TWSE, TPEx, NASDAQ,
  NYSE, AMEX, Japan, Korea, Hong Kong, Shanghai, Shenzhen, Singapore, Canada,
  Australia, United Kingdom, Germany, France, Netherlands, Spain, Italy,
  Switzerland, and Sweden.
- Must use a market-scoped job ID, lock, universe, checkpoint, failure queue, and
  database predicate for every write-capable pipeline.
- Must not execute Bond, ETF, Fund, FX, Crypto, Economic, Daily, Incremental,
  Retry, Scheduler, Schema, or Migration work.

## Global Stock bounded historical scope

- Markets must be explicit; `GLOBAL`, `ALL`, and `US` are prohibited.
- Job ID and lock key must include the exact market and layer.
- Run type: `OFFICIAL_FINANCIAL_HISTORICAL`
- Required market argument: `--market=<EXACT_MARKET>`
- The runner must resolve its universe from active `stocks` rows whose `exchange`
  is exactly the requested market before it acquires a lifecycle lock or creates a run.
- Checkpoints, failures, locks, and runs are scoped by the market-specific job ID.
- Financial facts are scoped through `stock_financial_facts.stock_id` to `stocks.id`;
  cleanup and validation must additionally require the exact requested exchange.
- The same market and layer may have only one active writer. Railway Incremental
  ownership always blocks the conflicting Historical layer until its lock expires.

## Required preflight

Run the read-only dry-run and confirm `DRY_RUN_READY`, no active lock, no active
heartbeat, and no RUNNING/IN_PROGRESS lifecycle before starting the formal worker:

```powershell
node --experimental-strip-types --env-file=.env scripts/data/financial/run-production-sec-financial.ts --market=<EXACT_MARKET> --max-symbols=25 --dry-run
```

The formal command is:

```powershell
node --experimental-strip-types --env-file=.env scripts/data/financial/run-production-sec-financial.ts --market=<EXACT_MARKET> --max-symbols=25
```

To stop an interactive run, use `Ctrl+C`. Do not immediately start another owner.
Wait for the market-scoped lock and heartbeat to clear, run the dry-run until it reports
`DRY_RUN_READY`, then use the same formal command; the runner resumes from the
market-scoped durable checkpoint.
