-- 2026-10-29（使用者核准定案）: funds.isin 的單欄 unique constraint（funds_isin_key）
-- 跟境外基金建檔既有規則衝突——lib/cron/newFundListingDetection.ts 的
-- createMissingOffshoreFunds 本來就允許「同一個 ISIN、不同 TDCC 代碼」視為合法的不同股別
-- （同一檔海外基金在台灣透過不同代理人/幣別/配息政策分別登記），但資料庫層的單欄 unique
-- index 讓這種情況在 DB 層就直接拒絕，造成新加坡大華基金等案例的 NEW_FUND_CREATE_FAILED。
-- funds.code 本身已經有獨立的 funds_code_key unique constraint，所以改成 (isin, code) 的
-- 複合 unique，不會放寬成「同 isin 同 code 也能重複」，只是不再禁止「同 isin 不同 code」。
-- NULL isin 的既有列不受影響（Postgres unique index 本來就不把多個 NULL 視為互相衝突）。
-- 執行前已 VERIFIED：資料庫目前沒有任何 isin 重複列（見本次對話的 dry-run 查詢），這個
-- migration 不會因為既有資料違反新約束而失敗。
DROP INDEX IF EXISTS "funds_isin_key";
CREATE UNIQUE INDEX "funds_isin_code_key" ON "funds"("isin", "code");
