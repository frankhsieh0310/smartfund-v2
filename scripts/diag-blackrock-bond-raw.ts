async function dump(ticker: string, productId: string, wanted: string[]) {
  const url = `https://www.blackrock.com/tw/products/${productId}/fund/1480664180144.ajax?fileType=csv&fileName=${ticker}_holdings&dataType=fund`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const text = await r.text();
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  console.log(`=== ${ticker} HEADER ===`, lines[2]);
  for (const line of lines.slice(3)) {
    const first = line.split(",")[0]?.replace(/"/g, "").trim();
    if (wanted.includes(first)) console.log("ROW:", line);
  }
}
async function main() {
  await dump("00991B", "351827", ["ABBV", "ABIBB", "WFC", "HD"]);
  await dump("009826", "351824", ["JPY"]);
}
main();
