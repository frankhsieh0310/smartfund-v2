import { prisma } from "../../lib/prisma.ts";
import { globalSearch } from "../../lib/data-platform/web/searchService.ts";

async function main() {
  const fund = await prisma.fund.findFirst({ where: { isActive: true }, select: { name: true } });
  const cases = [
    ["STOCK", "AAPL", "STOCK"],
    ["ETF", "0050", "ETF"],
    ["FUND", fund?.name ?? "C000007774", "FUND"],
    ["INDEX", "S&P 500", "INDEX"],
    ["FX", "USD/TWD", "FX"],
  ] as const;
  const started = Date.now();
  const domainResults = [];
  for (const [label, query, type] of cases) {
    const result = await globalSearch({ query, type, limit: 10 });
    domainResults.push({ label, query, first: result.data[0]?.symbolOrCode ?? result.data[0]?.name ?? null, count: result.data.length, pass: result.data.every((row) => row.assetType === type) && result.data.length > 0 });
  }
  const cross = await globalSearch({ query: "USD", limit: 30 });
  const noResult = await globalSearch({ query: "__SMARTFUND_NO_RESULT_9F3D2__" });
  const collisionKeys = cross.data.map((row) => `${row.assetType}:${row.canonicalId}`);
  let invalidQuery = "FAIL";
  try { await globalSearch({ query: "" }); } catch (error) { invalidQuery = error instanceof Error && error.message.includes("between 1 and 100") ? "PASS" : "FAIL"; }
  console.log(JSON.stringify({
    domains: domainResults,
    crossAsset: { types: [...new Set(cross.data.map((row) => row.assetType))], count: cross.data.length, pass: new Set(cross.data.map((row) => row.assetType)).size > 1 },
    noResult: { count: noResult.data.length, pass: noResult.data.length === 0 },
    typeFilters: { pass: domainResults.every((item) => item.pass) },
    collisionSafety: { pass: collisionKeys.length === new Set(collisionKeys).size },
    invalidQuery,
    bounded: { totalLimit: 30, maxPerDomain: 10, returned: cross.data.length },
    durationMs: Date.now() - started,
  }));
}

main().finally(() => prisma.$disconnect());
