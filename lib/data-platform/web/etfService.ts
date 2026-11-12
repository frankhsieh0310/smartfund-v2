import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus, twAwareFreshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type ServiceResponse, type SummaryMetrics } from "./types.ts";
import { getCoreUniverseEtfIds } from "../../tw-purchasable/coreUniverseFilter.ts";
import { splitAdjustmentFor } from "../knownSplitEvents.ts";

const etfIdentity = (row: { id: string; code: string; name: string; currency: string; exchange: string | null; region: string | null }): CanonicalIdentity => ({ assetType: "ETF", id: row.id, symbol: row.code, name: row.name, displayName: row.name, currency: row.currency, market: row.exchange, country: row.region });
const etfMetrics = (row: { latestPrice: unknown; latestNav: unknown; currency: string; priceUpdatedAt: Date | null; return1m: unknown; return3m: unknown; return1y: unknown; dividendYield: unknown }): SummaryMetrics => ({ priceOrNav: numberOrNull(row.latestPrice ?? row.latestNav), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.priceUpdatedAt), performance1M: numberOrNull(row.return1m), performance3M: numberOrNull(row.return3m), performance1Y: numberOrNull(row.return1y), dividendYield: numberOrNull(row.dividendYield) });

export type EtfListQuery = ListQuery & {
  exchange?: string;
  currency?: string;
  issuer?: string;
  category?: string;
  sort?: "name" | "latestPrice" | "aum" | "performance1Y";
  direction?: "asc" | "desc";
};

export interface EtfListItem {
  identity: CanonicalIdentity;
  issuer: string | null;
  category: string | null;
  price: number | null;
  nav: number | null;
  aum: number | null;
  sharesOutstanding: number | null;
  premiumDiscount: number | null;
  // 2026-10-30（使用者核准）: premiumDiscount是證交所MIS的盤中預估折溢價，不是收盤後結算值，
  // 呼叫端（網站列表頁/詳情頁、App）要用這個日期標示「預估、資料日期」，不能當成已結算數字顯示。
  premiumDiscountAsOfDate: string | null;
  holdingsCount: number;
  flowCoverage: { status: "PARTIAL_CURRENT" | "UNAVAILABLE"; asOfDate: string | null };
  metrics: SummaryMetrics;
  freshnessStatus: ReturnType<typeof freshnessStatus>;
  source: string | null;
  publicReady: boolean;
}

type AssetMetricRow = { etf_id: string; observation_date: Date; aum: unknown; shares_outstanding: unknown; nav: unknown; source: string };
type FlowCoverageRow = { etf_id: string; observation_date: Date };
type ReadyRow = { id: string; latest_date: Date | null; history_ready: boolean; latest_premium: unknown; latest_premium_date: Date | null; holdings_count: bigint | number };

// 2026-10-13 QA-round-1 dedup fix: 92 TW ETFs exist as TWO rows -- a bare code ("006208") and a
// Yahoo-suffixed code ("006208.TW"/".TWO") for the same real-world ETF, from two independent
// ingestion pipelines. Per the user's decision, the bare-code row (market-close-sync's own, the
// "official" one) is kept and the suffixed duplicate is hidden from listings/search -- DISPLAY LAYER
// ONLY, no rows are deleted (that's a separate DDL-approval-gated cleanup, see
// docs/specs/etf-dedup-cleanup-draft.sql). 00981D's bare row was previously missing the
// dividend_yield its suffixed twin had -- docs/specs/00981D-dividend-yield-fix-draft.sql has since
// been executed (VERIFIED 2026-10-16: both rows show dividend_yield=0.0734), so there is no longer a
// gap to protect and this set is empty. Left as a named constant (not deleted outright) so the next
// person who finds a similar backfill-pending case has an obvious place to add it back.
const DEDUP_BACKFILL_PENDING = new Set<string>([]);

