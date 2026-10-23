// 2026-10-23（使用者核准）: 範圍外資料清理的寫入開關，預設關閉（dry-run only）。
export function isOutOfScopePurgeWriteEnabled(): boolean {
  return process.env.OUT_OF_SCOPE_PURGE_WRITE === "on";
}
