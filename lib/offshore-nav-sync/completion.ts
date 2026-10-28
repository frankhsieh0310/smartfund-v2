// Day-scoped "already attempted today" tracking, stored in the SAME existing
// production_scheduler_checkpoints table under its own key (never a new table) -- mirrors
// etf-returns-sync's lastProcessedDate pattern: each fund gets exactly one attempt per calendar day,
// spread across the day's several scheduled ticks, DB-truth-driven (a fund whose funds.latest_nav_date
// is already today's target is naturally a no-op write anyway; this tracking only avoids re-hitting
// Yahoo for a fund already attempted today within this same run-day, success or not).
export const PROGRESS_CHECKPOINT_KEY = "offshore-nav-sync:daily-progress";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type DailyProgress = { date: string; attemptedFundIds: string[] };

export async function loadDailyProgress(query: QueryFn, today: string): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: DailyProgress = JSON.parse(raw);
    if (parsed.date !== today) return new Set(); // new day, start fresh
    return new Set(parsed.attemptedFundIds ?? []);
  } catch {
    return new Set();
  }
}

export async function saveDailyProgress(query: QueryFn, today: string, attemptedFundIds: Set<string>): Promise<void> {
  const payload: DailyProgress = { date: today, attemptedFundIds: [...attemptedFundIds] };
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_NAV_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [PROGRESS_CHECKPOINT_KEY, JSON.stringify(payload), attemptedFundIds.size],
  );
}

// 「39檔境外淨值落後」根因（2026-10-28 VERIFIED，唯讀重跑discoverNewMappings證實）: discovery階段
// (discoverMapping.ts) 每次呼叫都用SAME candidates清單（ORDER BY f.created_at DESC，沒有分頁／
// 游標狀態），每輪固定只有45秒時間預算——結果每個15分鐘的tick永遠只處理清單最前面那~35-40檔
// （最新建立的那幾檔），清單後面（較早建立）的未對應基金永遠排不到，不是「當天額度用完明天繼續」
// 那種正常進度，是結構性卡死，天天都是同一批。唯讀重跑用120秒預算多處理一輪，當場多解出12檔
// 原本都卡住、其實Yahoo查得到的對應——證實不是Yahoo沒有資料，是候選清單從來沒排到它們。
// 修法：比照NAV-fetch階段既有的daily-progress機制，discovery也用同一張checkpoint表另開一個
// key，記錄「今天已經嘗試過的fundId」，每輪從候選清單裡先濾掉，讓每個15分鐘tick都往清單後面
// 推進，而不是每次重新從最前面開始——這樣一天多輪tick下來才會真的把候選清單處理完，不會永遠
// 卡在同一批。
export const DISCOVERY_PROGRESS_CHECKPOINT_KEY = "offshore-nav-sync:discovery-daily-progress";

export async function loadDiscoveryProgress(query: QueryFn, today: string): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [DISCOVERY_PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: DailyProgress = JSON.parse(raw);
    if (parsed.date !== today) return new Set();
    return new Set(parsed.attemptedFundIds ?? []);
  } catch {
    return new Set();
  }
}

export async function saveDiscoveryProgress(query: QueryFn, today: string, attemptedFundIds: Set<string>): Promise<void> {
  const payload: DailyProgress = { date: today, attemptedFundIds: [...attemptedFundIds] };
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_NAV_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [DISCOVERY_PROGRESS_CHECKPOINT_KEY, JSON.stringify(payload), attemptedFundIds.size],
  );
}
