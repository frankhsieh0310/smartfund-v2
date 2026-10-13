// Shared topic-similarity check used by BOTH the in-memory batch merge (merge.ts) and the persisted
// cross-window merge (store.ts's findMergeCandidateCard) — kept in one place deliberately so the two
// merge paths can never silently drift apart (e.g. one requiring topic overlap, the other not).
const MIN_TOPIC_OVERLAP_LEN = 2;

export function normalizeTopicName(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/[\s,，。.、/／:：;；()（）"'「」]/g, "");
}

// Generic longest-common-contiguous-substring length — no commodity/topic keyword list needed.
// "布倫特原油價格" / "原油供應能力" / "原油商業庫存" all share "原油" (len 2); "原油" and "黃金"
// share nothing >= 2, so they never match.
function longestCommonSubstringLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = temp;
    }
  }
  return best;
}

export function topicsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return longestCommonSubstringLen(a, b) >= MIN_TOPIC_OVERLAP_LEN;
}