// 2026-10-14 round-4: was a manually-maintained 6-code list (020000/020012/020028/020030/020031/
// 020034.TW), found incomplete when the user spotted 020001.TWO ("Fubon Securities Co Ltd") was
// missing from it. Replaced with a RULE per the user's explicit instruction, instead of adding
// entries one at a time forever: a TW-listed (.TW/.TWO) row whose name is a securities BROKERAGE
// FIRM's own corporate name, not a fund product, is never a real ETF.
//
// Tried and rejected: (1) a bare code-prefix rule ("020xxx") -- TOO BROAD, it also matches 020032.TW,
// a genuine ETF ("Yuanta Taiwan Green Energy..."), and would have matched dozens of real Korean ETFs
// if not scoped to .TW/.TWO. (2) Yahoo's own `instrumentType` field -- checked live, Yahoo itself
// mislabels every one of these codes as "ETF", so it's not a usable signal here. (3) A bare
// "name contains Securities/證券" match -- TOO BROAD on its own: nearly every genuine TW ETF's own
// official long name contains "證券投資信託基金" (standard regulatory naming), and some genuine
// international ETFs/ETPs use "Securities" as part of a legitimate product name.
//
// What actually works: scope to .TW/.TWO AND require the name to contain Securities/證券 AND NOT
// contain any fund/ETF/index-indicating word. Verified live (2026-10-14) against the full `etfs`
// table: this matches exactly 17 rows, all of them real Taiwanese brokerage firms' own stock
// listings (Fubon/Yuanta/President/Uni-President/Yuanda/Mega Securities), and zero genuine ETFs --
// see docs/specs/misclassified-etf-codes.md for the full list this rule currently catches.
const MISCLASSIFIED_SECURITIES_FIRM_FILTER = Prisma.sql`
  code ~ '\.(TW|TWO)$'
  AND (name ILIKE '%securities%' OR name LIKE '%證券%')
  AND name !~* 'etf|fund|trust|index'
  AND name !~ '基金|信託|指數'
`;

// 2026-11-10（模擬器實測第2項，使用者核准定案）: 這兩支都是對整張etfs表做regex/ILIKE的全表
// 掃描，而且完全沒有快取——每一次search（含每個keystroke的debounce後請求）都重新掃一次全表。
// 這份清單只會在ETF新上市/下市時變動，比照coreUniverseFilter.ts同一套5分鐘記憶體快取模式，
// 不是每個請求都重算。
let misclassifiedCodesCache: { codes: string[]; fetchedAt: number } | null = null;
let suffixedDuplicateCodesCache: { codes: string[]; fetchedAt: number } | null = null;
const ETF_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

async function getMisclassifiedSecuritiesFirmCodes(): Promise<string[]> {
  if (misclassifiedCodesCache && Date.now() - misclassifiedCodesCache.fetchedAt < ETF_LIST_CACHE_TTL_MS) return misclassifiedCodesCache.codes;
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`SELECT code FROM etfs WHERE ${MISCLASSIFIED_SECURITIES_FIRM_FILTER}`;
  const codes = rows.map((r) => r.code);
  misclassifiedCodesCache = { codes, fetchedAt: Date.now() };
  return codes;
}

async function getSuffixedDuplicateCodesToHide(): Promise<string[]> {
  if (suffixedDuplicateCodesCache && Date.now() - suffixedDuplicateCodesCache.fetchedAt < ETF_LIST_CACHE_TTL_MS) return suffixedDuplicateCodesCache.codes;
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string }>>(`
    SELECT suffixed.code FROM etfs suffixed
    WHERE suffixed.code ~ '\\.(TW|TWO)$'
      AND EXISTS (SELECT 1 FROM etfs bare WHERE bare.code = regexp_replace(suffixed.code, '\\.(TW|TWO)$', ''))
  `);
  const codes = rows.map((r) => r.code).filter((code) => !DEDUP_BACKFILL_PENDING.has(code.replace(/\.(TW|TWO)$/, "")));
  suffixedDuplicateCodesCache = { codes, fetchedAt: Date.now() };
  return codes;
}

