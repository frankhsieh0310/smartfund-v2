export function isOffshoreScaleWriteEnabled(): boolean {
  return process.env.OFFSHORE_SCALE_WRITE?.trim() === "on";
}
