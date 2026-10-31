// 2026-10-31（使用者核准，雲端除錯）: 本機/這個session被MoneyDJ封鎖(220.137.35.90)，不准再
// 從本機連線——連「看一下搜尋頁呼叫了什麼」都不行。這支函式只在雲端排程（Vercel）執行環境裡被
// 呼叫，用2檔已知基金名稱試打兩個「猜測候選」端點（repo裡沒有任何現成的MoneyDJ名稱搜尋程式碼
// 可以照抄，只能用這種方式從雲端IP試探），把每個候選的HTTP狀態碼跟回應前2000字存進
// production_scheduler_runs.details，完全不寫入任何業務資料表（holdings/fund_mappings都不碰）。
// 遇到429/403立刻停止整個探測、不重試。這支函式本身不是正式資料pipeline，只是一次性除錯用，
// 等使用者看過哪個候選真的回傳可用的搜尋結果，再決定下一步要接上哪一個。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type MoneydjSearchProbeAttempt = {
  candidateLabel: string;
  url: string;
  httpStatus: number | null;
  bodyHead: string | null;
  blocked: boolean;
  error: string | null;
};

const CANDIDATES = (keyword: string): Array<{ label: string; url: string }> => [
  { label: "YP302000_a_param", url: `https://www.moneydj.com/funddj/yb/YP302000.djhtm?a=${encodeURIComponent(keyword)}` },
  { label: "fundsearch_xdjhtm_keyword", url: `https://www.moneydj.com/funddjx/fundsearch.xdjhtm?keyword=${encodeURIComponent(keyword)}` },
];

// 2026-10-31（VERIFIED，自己造成的bug修正）: 原本每個候選15秒逾時+2秒間隔，4個候選最差情況
// 將近68秒，跟下面main loop的240秒預算疊加逼近這支route maxDuration=300秒的上限——VERIFIED
// production造成2次IN_PROGRESS卡死(cloud-moneydj-fund:2026-10-31T11:00/11:15，從未完成、
// completed_at一直是null)。改成硬性maxTotalMs預算，逾時立即停止、不再試下一個候選。
export async function runMoneydjSearchProbe(testNames: string[], maxTotalMs = 20_000): Promise<{ attempts: MoneydjSearchProbeAttempt[]; stoppedOnBlock: boolean }> {
  const attempts: MoneydjSearchProbeAttempt[] = [];
  let stoppedOnBlock = false;
  const startedMs = Date.now();
  let timeBudgetStop = false;
  for (const name of testNames) {
    if (stoppedOnBlock || timeBudgetStop) break;
    for (const { label, url } of CANDIDATES(name)) {
      if (stoppedOnBlock) break;
      if (Date.now() - startedMs > maxTotalMs) { timeBudgetStop = true; break; }
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
        const text = await res.text();
        const blocked = res.status === 403 || res.status === 429 || /Access denied|too many requests/i.test(text);
        attempts.push({ candidateLabel: `${label}:${name}`, url, httpStatus: res.status, bodyHead: text.slice(0, 2000), blocked, error: null });
        if (blocked) { stoppedOnBlock = true; break; }
      } catch (e: any) {
        attempts.push({ candidateLabel: `${label}:${name}`, url, httpStatus: null, bodyHead: null, blocked: false, error: String(e?.message ?? e) });
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return { attempts, stoppedOnBlock: stoppedOnBlock || timeBudgetStop };
}
