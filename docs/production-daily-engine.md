# Production Daily Engine

```text
Railway Cron → due/skip check → distributed lock → resume checkpoint
→ bounded Yahoo batches → incremental upsert → failure queue/retry
→ market validation → run ledger + daily summary → exit 0
```

All markets use `config/production-yahoo-daily-jobs.json`; historical backfill is not invoked by this engine.

The ledger is `production_scheduler_runs`; the durable checkpoint is `production_scheduler_checkpoints`; failures use `production_scheduler_failures`; locks use `production_scheduler_locks`.