export async function getEtfList(query: EtfListQuery = {}): Promise<ServiceResponse<EtfListItem[]>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const direction: Prisma.SortOrder = query.direction === "desc" ? "desc" : "asc";
  const hiddenDuplicateCodes = [...(await getSuffixedDuplicateCodesToHide()), ...(await getMisclassifiedSecuritiesFirmCodes())];
  // 2026-10-19（使用者商品範圍規則，最高層）: 只顯示「台灣買得到」的核心母體 ETF。
  const coreIds = await getCoreUniverseEtfIds();
  const where = {
    isActive: true,
    id: { in: Array.from(coreIds) },
    ...(hiddenDuplicateCodes.length ? { code: { notIn: hiddenDuplicateCodes } } : {}),
    ...(query.exchange ? { exchange: query.exchange } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.issuer ? { provider: query.issuer } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(term ? { OR: [{ code: { contains: term, mode: "insensitive" as const } }, { name: { contains: term, mode: "insensitive" as const } }, { isin: { contains: term, mode: "insensitive" as const } }] } : {}),
  };
  const orderBy = query.sort === "latestPrice"
    ? [{ latestPrice: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
    : query.sort === "aum"
      ? [{ aum: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
      : query.sort === "performance1Y"
        ? [{ return1y: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
        : [{ name: direction }, { id: "asc" as const }];
  // 2026-11-10（模擬器實測第1項，使用者核准定案，效能根因修正）: 原本這兩支查詢都帶
  // include:{_count:{select:{holdings:true}}}——Prisma會對「這檔ETF史上所有holdings列」做
  // 無條件count（不分asOfDate），VERIFIED對production量測單檔ETF就要~1秒，10檔疊起來是search
  // API最大的單一瓶頸（13秒裡佔了將近全部）。holdingsCount本來就該是「目前這批揭露的持股數」，
  // 不是「史上累積寫入過幾列」，兩者語意上也不該混在一起——改成只在後面readiness那支raw SQL
  // 多加一欄，只數「最新asOfDate那一天」的筆數，吃得到holdings表(etf_id,as_of_date)複合索引，
  // 不用再靠Prisma對整個id清單逐筆count。
  const [total, exactRows, rows] = await Promise.all([
    prisma.etf.count({ where }),
    term ? prisma.etf.findMany({ where: { isActive: true, code: { equals: term, mode: "insensitive" } }, take: 1 }) : Promise.resolve([]),
    prisma.etf.findMany({ where: term ? { ...where, NOT: { code: { equals: term, mode: "insensitive" } } } : where, skip: term ? 0 : skip, take: pageSize, orderBy }),
  ]);
  const rowsWithExact = term ? [...exactRows, ...rows.filter((row) => !exactRows.some((exact) => exact.id === row.id))].slice(0, pageSize) : rows;
  const ids = rowsWithExact.map((row) => row.id);
  // 2026-10-30（使用者核准，淨值欄顯示異常修正）: 元大追蹤差距曾經借用這張表的nav欄位存放完全
  //不同意義的數字（深度-239.92%），被這裡的「同etf_id挑最新一筆」邏輯誤當淨值撿走。追蹤差距的寫入
  // 程式已經改寫到專屬的etf_tracking_difference表，但這裡仍明確只信任已知代表「真淨值」的來源白名單，
  // 不再對「這個etf_id最新一筆是誰」照單全收——未來任何來源想借用這個generic nav欄位存別的意義，
  // 都不會悄悄污染這份列表。
  const NAV_SOURCE_ALLOWLIST = Prisma.sql`('DERIVED_AUM_NAV_X_SHARES', 'BlackRock / iShares Official Product Data', 'ISHARES_OFFICIAL', 'BLACKROCK_ISHARES_OFFICIAL_PRODUCT_DATA')`;
  const [assetMetrics, flowCoverage, readiness] = ids.length ? await Promise.all([
    prisma.$queryRaw<AssetMetricRow[]>(Prisma.sql`SELECT DISTINCT ON (etf_id) etf_id, observation_date, aum, shares_outstanding, nav, source FROM etf_asset_metrics WHERE etf_id IN (${Prisma.join(ids)}) AND (nav IS NULL OR source IN ${NAV_SOURCE_ALLOWLIST}) ORDER BY etf_id, observation_date DESC, updated_at DESC LIMIT ${pageSize}`),
    prisma.$queryRaw<FlowCoverageRow[]>(Prisma.sql`SELECT etf_id, MAX(observation_date) AS observation_date FROM etf_flows WHERE etf_id IN (${Prisma.join(ids)}) GROUP BY etf_id LIMIT ${pageSize}`),
    // 2026-10-30（使用者核准，ETF折溢價接官方資料）: latest_premium/latest_premium_date 一起從
    // 同一筆etf_history row取（跟app/etf/[code]/page.tsx一樣的「同一筆記錄」保證），不是分開
    // 查日期再配etfs.premium——避免重演今天上午etfs.latestNav那種死資料配錯日期的bug。
    prisma.$queryRaw<ReadyRow[]>(Prisma.sql`SELECT e.id,(SELECT h.date FROM etf_history h WHERE h.etf_id=e.id ORDER BY h.date DESC LIMIT 1) latest_date,EXISTS(SELECT 1 FROM etf_history h WHERE h.etf_id=e.id OFFSET 19 LIMIT 1) history_ready,(SELECT h.premium FROM etf_history h WHERE h.etf_id=e.id AND h.premium IS NOT NULL ORDER BY h.date DESC LIMIT 1) latest_premium,(SELECT h.date FROM etf_history h WHERE h.etf_id=e.id AND h.premium IS NOT NULL ORDER BY h.date DESC LIMIT 1) latest_premium_date,(SELECT count(*) FROM holdings hd WHERE hd.etf_id=e.id AND hd.as_of_date=(SELECT max(hd2.as_of_date) FROM holdings hd2 WHERE hd2.etf_id=e.id)) holdings_count FROM etfs e WHERE e.id IN (${Prisma.join(ids)})`),
  ]) : [[], [], []];
  const metricByEtf = new Map(assetMetrics.map((row) => [row.etf_id, row]));
  const flowByEtf = new Map(flowCoverage.map((row) => [row.etf_id, row]));
  const readyByEtf = new Map(readiness.map((row) => [row.id, row]));
  const latest = rows.reduce<Date | null>((value, row) => !value || (row.priceUpdatedAt && row.priceUpdatedAt > value) ? row.priceUpdatedAt : value, null);
  const updated = rows.reduce<Date | null>((value, row) => !value || row.updatedAt > value ? row.updatedAt : value, null);
  const sources = [...new Set(rows.map((row) => row.dataSource ?? row.dataProvider ?? row.provider).filter(Boolean))];
  const source = sources.length === 1 ? sources[0]! : sources.length ? "MULTIPLE_CANONICAL_SOURCES" : null;
  const provenance = buildProvenance({ source, asOfDate: latest, lastUpdated: updated });
  const items = await Promise.all(rowsWithExact.map(async (row) => {
    const assetMetric = metricByEtf.get(row.id);
    const flow = flowByEtf.get(row.id);
    const ready = readyByEtf.get(row.id);
    const rowFreshness = await twAwareFreshnessStatus(row.exchange, ready?.latest_date, "MARKET_DAY");
    // 2026-10-29（使用者核准，AUM雙來源衝突查證定案）: etf_asset_metrics.aum（來源
    // MONEYDJ_ETF_PUBLIC）VERIFIED跟Yahoo/證交所差了超過10^6倍、停在2026-08-13沒再更新過
    // ——抽查0050/SPY/QQQ，etfs.aum跟Yahoo Finance當前數字幾乎完全一致（SPY $809.22B、
    // QQQ $498.95B，誤差在個位數美元），0050也跟證交所ETFortune頁面同量級，etf_asset_metrics.aum
    // 才是錯的那個。改成只用etfs.aum，不再讓assetMetric.aum蓋掉它。nav/shares_outstanding這兩個
    // assetMetric欄位沒有這個問題（VERIFIED抽查0050/0056/00878的metrics_nav全部是null，從來沒蓋掉
    // 過etfs.latest_nav），維持原狀不動。
    // 2026-10-30（使用者核准）: premiumDiscount只信latest_premium/latest_premium_date這組「同一筆
    // etf_history記錄」配對出來的值，不直接讀row.premium（那是鏡像欄位，沒有自己的日期可核實）。
    const premiumAgeDays = ready?.latest_premium_date ? (Date.now() - ready.latest_premium_date.getTime()) / 86_400_000 : null;
    const premiumFresh = premiumAgeDays != null && premiumAgeDays <= 3;
    const premiumDiscount = premiumFresh ? numberOrNull(ready!.latest_premium) : null;
    const premiumDiscountAsOfDate = premiumFresh ? isoOrNull(ready!.latest_premium_date) : null;
    return { identity: etfIdentity(row), issuer: row.provider || null, category: row.category, price: numberOrNull(row.latestPrice), metrics: etfMetrics(row), nav: numberOrNull(assetMetric?.nav ?? row.latestNav), aum: numberOrNull(row.aum), sharesOutstanding: numberOrNull(assetMetric?.shares_outstanding), premiumDiscount, premiumDiscountAsOfDate, holdingsCount: Number(ready?.holdings_count ?? 0), flowCoverage: { status: (flow ? "PARTIAL_CURRENT" : "UNAVAILABLE") as "PARTIAL_CURRENT" | "UNAVAILABLE", asOfDate: isoOrNull(flow?.observation_date) }, freshnessStatus: rowFreshness, publicReady: (row.latestPrice != null || row.latestNav != null) && ready?.history_ready === true && rowFreshness === "CURRENT", source: row.dataSource ?? row.dataProvider ?? row.provider };
  }));
  return { data: items, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "MARKET_DAY"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total), error: null };
}

export async function getEtfFilterOptions(): Promise<{ exchanges: string[]; currencies: string[]; issuers: string[]; categories: string[] }> {
  const [exchanges, currencies, issuers, categories] = await Promise.all([
    prisma.etf.findMany({ where: { isActive: true, exchange: { not: null } }, distinct: ["exchange"], select: { exchange: true }, orderBy: { exchange: "asc" }, take: 100 }),
    prisma.etf.findMany({ where: { isActive: true }, distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" }, take: 30 }),
    prisma.etf.findMany({ where: { isActive: true, provider: { not: "" } }, distinct: ["provider"], select: { provider: true }, orderBy: { provider: "asc" }, take: 100 }),
    prisma.etf.findMany({ where: { isActive: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 100 }),
  ]);
  return { exchanges: exchanges.flatMap((row) => row.exchange ? [row.exchange] : []), currencies: currencies.map((row) => row.currency), issuers: issuers.map((row) => row.provider), categories: categories.flatMap((row) => row.category ? [row.category] : []) };
}

export async function searchEtfs(query: string, options: Omit<ListQuery, "query"> = {}) {
  return getEtfList({ ...options, query });
}

export async function getEtfDetail(code: string): Promise<ServiceResponse<{ identity: CanonicalIdentity; metrics: SummaryMetrics; nav: number | null; navAsOfDate: string | null; aum: number | null; premiumDiscount: number | null; premiumDiscountAsOfDate: string | null; expenseRatio: number | null; expenseRatioTierText: string | null; distributionFreq: string | null; holdingsCount: number; holdingsAsOfDate: string | null; topHoldings: Array<{ name: string; symbol: string | null; weight: number | null }>; assetAllocation: Array<{ label: string; weight: number }>; sectorAllocation: Array<{ label: string; weight: number }>; category: string | null }>> {
  const key = decodeURIComponent(code).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "An ETF code is required.");
  const row = await prisma.etf.findFirst({ where: { OR: [{ id: key }, { code: { equals: key, mode: "insensitive" } }, { isin: { equals: key, mode: "insensitive" } }] }, include: { history: { where: { OR: [{ price: { not: null } }, { nav: { not: null } }] }, orderBy: { date: "desc" }, take: 2 } } });
  if (!row) throw new WebDataError("NOT_FOUND", "ETF not found.");
  // 2026-10-24（使用者規則，第一條）: 詳情頁是「使用者挑選商品」這一層，不是持股穿透揭露，
  // 必須套用核心母體過濾——直接用 id/code/isin 查表原本會讓任何不在核心母體的 ETF（例如
  // LSE/Tokyo/HKSE 上市的，表裡仍有大量歷史遺留資料）只要猜得到網址就看得到詳情頁。
  const coreIds = await getCoreUniverseEtfIds();
  if (!coreIds.has(row.id)) throw new WebDataError("NOT_FOUND", "ETF not found.");
  const latest = row.history[0];
  const previous = row.history[1];
  const latestValue = numberOrNull(latest?.price ?? latest?.nav ?? row.latestPrice ?? row.latestNav);
  const previousValue = numberOrNull(previous?.price ?? previous?.nav);
  // 2026-10-13 QA-round-1 fix: prefer the authoritative day-change already written by
  // app/api/cron/cloud-etf-price/route.ts (Yahoo's own previousClose/regularMarketPrice — see that
  // route's comment) over deriving one from our own two-row EtfHistory diff, which can disagree with
  // Yahoo's own basis around non-trading-day gaps. Falls back to the diff only when that figure is
  // not yet available for this ETF.
  // 2026-11-07（使用者核准，第35輪指令第2點）: performance1M/3M/1Y 原本經由 etfMetrics(row) 讀
  // etfs.return1m/return3m/return1y 這三個扁平欄位——跟 app/api/rankings/performance/route.ts
  // 2026-11-06 記錄過的同一個「跟 etf_performances 最新一筆對不上」的過期欄位問題，詳情頁從沒
  // 修過。這裡直接取 etf_performances 依 date 排序的最新一列，連同它自己的 date 一起回傳
  // （performanceAsOfDate），給前端標示「這批績效數字是哪一天的」。
  const latestPerformance = await prisma.etfPerformance.findFirst({
    where: { etfId: row.id }, orderBy: { date: "desc" },
    select: { date: true, return1d: true, return1m: true, return3m: true, return1y: true },
  });
  const authoritativeChangePercent = numberOrNull(latestPerformance?.return1d);
  const changePercent = authoritativeChangePercent ?? (previousValue != null && previousValue !== 0 && latestValue != null ? ((latestValue - previousValue) / previousValue) * 100 : null);
  // Absolute change derived from the authoritative percent (previousImplied = latest / (1 + pct/100)),
  // not a second independently-sourced number — this is unit conversion of the one authoritative value.
  const change = changePercent != null && latestValue != null
    ? (authoritativeChangePercent != null ? latestValue - latestValue / (1 + changePercent / 100) : latestValue - (previousValue as number))
    : null;
  // 2026-11-10（上架前審查第4項，使用者核准）: 市價（marketPrice）跟淨值（navValue）各自只用
  // 同一欄位算自己的漲跌，不像上面priceOrNav/change會在price缺資料時退回nav，導致今天市價減
  // 昨天淨值這種混用。authoritativeChangePercent（return1d）是市價基礎的官方日漲跌幅，只用在
  // marketPriceChange，不能套用在navChange（淨值沒有對應的官方日漲跌幅來源）。
  const marketPrice = numberOrNull(latest?.price);
  const previousPriceOnly = numberOrNull(previous?.price);
  const marketPriceChangePercent = authoritativeChangePercent ?? (previousPriceOnly != null && previousPriceOnly !== 0 && marketPrice != null ? ((marketPrice - previousPriceOnly) / previousPriceOnly) * 100 : null);
  const marketPriceChange = marketPriceChangePercent != null && marketPrice != null
    ? (authoritativeChangePercent != null ? marketPrice - marketPrice / (1 + marketPriceChangePercent / 100) : marketPrice - (previousPriceOnly as number))
    : null;
  // 2026-11-13 使用者回報核實（0050淨值-2.09/-2.01%但市價+3.49/+3.51%，日期對不起來）: 原本
  // navValue/navChange直接用「latest」（price或nav任一有值就算最新）那一列的nav，淨值來源
  // 更新頻率跟市價不同步時，latest這一列常常price有今天的值、nav欄位卻還是null，於是
  // navValue退回row.latestNav這個鏡像欄位——但那個鏡像欄位本身可能停留在更早一天，跟畫面上
  // 顯示的「淨值日期」（用latest.date，也就是今天）完全對不上，navChange因此變成「今天的舊
  // 鏡像值」減「前一列的淨值」，基準期間跟市價漲跌不是同一天，算出離譜的數字。改成跟既有
  // premiumRow同一套做法——直接查「nav本身有值」的最新一列，連同它自己的日期一起用，不跟
  // price的日期混用；navChange也改成跟「nav有值的上一列」比較，不是跟「latest/previous」
  // （price-or-nav）這組日期不保證對齊的列比較。
  const navRow = await prisma.etfHistory.findFirst({ where: { etfId: row.id, nav: { not: null } }, orderBy: { date: "desc" }, select: { nav: true, date: true } });
  const prevNavRow = navRow ? await prisma.etfHistory.findFirst({ where: { etfId: row.id, nav: { not: null }, date: { lt: navRow.date } }, orderBy: { date: "desc" }, select: { nav: true } }) : null;
  const navValue = numberOrNull(navRow?.nav ?? row.latestNav);
  const navAsOfDate = navRow?.date ?? null;
  const previousNavOnly = numberOrNull(prevNavRow?.nav);
  const navChange = navValue != null && previousNavOnly != null ? navValue - previousNavOnly : null;
  const navChangePercent = navChange != null && previousNavOnly != null && previousNavOnly !== 0 ? (navChange / previousNavOnly) * 100 : null;
  const latestHolding = await prisma.holding.findFirst({ where: { etfId: row.id }, orderBy: [{ asOfDate: "desc" }, { rank: "asc" }], select: { asOfDate: true } });
  const rawHoldings = latestHolding ? await prisma.holding.findMany({ where: { etfId: row.id, asOfDate: latestHolding.asOfDate }, orderBy: { rank: "asc" }, select: { holdingName: true, ticker: true, weight: true, sector: true, assetType: true, securityId: true, source: true, rank: true } }) : [];
  // 2026-10-29（VERIFIED，競品對照稽核發現的資料正確性bug）: 同一天、同一檔持股常被兩條不同
  // 擷取來源（ETF_OFFICIAL_DAILY_SNAPSHOT vs 舊版URL字串來源）各寫一筆，之前這裡直接用
  // holdings.length/holdings.slice(0,10)/allocation()加總，等於每檔持股的權重被算了兩次——
  // holdingsCount膨脹成兩倍、assetAllocation/sectorAllocation的百分比加總也跟著膨脹。先依
  // securityId（沒有就用holdingName）去重，優先留ETF_OFFICIAL_DAILY_SNAPSHOT那一筆。
  const holdings = [...new Map(
    rawHoldings
      .slice()
      .sort((a, b) => (a.source === "ETF_OFFICIAL_DAILY_SNAPSHOT" ? -1 : b.source === "ETF_OFFICIAL_DAILY_SNAPSHOT" ? 1 : 0))
      .map((holding) => [holding.securityId ?? holding.holdingName, holding] as const),
  ).values()].sort((a, b) => a.rank - b.rank);
  const allocation = <T extends string>(keyFor: (holding: typeof holdings[number]) => T | null) => [...holdings.reduce((values, holding) => { const label = keyFor(holding); const weight = numberOrNull(holding.weight); if (label && weight != null) values.set(label, (values.get(label) ?? 0) + weight); return values; }, new Map<T, number>())].map(([label, weight]) => ({ label, weight })).sort((left, right) => right.weight - left.weight);
  const asOf = latest?.date ?? row.priceUpdatedAt;
  const source = row.dataSource ?? row.dataProvider ?? row.provider;
  const provenance = buildProvenance({ source, sourceRecordId: row.isin, asOfDate: asOf, lastUpdated: row.updatedAt });
  const detailFreshness = await twAwareFreshnessStatus(row.exchange, asOf, "MARKET_DAY");
  // 2026-10-30（使用者核准）: 只信etf_history裡「premium本身有值」的那一筆記錄自己的日期，不
  // 落回row.premium（鏡像欄位，沒有自己的日期可核實同一天）——同一套規則跟getEtfList一致。
  const premiumRow = await prisma.etfHistory.findFirst({ where: { etfId: row.id, premium: { not: null } }, orderBy: { date: "desc" }, select: { premium: true, date: true } });
  const premiumAgeDays = premiumRow ? (Date.now() - premiumRow.date.getTime()) / 86_400_000 : null;
  const premiumFreshD = premiumAgeDays != null && premiumAgeDays <= 3;
  const premiumDiscount = premiumFreshD ? numberOrNull(premiumRow!.premium) : null;
  const premiumDiscountAsOfDate = premiumFreshD ? isoOrNull(premiumRow!.date) : null;
  // 2026-11-01（使用者核准）：expense_ratio_tier_text 刻意不在 schema.prisma 宣告（理由見該欄位
  // 旁的註解），這裡用raw SQL單獨查；欄位還沒套用ALTER TABLE前這支查詢會丟錯，外層catch成null，
  // 不影響詳情頁其他資料顯示。
  const expenseRatioTierText = await prisma.$queryRawUnsafe<Array<{ expense_ratio_tier_text: string | null }>>(
    `SELECT expense_ratio_tier_text FROM etfs WHERE id = $1`, row.id,
  ).then((rows) => rows[0]?.expense_ratio_tier_text ?? null).catch(() => null);
  return { data: { identity: etfIdentity(row), metrics: { ...etfMetrics(row), priceOrNav: latestValue, change, changePercent, asOfDate: isoOrNull(asOf), performance1M: numberOrNull(latestPerformance?.return1m), performance3M: numberOrNull(latestPerformance?.return3m), performance1Y: numberOrNull(latestPerformance?.return1y), performanceAsOfDate: isoOrNull(latestPerformance?.date), marketPrice, marketPriceChange, marketPriceChangePercent, navValue, navChange, navChangePercent }, nav: navValue, navAsOfDate: isoOrNull(navAsOfDate), aum: numberOrNull(latest?.aum ?? row.aum), premiumDiscount, premiumDiscountAsOfDate, expenseRatio: numberOrNull(row.expenseRatio), expenseRatioTierText, distributionFreq: row.distributionFreq ?? null, holdingsCount: holdings.length, holdingsAsOfDate: isoOrNull(latestHolding?.asOfDate), topHoldings: holdings.slice(0, 10).map((holding) => ({ name: holding.holdingName, symbol: holding.ticker, weight: numberOrNull(holding.weight) })), assetAllocation: allocation((holding) => holding.assetType), sectorAllocation: allocation((holding) => holding.sector), category: row.category }, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: detailFreshness, source, provenance, coverageStatus: "FULL" }, pagination: null, error: null };
}

export async function getEtfHistory(code: string, query: HistoryQuery = {}): Promise<ServiceResponse<Array<{ date: string; price: number | null; nav: number | null; premiumDiscount: number | null; volume: number | null; aum: number | null; open: number | null; high: number | null; low: number | null; close: number | null; adjustedClose: number | null }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const etf = await prisma.etf.findFirst({ where: { OR: [{ code: { equals: code, mode: "insensitive" } }, { isin: { equals: code, mode: "insensitive" } }] }, select: { id: true, dataSource: true, dataProvider: true, provider: true, exchange: true } });
  if (!etf) throw new WebDataError("NOT_FOUND", "ETF not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = { etfId: etf.id, date: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) } };
  const [total, rows] = await Promise.all([prisma.etfHistory.count({ where }), prisma.etfHistory.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { date: "desc" } })]);
  const source = etf.dataSource ?? etf.dataProvider ?? etf.provider;
  const provenance = buildProvenance({ source, asOfDate: rows[0]?.date, lastUpdated: rows[0]?.createdAt });
  const splitNotes = new Set<string>();
  const data = rows.map((row) => {
    const { ratio, notes } = splitAdjustmentFor("ETF", code, row.date);
    notes.forEach((n) => splitNotes.add(n));
    const div = (v: number | null) => v == null ? null : v / ratio;
    return { date: row.date.toISOString(), price: div(numberOrNull(row.price)), nav: numberOrNull(row.nav), premiumDiscount: numberOrNull(row.premium), volume: numberOrNull(row.volume), aum: numberOrNull(row.aum), open: div(numberOrNull(row.open)), high: div(numberOrNull(row.high)), low: div(numberOrNull(row.low)), close: div(numberOrNull(row.close ?? row.price)), adjustedClose: div(numberOrNull(row.adjustedClose ?? row.close ?? row.price)) };
  });
  // 2026-11-12（ChatGPT審查第11項）: 0050/006208歷史資料明明完整，比較頁卻一直顯示「部分資產
  // 歷史資料不完整」——查到原因是這裡原本用plain freshnessStatus()判斷MARKET_DAY新鮮度，只跳過
  // 週六週日，不知道颱風/國定假日等臨時或固定休市日，當天沒有新資料就被誤判成STALE。跟CLAUDE.md
  // 「資料新鮮度判斷」定案一致，改用twAwareFreshnessStatus()——TWSE/TPEx商品跟交易所官方「實際
  // 最新交易日」比較，不是跟猜出來的應該交易日比較；非TWSE/TPEx或無法確認時優雅退回原邏輯。
  const etfFreshness = await twAwareFreshnessStatus(etf.exchange, rows[0]?.date, "MARKET_DAY");
  return { data, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: etfFreshness, source, provenance, coverageStatus: "FULL", splitAdjustmentNote: splitNotes.size ? Array.from(splitNotes).join(" ") : null }, pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.date.toISOString() ?? null : null), error: null };
}


