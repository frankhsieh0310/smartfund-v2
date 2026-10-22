import { prisma } from "../../lib/prisma.ts";
import { getFundFilterOptions, getFundList } from "../../lib/data-platform/web/fundService.ts";

async function main() {
  const initial = await getFundList({ page: 1, pageSize: 50 });
  const first = initial.data?.[0];
  const options = await getFundFilterOptions();
  const keyword = first ? await getFundList({ query: first.identity.symbol, page: 1, pageSize: 50 }) : null;
  const currency = options.currencies[0] ? await getFundList({ currency: options.currencies[0], page: 1, pageSize: 50 }) : null;
  const pageTwo = await getFundList({ page: 2, pageSize: 50 });
  const missing = await prisma.fund.findFirst({
    where: { isActive: true, OR: [{ company: "" }, { riskLevel: null }] },
    select: { id: true, company: true, riskLevel: true },
  });

  console.log(JSON.stringify({
    initial: { count: initial.data?.length ?? 0, total: initial.pagination?.total ?? 0, pageSize: initial.pagination?.pageSize, freshness: initial.meta.freshnessStatus, provenance: initial.meta.provenance.source },
    keyword: { value: first?.identity.symbol ?? null, count: keyword?.data?.length ?? 0, pass: Boolean(keyword?.data?.some((row) => row.identity.id === first?.identity.id)) },
    currency: { value: options.currencies[0] ?? null, count: currency?.data?.length ?? 0, pass: Boolean(currency?.data?.every((row) => row.identity.currency === options.currencies[0])) },
    pagination: { page1: initial.pagination?.page, page2: pageTwo.pagination?.page, page1Count: initial.data?.length, page2Count: pageTwo.data?.length, distinct: first?.identity.id !== pageTwo.data?.[0]?.identity.id },
    missingFields: missing ?? "NO_MATCHING_ROW",
  }));
}

main().finally(() => prisma.$disconnect());
