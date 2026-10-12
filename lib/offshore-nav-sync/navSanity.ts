// Independent ±20% jump-review guard for this pipeline (does not import/modify priceSanity.ts or
// sitca-nav-sync's navSanity.ts -- same shape, separate implementation per this session's established
// convention of not cross-wiring independent pipelines).
export type NavSanityResult = "OK" | "JUMP_REVIEW";

export function checkOffshoreNavSanity(newNav: number, lastKnownNav: number | null): NavSanityResult {
  if (lastKnownNav === null || lastKnownNav <= 0) return "OK";
  const change = Math.abs(newNav - lastKnownNav) / lastKnownNav;
  if (change > 0.2) return "JUMP_REVIEW";
  return "OK";
}
