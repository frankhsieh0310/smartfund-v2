// 2026-10-22（使用者核准，共用資料庫負載第二項）: 開關預設關閉，開了才啟用「多檔包成一個
// transaction再觸發一次refresh_reverse_products」的批次模式；關閉時維持原本逐檔各自commit的
// 行為（persistMoneydjDisclosure，不受這個開關影響）。
export function isMoneydjFundBatchRefreshEnabled(): boolean {
  return process.env.MONEYDJ_FUND_BATCH_REFRESH === "on";
}

// 每個外層transaction包幾檔——預設20，不是使用者口頭提到的50或原本DEFAULT_BATCH=80，避免單一
// transaction鎖表時間太長。可用MONEYDJ_FUND_BATCH_REFRESH_INNER_SIZE環境變數調整。
export function moneydjFundBatchRefreshInnerSize(): number {
  const raw = Number(process.env.MONEYDJ_FUND_BATCH_REFRESH_INNER_SIZE ?? 20);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 80) : 20;
}
