// Same shadow-mode pattern as every other write gate this round -- default OFF, only the exact
// string "on" opens it.
export function isSavedFilterAlertWriteEnabled(): boolean {
  return process.env.SAVED_FILTER_ALERT_WRITE === "on";
}
