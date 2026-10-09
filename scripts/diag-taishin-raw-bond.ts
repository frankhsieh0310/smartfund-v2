import * as cheerio from "cheerio";
async function main() {
  const r = await fetch("https://www.tsit.com.tw/ETF/Home/Pcf/00775B", { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await r.text();
  const $ = cheerio.load(html);
  $(".fund_card").each((_, card) => {
    const header = $(card).find(".card-header").text().replace(/\s+/g, "");
    if (!header.includes("債券")) return;
    console.log("HEADER:", header);
    const headRow = $(card).find("table thead tr").first();
    console.log("COLUMNS:", headRow.find("th").map((__, th) => $(th).text().trim()).get());
    const firstRows = $(card).find("table tbody tr").slice(0, 3);
    firstRows.each((__, tr) => {
      console.log("ROW:", $(tr).find("td").map((___, td) => $(td).text().trim()).get());
    });
  });
}
main();
