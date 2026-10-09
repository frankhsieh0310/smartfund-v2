import { prisma } from "../../lib/prisma.ts";
import { getEtfDetail, getEtfFilterOptions, getEtfList } from "../../lib/data-platform/web/etfService.ts";

async function main() {
  const initial = await getEtfList({ page: 1, pageSize: 50 });
  const first = initial.data?.[0];
  const options = await getEtfFilterOptions();
  const search = first ? await getEtfList({ query: first.identity.symbol, page: 1, pageSize: 50 }) : null;
  const exchange = options.exchanges[0] ? await getEtfList({ exchange: options.exchanges[0], page: 1, pageSize: 50 }) : null;
  const currency = options.currencies[0] ? await getEtfList({ currency: options.currencies[0], page: 1, pageSize: 50 }) : null;
  const pageTwo = await getEtfList({ page: 2, pageSize: 50 });
  const detail = first ? await getEtfDetail(first.identity.symbol) : null;
  const [withNav, withoutNav, withAum, withoutAum, flowCount] = await Promise.all([
    prisma.etf.count({ where: { isActive: true, latestNav: { not: null } } }),
    prisma.etf.count({ where: { isActive: true, latestNav: null } }),
    prisma.etf.count({ where: { isActive: true, aum: { not: null } } }),
    prisma.etf.count({ where: { isActive: true, aum: null } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(DISTINCT etf_id) AS count FROM etf_flows`.then((rows) => Number(rows[0]?.count ?? 0)),
  ]);
  console.log(JSON.stringify({
    initial: { count: initial.data?.length ?? 0, total: initial.pagination?.total ?? 0, pageSize: initial.pagination?.pageSize, freshness: initial.meta.freshnessStatus, provenance: initial.meta.provenance.source },
    search: { value: first?.identity.symbol ?? null, count: search?.data?.length ?? 0, pass: Boolean(search?.data?.some((row) => row.identity.id === first?.identity.id)) },
    exchange: { value: options.exchanges[0] ?? null, pass: Boolean(exchange?.data?.every((row) => row.identity.market === options.exchanges[0])) },
    currency: { value: options.currencies[0] ?? null, pass: Boolean(currency?.data?.every((row) => row.identity.currency === options.currencies[0])) },
    pagination: { page1: initial.pagination?.page, page2: pageTwo.pagination?.page, page1Count: initial.data?.length, page2Count: pageTwo.data?.length, distinct: first?.identity.id !== pageTwo.data?.[0]?.identity.id },
    detail: { symbol: first?.identity.symbol ?? null, pass: detail?.data?.identity.id === first?.identity.id },
    navCoverage: { withNav, withoutNav },
    aumCoverage: { withAum, withoutAum },
    flowCoverage: { etfsWithFlow: flowCount, partial: flowCount < (initial.pagination?.total ?? 0) },
  }));
}

main().finally(() => prisma.$disconnect());
