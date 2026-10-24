export function isReverseIndexRestoreWriteEnabled(): boolean {
  return process.env.REVERSE_INDEX_RESTORE_WRITE === "on";
}
