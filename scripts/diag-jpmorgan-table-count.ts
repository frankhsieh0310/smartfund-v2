import { withPage } from "../lib/etf-holdings-engine/adapters/browserUtil.ts";

async function main() {
  console.error("[diag] starting (networkidle0, matching real adapter)...");
  const url = "https://am.jpmorgan.com/tw/zh/asset-management/twetf/products/jpmorgan-taiwan-taiwan-equity-high-income-active-etf-tw00000401a1";
  const result = await withPage(async (page) => {
    await page.goto(`${url}#/pcf`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes("申購買回清單公告"), { timeout: 15000 });
    return page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      return {
        tableCount: tables.length,
        tables: tables.map((t, i) => ({
          index: i, rowCount: t.querySelectorAll("tr").length,
          firstRowText: t.querySelector("tr")?.textContent?.trim().slice(0, 60) ?? "",
          html_len: t.outerHTML.length,
        })),
      };
    });
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => console.error("[diag] FAILED:", e));
