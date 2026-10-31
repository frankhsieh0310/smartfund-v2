// 2026-10-31（使用者核准，雲端除錯，一次性）: 抓2檔已知基金的MoneyDJ持股頁原始HTML，存進
// production_scheduler_runs.details，用來確認頁面上產業配置/區域配置/經理人的真實版面，再決定
// 怎麼擴充 moneydjFundDisclosure.ts 的解析。只在雲端排程環境執行，本機不可連線。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type MoneydjHoldingsPageDump = {
  moneydjCode: string;
  fundName: string;
  httpStatus: number | null;
  htmlHead: string | null;
  blocked: boolean;
  error: string | null;
};

export async function dumpMoneydjHoldingsPages(
  targets: Array<{ moneydjCode: string; fundName: string }>,
  maxTotalMs = 20_000,
): Promise<{ dumps: MoneydjHoldingsPageDump[]; stoppedOnBlock: boolean }> {
  const dumps: MoneydjHoldingsPageDump[] = [];
  const startedMs = Date.now();
  let stoppedOnBlock = false;
  for (const target of targets) {
    if (stoppedOnBlock || Date.now() - startedMs > maxTotalMs) break;
    const url = `https://www.moneydj.com/funddj/yp/yp013000.djhtm?a=${encodeURIComponent(target.moneydjCode)}&topc=`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000) });
      const text = await res.text();
      const blocked = res.status === 403 || res.status === 429 || /Access denied|too many requests/i.test(text);
      // 存前5000字（完整HTML太長，先存夠看出版面結構的量；真正要擴充解析時如果不夠，再加一次
      // 更大範圍的除錯）。
      dumps.push({ moneydjCode: target.moneydjCode, fundName: target.fundName, httpStatus: res.status, htmlHead: text.slice(0, 5000), blocked, error: null });
      if (blocked) { stoppedOnBlock = true; break; }
    } catch (e: any) {
      dumps.push({ moneydjCode: target.moneydjCode, fundName: target.fundName, httpStatus: null, htmlHead: null, blocked: false, error: String(e?.message ?? e) });
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { dumps, stoppedOnBlock };
}
