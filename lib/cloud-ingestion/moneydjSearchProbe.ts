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

export async function runMoneydjSearchProbe(testNames: string[]): Promise<{ attempts: MoneydjSearchProbeAttempt[]; stoppedOnBlock: boolean }> {
  const attempts: MoneydjSearchProbeAttempt[] = [];
  let stoppedOnBlock = false;
  for (const name of testNames) {
    for (const { label, url } of CANDIDATES(name)) {
      if (stoppedOnBlock) break;
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        const blocked = res.status === 403 || res.status === 429 || /Access denied|too many requests/i.test(text);
        attempts.push({ candidateLabel: `${label}:${name}`, url, httpStatus: res.status, bodyHead: text.slice(0, 2000), blocked, error: null });
        if (blocked) { stoppedOnBlock = true; break; }
      } catch (e: any) {
        attempts.push({ candidateLabel: `${label}:${name}`, url, httpStatus: null, bodyHead: null, blocked: false, error: String(e?.message ?? e) });
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return { attempts, stoppedOnBlock };
}
