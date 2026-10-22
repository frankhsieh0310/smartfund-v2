// Bounded diagnosis — one ticker (009826), raw CSV header + the exact colliding rows, to see if a
// disambiguating column (ISIN/SEDOL/Exchange/Currency) exists that the adapter currently drops.
async function main() {
  const url = `https://www.blackrock.com/tw/products/351824/fund/1480664180144.ajax?fileType=csv&fileName=009826_holdings&dataType=fund`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const text = await r.text();
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  console.log("HEADER:", lines[2]);
  const wanted = ["MRK", "ROP", "SU", "ALV", "DTE"];
  for (const line of lines.slice(3)) {
    if (wanted.some((t) => line.split(",")[0]?.replace(/"/g, "").trim() === t)) console.log("ROW:", line);
  }
}
main();
