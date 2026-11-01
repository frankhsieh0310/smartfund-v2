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
  // 2026-11-01（使用者核准）: bodyHead只有前2000字，VERIFIED涵蓋不到真正的搜尋結果列——這兩個
  // 搜尋頁本身是外殼，結果透過頁面自己的<script src>或行內JS呼叫的API載入。從完整回應裡抓出
  // <script src>清單跟「看起來像API呼叫」的字串片段，讓使用者看得到有哪些端點可以下一步去試，
  // 不用再多打一次請求。
  scriptSrcs: string[];
  apiUrlHints: string[];
};

// 從原始bytes裡先用ascii粗略解碼出<meta charset>宣告，再用真正宣告的編碼正式解碼一次——
// HTTP回應標頭常常沒帶charset（只在HTML meta標籤裡宣告），不能只信res.headers的content-type。
function decodeByDeclaredCharset(buf: ArrayBuffer): string {
  const sniff = new TextDecoder("ascii").decode(buf.slice(0, 2000));
  const m = sniff.match(/charset=["']?([\w-]+)/i);
  const charset = m ? m[1].toLowerCase() : "utf-8";
  try {
    return new TextDecoder(charset === "big5" ? "big5" : "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function extractScriptSrcs(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    try {
      out.add(new URL(m[1], baseUrl).toString());
    } catch {
      out.add(m[1]);
    }
  }
  return [...out].slice(0, 60);
}

// 找「看起來像會回傳搜尋結果的API/AJAX呼叫」的字串片段——鎖定.aspx/.ashx/.asmx/ajax(/xdjhtm/json
// 這類關鍵字附近的一小段原文（前後80字），不是整段程式碼，保持details精簡。
const API_HINT_PATTERN = /[\w./\\-]*(?:\.aspx|\.ashx|\.asmx|ajax\(|json\?|\/api\/|GetFund|SearchFund)[\w./\\?&=%-]*/gi;
function extractApiUrlHints(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(API_HINT_PATTERN)) {
    const hit = m[0].trim();
    if (hit.length >= 6) out.add(hit);
  }
  return [...out].slice(0, 60);
}

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
        // VERIFIED 2026-10-31: MoneyDJ不同頁面編碼不一致——funddj/yb/下的舊版頁面是Big5（跟既有
        // moneydjFundDisclosure.ts處理持股頁一致），funddjx/下的新版搜尋頁反而是UTF-8。第一次探測
        // 對兩種都用res.text()(預設UTF-8解碼)，Big5那個因此整頁亂碼。改成照各頁HTML自己宣告的
        // <meta charset>解碼。
        const text = decodeByDeclaredCharset(await res.arrayBuffer());
        const blocked = res.status === 403 || res.status === 429 || /Access denied|too many requests/i.test(text);
        attempts.push({
          candidateLabel: `${label}:${name}`, url, httpStatus: res.status, bodyHead: text.slice(0, 2000), blocked, error: null,
          scriptSrcs: blocked ? [] : extractScriptSrcs(text, url),
          apiUrlHints: blocked ? [] : extractApiUrlHints(text),
        });
        if (blocked) { stoppedOnBlock = true; break; }
      } catch (e: any) {
        attempts.push({ candidateLabel: `${label}:${name}`, url, httpStatus: null, bodyHead: null, blocked: false, error: String(e?.message ?? e), scriptSrcs: [], apiUrlHints: [] });
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return { attempts, stoppedOnBlock: stoppedOnBlock || timeBudgetStop };
}
