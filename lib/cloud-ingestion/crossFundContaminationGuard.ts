// 2026-11-10（使用者核准定案，第3項防呆）: 寫入基金持股前的最後一道檢查——同一個來源、同一天，
// 兩檔以上「不相關」的基金出現完全相同的個股持股清單與比重，幾乎一定是上游資料把一檔基金的
// 月報誤標到別的基金上（2026-11-09事故：10個*_OFFICIAL_MONTHLY來源的歷史髒資料，詳見
// holdings_quarantine表）。這裡只收斂「要不要放行」這個純判斷邏輯，可以離開DB獨立測試；
// 真正查DB找出重複批次的SQL在migrations/scripts裡，不是這支檔案的責任。
//
// 不能設計得太敏感：同一檔基金的不同幣別/級別（A/B/N類、累積/配息類）本來就該共用同一份持股，
// 那是合法情況，不能擋——所以這支函式只負責「兩組持股清單內容完全相同」這個事實判斷，呼叫端
// 自己要先排除「這些fundId本來就是同一個portfolio（share class分組）」的狀況，不要對同一個
// fund family誤報。

export type HoldingEntry = { name: string; weight: number };

/** 持股清單的順序無關簽章——排序後比對，不是比陣列順序。 */
export function holdingsSignature(holdings: readonly HoldingEntry[]): string {
  return [...holdings]
    .map((h) => `${h.name}:${h.weight}`)
    .sort()
    .join(',');
}

export type FundBatch = { fundId: string; portfolioKey: string; holdings: readonly HoldingEntry[] };

export type ContaminationFinding = {
  signature: string;
  portfolioKeys: string[];
  fundIds: string[];
};

/** 同一批（相同source/date，由呼叫端自己先篩好）裡，比對完整持股清單——portfolioKey不同卻清單
 * 完全相同，視為污染；portfolioKey相同（同一檔基金的不同級別/幣別）一律放行，不算污染。
 * holdings為空清單的批次不參與比對（避免「兩者都還沒抓到任何持股」被誤判成重複）。 */
export function findCrossFundContamination(batches: readonly FundBatch[]): ContaminationFinding[] {
  const bySignature = new Map<string, FundBatch[]>();
  for (const batch of batches) {
    if (batch.holdings.length === 0) continue;
    const sig = holdingsSignature(batch.holdings);
    const existing = bySignature.get(sig);
    if (existing) existing.push(batch);
    else bySignature.set(sig, [batch]);
  }
  const findings: ContaminationFinding[] = [];
  for (const [signature, group] of bySignature) {
    const distinctPortfolios = new Set(group.map((b) => b.portfolioKey));
    if (distinctPortfolios.size > 1) {
      findings.push({
        signature,
        portfolioKeys: [...distinctPortfolios],
        fundIds: group.map((b) => b.fundId),
      });
    }
  }
  return findings;
}

/** 單一新批次要不要擋下來寫入的便利包裝：跟「這個來源、這一天，已經寫過的其他基金的批次」比較。
 * existingBatches不含即將寫入的這一筆。 */
export function isContaminatedAgainstExisting(
  incoming: FundBatch,
  existingBatches: readonly FundBatch[],
): boolean {
  if (incoming.holdings.length === 0) return false;
  const incomingSig = holdingsSignature(incoming.holdings);
  return existingBatches.some(
    (b) => b.portfolioKey !== incoming.portfolioKey && b.holdings.length > 0 && holdingsSignature(b.holdings) === incomingSig,
  );
}
