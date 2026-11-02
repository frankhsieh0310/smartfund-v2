import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type Provenance, type ResponseMeta, type ServiceResponse, type SummaryMetrics } from "./types.ts";
import { mapFundMainCategory, type FundMainCategory } from "./fundCategoryMapping.ts";
import { getCoreUniverseFundIds } from "../../tw-purchasable/coreUniverseFilter.ts";
import { getNonRepresentativeShareClassFundIds, getShareClassCountMap } from "./fundShareClassGrouping.ts";
import { getFundIdsDuplicateOfListedEtf } from "./fundDuplicateOfEtf.ts";
import { getFundIdsSupersededByNewCode } from "./fundSupersededByCode.ts";
import { calculateVolatilityAndSharpe, RISK_CALC_METHOD_LABEL, RISK_FREE_RATE_SOURCES } from "./riskCalc.ts";

// 2026-10-16: 925 distinct fund names (1,887 rows) share a display name with at least one other
// fund row -- VERIFIED live these are overwhelmingly genuinely different, real, purchasable share
// classes of the same fund family (confirmed: each row's own `data_source` is already a distinct
// real ticker, e.g. Goldman Sachs Technology Opportunities has 7 rows under GTORX/GSJPX/GITSX/GITIX/
// GITCX/GITAX/GISTX, each a real share class with its own NAV), NOT duplicate rows of the same
// security. User-approved fallback (ISIN backfill and Yahoo-sourced share-class labels both checked
// live and confirmed NOT AVAILABLE via quoteSummary for these US mutual funds -- quoteType/
// summaryProfile/price/fundProfile all came back null/absent): disambiguate the DISPLAY name with
// the fund's own real ticker (`dataSource`), copied verbatim from the source, never invented. This
// is display-layer only -- `name` in the DB is untouched, no data is altered.
function disambiguatedDisplayName(name: string, dataSource: string | null, duplicateNames: ReadonlySet<string>): string {
  if (!dataSource || !duplicateNames.has(name)) return name;
  return `${name}（${dataSource}）`;
}

const fundIdentity = (row: { id: string; code: string | null; isin: string | null; name: string; currency: string; domicile: string | null; region: string | null; dataSource?: string | null }, duplicateNames: ReadonlySet<string> = new Set()): CanonicalIdentity => ({ assetType: "FUND", id: row.id, symbol: row.code ?? row.isin ?? row.id, name: row.name, displayName: disambiguatedDisplayName(row.name, row.dataSource ?? null, duplicateNames), currency: row.currency, market: row.domicile, country: row.region ?? row.domicile });
const fundMetrics = (row: { latestNav: unknown; currency: string; latestNavDate: Date | null; return1y: unknown; dividendYieldA?: unknown }): SummaryMetrics => ({ priceOrNav: numberOrNull(row.latestNav), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.latestNavDate), performance1M: null, performance3M: null, performance1Y: numberOrNull(row.return1y), dividendYield: numberOrNull(row.dividendYieldA) });

// 2026-11-02（使用者核准）: 持股資料（最新持倉）超過3個月沒更新時附過期提示，附資料月份——算在
// 共用的service層，網站的app/funds/[id]/page.tsx跟App（/api/mobile/...）都讀同一個欄位，不各自
// 重算，確保文字跟門檻一致。
const HOLDINGS_STALE_WARNING_DAYS = 90;
function holdingsStaleWarning(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const days = Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
  if (days <= HOLDINGS_STALE_WARNING_DAYS) return null;
  const d = new Date(isoDate);
  const yyyymm = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `資料可能已過期（資料月份：${yyyymm}）`;
}

export type FundListQuery = ListQuery & {
  company?: string;
  currency?: string;
  category?: string;
  riskLevel?: number;
  sort?: "name" | "latestNavDate" | "performance1Y";
  direction?: "asc" | "desc";
};

export interface FundListItem {
  identity: CanonicalIdentity;
  isin: string | null;
  metrics: SummaryMetrics;
  company: string;
  category: string | null;
  fundCategory: FundMainCategory;
  fundSubcategory: string | null;
  riskLevel: number | null;
  freshnessStatus: ReturnType<typeof freshnessStatus>;
  publicReady: boolean;
  source: string | null;
  // 2026-10-21（使用者核准）: VERIFIED live -- 175 funds are still approved for sale but the
  // official source (SITCA/TDCC) has never once published a NAV for this specific share class
  // (latestNav AND latestNavDate both null -- not "reported before, now stale", which stays
  // UNAVAILABLE/freshnessStatus as before). Only this list/table surfaces the distinction via this
  // one flag; FUND-only, does not touch SummaryMetrics (shared with ETF/FX/etc).
  navPending: boolean;
  // 2026-10-21（14點任務第2項）: 同一產品的其他級別數量（含自己），僅對代表級別>1 時才有意義；
  // 沒有分組記錄的基金固定是 1。給前端顯示「共 N 個級別」徽章用。
  shareClassCount: number;
}

// 2026-10-14 QA-round-1 fix: 4,577 offshore foreign-currency share classes (data_provider='yahoo')
// were bulk-imported once (2026-07-24) and never covered by any ongoing NAV sync since -- see
// docs/specs/offshore-fund-classification.md. Classified against TDCC's own official offshore-fund
// list (opendata.tdcc.com.tw): 3,711 are TDCC-approved but simply not synced yet (pending approval to
// extend offshore-nav-sync's coverage), 866 are not in TDCC's current list at all. Hiding this WHOLE
// stale set from listings/search for now (not deleting, not distinguishing the two sub-groups here)
// is simplest and self-correcting: once the 3,711 are approved and synced they become fresh and this
// condition naturally stops hiding them, while the 866 stay hidden indefinitely (correctly, since
// they're never going to get synced). NOT applied to the DB -- display layer only.
const STALE_UNSYNCED_OFFSHORE_FUND_DAYS = 14;

export async function getFundList(query: FundListQuery = {}): Promise<ServiceResponse<FundListItem[]>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const direction: Prisma.SortOrder = query.direction === "desc" ? "desc" : "asc";
  // 2026-10-19（使用者商品範圍規則，最高層）: 只顯示「台灣買得到」的核心母體基金（SITCA 國內
  // 基金＋TDCC 3-2 境內核備境外基金）。
  const [coreFundIds, nonRepresentativeShareClassFundIds, duplicateOfEtfFundIds, supersededFundIds] = await Promise.all([
    getCoreUniverseFundIds(),
    getNonRepresentativeShareClassFundIds(),
    getFundIdsDuplicateOfListedEtf(),
    getFundIdsSupersededByNewCode(),
  ]);
  const where = {
    isActive: true,
    // 2026-10-30（使用者核准）: 名稱帶ETF但實際已經由etfs表某個掛牌代號代表的重複紀錄，只在
    // 這個列表查詢排除，不碰isActive/classification，見fundDuplicateOfEtf.ts的說明。
    // 2026-10-31（使用者核准）: 舊的無字尾SITCA代碼被字母字尾新代碼取代後，同一個模式排除，
    // 見fundSupersededByCode.ts的說明。
    id: { in: Array.from(coreFundIds), notIn: [...nonRepresentativeShareClassFundIds, ...duplicateOfEtfFundIds, ...supersededFundIds] },
    NOT: {
      dataProvider: "yahoo",
      lastNavSource: null,
      latestNavDate: { lt: new Date(Date.now() - STALE_UNSYNCED_OFFSHORE_FUND_DAYS * 86_400_000) },
    },
    ...(query.company ? { company: query.company } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
    ...(term ? { OR: [{ code: { contains: term, mode: "insensitive" as const } }, { isin: { contains: term, mode: "insensitive" as const } }, { name: { contains: term, mode: "insensitive" as const } }, { company: { contains: term, mode: "insensitive" as const } }] } : {}),
  };
  const orderBy = query.sort === "latestNavDate"
    ? [{ latestNavDate: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
    : query.sort === "performance1Y"
      ? [{ return1y: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
      : [{ name: direction }, { id: "asc" as const }];
  const [total, rows] = await prisma.$transaction([
    prisma.fund.count({ where }),
    prisma.fund.findMany({ where, skip, take: pageSize, orderBy }),
  ]);
  const duplicateNames = rows.length
    ? new Set(
        (
          await prisma.fund.groupBy({
            by: ["name"],
            where: { isActive: true, name: { in: [...new Set(rows.map((r) => r.name))] } },
            _count: { name: true },
            having: { name: { _count: { gt: 1 } } },
          })
        ).map((g) => g.name),
      )
    : new Set<string>();
  const readiness = rows.length ? await prisma.$queryRaw<Array<{id:string;history_ready:boolean}>>(Prisma.sql`SELECT f.id,EXISTS(SELECT 1 FROM fund_history h WHERE h.fund_id=f.id OFFSET 19 LIMIT 1) history_ready FROM funds f WHERE f.id IN (${Prisma.join(rows.map(row=>row.id))})`) : [];
  const readyByFund = new Map(readiness.map(row=>[row.id,row.history_ready]));
  const shareClassCountMap = await getShareClassCountMap();
  const latest = rows.reduce<Date | null>((value, row) => !value || (row.latestNavDate && row.latestNavDate > value) ? row.latestNavDate : value, null);
  const updated = rows.reduce<Date | null>((value, row) => !value || row.updatedAt > value ? row.updatedAt : value, null);
  const source = rows.length === 1 ? rows[0].lastNavSource ?? rows[0].dataSource ?? rows[0].dataProvider : "MULTIPLE_VERIFIED_PROVIDERS";
  const provenance = buildProvenance({ source, asOfDate: latest, lastUpdated: updated });
  return { data: rows.map((row) => ({ identity: fundIdentity(row, duplicateNames), isin: row.isin, metrics: fundMetrics(row), company: row.company, category: row.category, fundCategory: mapFundMainCategory(row.category), fundSubcategory: row.category, riskLevel: row.riskLevel, freshnessStatus: freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE"), publicReady: row.latestNav != null && row.latestNavDate != null && readyByFund.get(row.id) === true && !["STALE","UNKNOWN","UNAVAILABLE"].includes(freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE")), source: row.lastNavSource ?? row.dataSource ?? row.dataProvider, navPending: row.latestNav == null && row.latestNavDate == null, shareClassCount: shareClassCountMap.get(row.id) ?? 1 })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total), error: null };
}

export async function getFundFilterOptions(): Promise<{ companies: string[]; currencies: string[]; categories: string[]; riskLevels: number[] }> {
  const [companies, currencies, categories, riskLevels] = await Promise.all([
    prisma.fund.findMany({ where: { isActive: true, company: { not: "" } }, distinct: ["company"], select: { company: true }, orderBy: { company: "asc" }, take: 100 }),
    prisma.fund.findMany({ where: { isActive: true }, distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" }, take: 30 }),
    prisma.fund.findMany({ where: { isActive: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 100 }),
    prisma.fund.findMany({ where: { isActive: true, riskLevel: { not: null } }, distinct: ["riskLevel"], select: { riskLevel: true }, orderBy: { riskLevel: "asc" }, take: 10 }),
  ]);
  return {
    companies: companies.map((row) => row.company),
    currencies: currencies.map((row) => row.currency),
    categories: categories.flatMap((row) => row.category ? [row.category] : []),
    riskLevels: riskLevels.flatMap((row) => row.riskLevel === null ? [] : [row.riskLevel]),
  };
}

export const searchFunds = (query: string, options: Omit<ListQuery, "query"> = {}) => getFundList({ ...options, query });

export type FundDetailRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "10Y" | "MAX";
export type FundSectionCoverage = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "SOURCE_PENDING";
export const FUND_DETAIL_LIMITS = { history: 240, shareClasses: 20, riskMetrics: 20, classifications: 20, holdings: 20, documents: 20 } as const;

export interface FundSection<T> {
  coverage: FundSectionCoverage;
  data: T;
  provenance: Provenance;
}

export interface FundDetailData {
  identity: CanonicalIdentity & { isin: string | null; code: string | null };
  company: string | null;
  assetClass: string | null;
  category: string | null;
  fundCategory: FundMainCategory;
  fundSubcategory: string | null;
  riskRating: number | null;
  /** Authoritative (Yahoo-sourced) annualized trailing dividend yield, percent units. */
  dividendYield: number | null;
  nav: FundSection<{ value: number | null; currency: string | null; date: string | null }>;
  history: FundSection<Array<{ date: string; nav: number | null }>> & { range: FundDetailRange; maxPoints: number };
  performance: FundSection<{ return1M: number | null; return3M: number | null; return6M: number | null; returnYtd: number | null; return1Y: number | null; return3YAnnualized: number | null; return5YAnnualized: number | null; semantics: "NAV_RETURN" }>;
  riskMetrics: FundSection<Array<{ metricCode: string; period: string; value: number; asOfDate: string | null; calculationMethod: string; observationCount: number; source: string; returnSemantics: string | null }>>;
  shareClasses: FundSection<Array<{ id: string; name: string; code: string | null; isin: string | null; currency: string | null; distributionType: string | null; accumulationDistribution: string | null; hedged: boolean | null; hedgedCurrency: string | null; investorType: string | null; source: string }>>;
  feesTerms: FundSection<Array<{ shareClass: string; managementFee: number | null; ongoingCharges: number | null; ter: number | null; salesChargeFront: number | null; salesChargeBack: number | null; performanceFee: number | null; minimumInitialInvestment: number | null; distributionFrequency: string | null; hedgingTerms: string | null; source: string | null; asOfDate: string | null }>>;
  classifications: FundSection<Array<{ type: string; name: string; value: string | null; method: string; benchmarkName: string | null; benchmarkCode: string | null; benchmarkId: string | null; source: string; asOfDate: string | null }>>;
  holdings: FundSection<{ reportDate: string | null; staleWarning: string | null; items: Array<{ holdingName: string | null; securityId: string | null; weight: number | null; marketValue: number | null; currency: string | null; source: string; weightDisclosed: boolean }> }>;
  /** 2026-10-29: 產業/區域配置，來源 Yahoo奇摩股市基金頁"持股狀況"，排程 FUND_ALLOCATION_SYNC。 */
  sectorAllocation: FundSection<Array<{ label: string; weight: number }>> & { asOfDate: string | null };
  regionAllocation: FundSection<Array<{ label: string; weight: number }>> & { asOfDate: string | null };
  managers: FundSection<Array<{ name: string; role: string | null; startDate: string | null }>>;
  documents: FundSection<Array<{ type: string; title: string | null; date: string | null; language: string | null; url: string; source: string }>>;
  flows: FundSection<null>;
  /** 2026-10-31（使用者核准）: SITCA月申報的基金規模/受益人數/申購贖回(IN2201)與當月實際費用占
   * 淨資產比率(IN2211，非公開說明書年費率，不可換算年化)。mgmtFeePct/custodianFeePct/totalFeePct
   * 都是「yearMonth那個月」的實際值，畫面顯示務必帶上yearMonth與來源，不得另外標成「經理費率」。 */
  monthlyDisclosure: FundSection<{
    yearMonth: string | null;
    aumTwd: number | null;
    navTwd: number | null;
    totalHolders: number | null;
    subscriptionTwd: number | null;
    redemptionTwd: number | null;
    mgmtFeePct: number | null;
    custodianFeePct: number | null;
    totalFeePct: number | null;
    /** 'SITCA_IN2201' 正常月申報；'FUNDCLEAR_QUERY_FUND_REPORT' 表示 SITCA 這個月代碼對不上、
     * 改用 FundClear 補的規模（畫面要標示來源為 FundClear，不是 SITCA）。 */
    aumSource: string | null;
  }>;
  /** 2026-10-31（使用者核准）: FundClear年度報酬率/年度費用率，只適用「只有一個級別」的境內
   * 基金，用基金代碼查詢分不出級別。年度費用率是整個曆年彙總，跟monthlyDisclosure的SITCA月實際
   * 費用是不同指標，畫面標示務必寫成「YYYY年度費用率（FundClear）」，不可混用或互相取代。 */
  annualMetricsFundclear: FundSection<Array<{ year: string; returnPct: number | null; feeRatePct: number | null; returnSource: string | null }>>;
  /** 2026-10-31（使用者核准）: 境外基金全球規模(TDCC opendata 3-2，整個基金所有級別合計，原幣別)。
   * 跟monthlyDisclosure(境內基金月申報)是不同的資料結構，境外基金專用。 */
  offshoreScaleTdcc: FundSection<{ scaleAmountMillions: number | null; scaleCurrency: string | null; scaleAsOfDate: string | null }>;
  /** 2026-10-31（使用者核准）: 境外基金國人持有金額(FundClear)，新臺幣計價——跟上面
   * offshoreScaleTdcc(全球規模，原幣別)是完全不同的指標，畫面不可混在一起。 */
  offshoreTwHolding: FundSection<{ twHoldingTwd: number | null; twHoldingPct: number | null; yearMonth: string | null }>;
}

type HoldingRow = { security_id: string | null; holding_name: string | null; weight: unknown; market_value: unknown; currency: string | null; report_date: Date; source: string; updated_at: Date; rank: number | null };
// 2026-10-19: MoneyDJ's "names only, no weight disclosed at all" page shape (see
// MoneydjHoldingsNameOnlyError in lib/cloud-ingestion/moneydjFundDisclosure.ts) persists into its
// own dedicated fund_holdings_name_only table, never into fund_holdings/holdings (both of which
// either require or imply a real weight) -- queried here ONLY as a fallback when the main
// fund_holdings query above has nothing, and surfaced with weightDisclosed:false so the frontend
// shows "來源未揭露比例" instead of a blank/zero weight, and portfolio drill-through (reverseHoldings.ts)
// can refuse to treat it as equal-weighted.
type NameOnlyHoldingRow = { holding_name: string; as_of_date: Date; source: string; updated_at: Date };
type ShareClassRow = { id: string; shareClassName: string; shareClassCode: string | null; isin: string | null; currency: string | null; distributionType: string | null; distributionFrequency: string | null; accumulatingDistributing: string | null; hedgedCurrency: string | null; hedged: boolean | null; institutionalRetail: string | null; managementFee: unknown; ongoingCharges: unknown; ter: unknown; salesChargeFront: unknown; salesChargeBack: unknown; performanceFee: unknown; minimumInitialInvestment: unknown; termsSource: string | null; termsSourceRecordId: string | null; termsAsOfDate: Date | null; source: string; sourceRecordId: string | null; updatedAt: Date };
type DocumentRow = { id: string; documentType: string; documentTitle: string | null; documentDate: Date | null; effectiveDate: Date | null; language: string | null; url: string; source: string; sourceRecordId: string | null; updatedAt: Date };
type ClassificationRow = { id: string; classificationType: string; classificationName: string; classificationValue: string | null; classificationMethod: string; benchmarkName: string | null; benchmarkCode: string | null; benchmarkId: string | null; source: string; sourceRecordId: string | null; asOfDate: Date | null; updatedAt: Date };
type RiskMetricRow = { id: string; metricCode: string; period: string; value: unknown; asOfDate: Date; calculationMethod: string; observationCount: number; source: string; returnSemantics: string | null; updatedAt: Date };

const rangeStart = (range: FundDetailRange): Date | undefined => {
  if (range === "MAX") return undefined;
  const now = new Date();
  const months = range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : range === "1Y" ? 12 : range === "3Y" ? 36 : range === "5Y" ? 60 : 120;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
};

const sectionCoverage = (count: number, partial = false): FundSectionCoverage => count === 0 ? "UNAVAILABLE" : partial ? "PARTIAL" : "AVAILABLE";
// 2026-10-31（VERIFIED，自己造成的bug修正）: year_month實際存的是"YYYY-MM"（含dash），不是
// "YYYYMM"，原本的正則永遠不會match，asOfDate一直悄悄是null。
const yearMonthToDate = (ym: string | null | undefined): string | null => ym && /^\d{4}-\d{2}$/.test(ym) ? `${ym}-01` : null;

export async function getFundDetail(identifier: string, relationLimit = 20, range: FundDetailRange = "1Y"): Promise<ServiceResponse<FundDetailData>> {
  const key = decodeURIComponent(identifier).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "A fund identifier is required.");
  if (!Number.isInteger(relationLimit) || relationLimit < 0 || relationLimit > 20) throw new WebDataError("INVALID_PAGINATION", "Fund relation limit must be between 0 and 20.");
  if (!(["1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "MAX"] as string[]).includes(range)) throw new WebDataError("INVALID_QUERY", "Unsupported fund history range.");
  const row = await prisma.fund.findFirst({ where: { OR: [{ id: key }, { code: { equals: key, mode: "insensitive" } }, { isin: { equals: key, mode: "insensitive" } }] } });
  if (!row) throw new WebDataError("NOT_FOUND", "Fund not found.");
  // 2026-10-24（使用者規則，第一條）: 詳情頁是「使用者挑選商品」這一層，必須套用核心母體過濾
  // （同 etfService.getEtfDetail 的理由）——否則任何不是 SITCA 國內基金／TDCC 境外基金的舊資料
  // 只要猜得到網址就看得到詳情頁。
  const coreFundIds = await getCoreUniverseFundIds();
  if (!coreFundIds.has(row.id)) throw new WebDataError("NOT_FOUND", "Fund not found.");
  const sectionLimit = Math.min(relationLimit, 20);
  const from = rangeStart(range);
  // 2026-10-31（使用者核准）: 持股/產業配置/區域配置/經理人/基金規模屬於「基金層級」資料——
  // 同一檔基金（funds.code去掉級別字尾後相同）的不同級別只要有一個有資料，其他級別應該共用同
  // 一份顯示，不是每個級別各自缺資料。這是READ時的fallback join，不是寫入時複製多份：寫入端
  // （monthlyDisclosureWriter.ts等）維持原樣，只在這裡「自己這個級別沒有資料時，才借別的級別的
  // 資料來顯示」，自己本來就有的資料永遠優先、不會被覆蓋。報酬率(fundHistory/fundPerformance)
  // 維持級別層級、不套用這個fallback。
  const rowId = row.id;
  const baseCode = row.code ? row.code.replace(/[A-Za-z]+$/, "") : null;
  const siblingIds = baseCode
    ? (await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM funds WHERE code ~ ('^' || $1 || '[A-Za-z]*$')`,
        baseCode,
      )).map((r) => r.id)
    : [rowId];
  async function pickSourceFundId(table: string, dateColumn: string | null): Promise<string> {
    if (siblingIds.length <= 1) return rowId;
    const order = dateColumn ? `ORDER BY (fund_id = $2) DESC, ${dateColumn} DESC NULLS LAST` : `ORDER BY (fund_id = $2) DESC`;
    const picked = await prisma.$queryRawUnsafe<{ fund_id: string }[]>(
      `SELECT fund_id FROM ${table} WHERE fund_id = ANY($1::text[]) ${order} LIMIT 1`,
      siblingIds, rowId,
    );
    return picked[0]?.fund_id ?? rowId;
  }
  const [holdingsSourceId, sectorSourceId, regionSourceId, managerSourceId, aumSourceId, feeSourceId] = await Promise.all([
    pickSourceFundId("holdings", "as_of_date"),
    pickSourceFundId("(SELECT fund_id, as_of_date FROM fund_classifications WHERE classification_type = 'YAHOO_SECTOR_ALLOCATION') t", "as_of_date"),
    pickSourceFundId("(SELECT fund_id, as_of_date FROM fund_classifications WHERE classification_type = 'YAHOO_REGION_ALLOCATION') t", "as_of_date"),
    pickSourceFundId("(SELECT fund_id, start_date FROM fund_manager_assignments WHERE end_date IS NULL) t", "start_date"),
    pickSourceFundId("fund_aum_disclosure_monthly", "year_month"),
    pickSourceFundId("fund_fee_disclosure_monthly", "year_month"),
  ]);
  // 2026-10-29（VERIFIED，獨立代理驗收抓到的bug）: 下面historyRows本來就會被`range`參數（預設
  // "1Y"）的from篩選器限制成只有近1年資料——這支查詢本來是給NAV走勢圖用的，圖表本來就該照
  // 使用者選的區間篩選沒有問題。但風險指標計算(1Y/3Y/5Y)原本直接複用這包已經被砍到剩1年的
  // historyRows，導致不管算哪個窗口、篩出來的navPoints永遠是同一批（最多1年）資料，1Y/3Y/5Y
  // 三個期間算出來的Sharpe數字完全一樣（VERIFIED ABSUEAUSD三個期間都是0.8824）——改成另外抓一包
  // 不受`range`限制、往回抓滿5年的NAV序列專門給風險計算用，兩邊互不影響。
  const riskCalcFromDate = new Date(Date.UTC(new Date().getUTCFullYear() - 5, new Date().getUTCMonth(), new Date().getUTCDate()));
  const [historyRows, riskCalcHistoryRows, performance, shareClasses, documents, classifications, riskMetrics, holdings] = await Promise.all([
    prisma.fundHistory.findMany({ where: { fundId: row.id, ...(from ? { date: { gte: from } } : {}) }, orderBy: { date: "desc" }, take: 10_000, select: { date: true, nav: true, return1m: true, return3m: true, return6m: true, returnYtd: true, return1y: true, return3y: true, return5y: true, createdAt: true } }),
    prisma.fundHistory.findMany({ where: { fundId: row.id, date: { gte: riskCalcFromDate }, nav: { not: null } }, orderBy: { date: "asc" }, take: 2_000, select: { date: true, nav: true } }),
    prisma.fundPerformance.findFirst({ where: { fundId: row.id }, orderBy: { date: "desc" } }),
    sectionLimit ? prisma.$queryRaw<ShareClassRow[]>(Prisma.sql`SELECT id, share_class_name AS "shareClassName", share_class_code AS "shareClassCode", isin, currency, distribution_type AS "distributionType", distribution_frequency AS "distributionFrequency", accumulating_distributing AS "accumulatingDistributing", hedged_currency AS "hedgedCurrency", hedged, institutional_retail AS "institutionalRetail", management_fee AS "managementFee", ongoing_charges AS "ongoingCharges", ter, sales_charge_front AS "salesChargeFront", sales_charge_back AS "salesChargeBack", performance_fee AS "performanceFee", minimum_initial_investment AS "minimumInitialInvestment", terms_source AS "termsSource", terms_source_record_id AS "termsSourceRecordId", terms_as_of_date AS "termsAsOfDate", source, source_record_id AS "sourceRecordId", updated_at AS "updatedAt" FROM fund_share_classes WHERE fund_id = ${row.id} ORDER BY updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<DocumentRow[]>(Prisma.sql`SELECT id, document_type AS "documentType", document_title AS "documentTitle", document_date AS "documentDate", effective_date AS "effectiveDate", language, url, source, source_record_id AS "sourceRecordId", updated_at AS "updatedAt" FROM fund_documents WHERE fund_id = ${row.id} AND is_current IS TRUE AND url LIKE 'https://%' ORDER BY document_date DESC NULLS LAST, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    // YAHOO_SECTOR_ALLOCATION/YAHOO_REGION_ALLOCATION排除在這個通用「分類與Benchmark」清單外——
    // 這兩種現在有自己專屬、正確排版的面板（sectorAllocation/regionAllocation），混進這裡只會
    // 用原始classification_type當label、看不出類別名稱（VERIFIED截圖發現這個問題）。
    sectionLimit ? prisma.$queryRaw<ClassificationRow[]>(Prisma.sql`SELECT id, classification_type AS "classificationType", classification_name AS "classificationName", classification_value AS "classificationValue", classification_method AS "classificationMethod", benchmark_name AS "benchmarkName", benchmark_code AS "benchmarkCode", benchmark_id AS "benchmarkId", source, source_record_id AS "sourceRecordId", as_of_date AS "asOfDate", updated_at AS "updatedAt" FROM fund_classifications WHERE fund_id = ${row.id} AND classification_type NOT IN ('YAHOO_SECTOR_ALLOCATION', 'YAHOO_REGION_ALLOCATION') ORDER BY as_of_date DESC NULLS LAST, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<RiskMetricRow[]>(Prisma.sql`SELECT id, metric_code AS "metricCode", period, value, as_of_date AS "asOfDate", calculation_method AS "calculationMethod", observation_count AS "observationCount", source, return_semantics AS "returnSemantics", updated_at AS "updatedAt" FROM fund_risk_metrics WHERE fund_id = ${row.id} ORDER BY as_of_date DESC, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    // 2026-10-29（使用者核准，基金前十大持股免費功能缺口修正）: VERIFIED fund_holdings這張表全站
    // 只有1檔基金有資料——實際上千檔基金的MoneyDJ持股揭露(157,903筆MONEYDJ_PUBLIC_DISCLOSURE來源)
    // 是寫進holdings表（跟ETF共用同一張表，用fund_id區分），之前這裡一直讀錯表，所以基金詳情頁
    // 幾乎永遠顯示「尚無holdings資料」。改讀holdings，一樣先鎖最新as_of_date；同一天同一檔持股
    // 偶爾有多個來源各寫一筆（跟ETF那次修的bug同一種），下面用security_id/holding_name去重，
    // 優先留MONEYDJ_PUBLIC_DISCLOSURE（這批基金持股揭露最主要、最完整的來源）。
    sectionLimit ? prisma.$queryRaw<HoldingRow[]>(Prisma.sql`SELECT security_id, holding_name, weight, market_value, currency, as_of_date AS report_date, source, created_at AS updated_at, rank FROM holdings WHERE fund_id = ${holdingsSourceId} AND as_of_date = (SELECT MAX(as_of_date) FROM holdings WHERE fund_id = ${holdingsSourceId}) ORDER BY weight DESC NULLS LAST, market_value DESC NULLS LAST LIMIT 200`) : Promise.resolve([]),
  ]);
  const dedupedHoldings = [...new Map(
    holdings
      .slice()
      .sort((a, b) => (a.source === "MONEYDJ_PUBLIC_DISCLOSURE" ? -1 : b.source === "MONEYDJ_PUBLIC_DISCLOSURE" ? 1 : 0))
      .map((item) => [item.security_id ?? item.holding_name, item] as const),
  ).values()].slice(0, FUND_DETAIL_LIMITS.holdings);
  const [sectorAllocationRows, regionAllocationRows, managerRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ classification_code: string; classification_value: string; as_of_date: Date }[]>(
      `SELECT classification_code, classification_value, as_of_date FROM fund_classifications WHERE fund_id = $1 AND classification_type = 'YAHOO_SECTOR_ALLOCATION' ORDER BY classification_value::numeric DESC`,
      sectorSourceId,
    ),
    prisma.$queryRawUnsafe<{ classification_code: string; classification_value: string; as_of_date: Date }[]>(
      `SELECT classification_code, classification_value, as_of_date FROM fund_classifications WHERE fund_id = $1 AND classification_type = 'YAHOO_REGION_ALLOCATION' ORDER BY classification_value::numeric DESC`,
      regionSourceId,
    ),
    prisma.$queryRawUnsafe<{ name: string; role: string | null; start_date: Date | null }[]>(
      `SELECT m.name, a.role, a.start_date FROM fund_manager_assignments a JOIN fund_managers m ON m.id = a.manager_id WHERE a.fund_id = $1 AND a.end_date IS NULL ORDER BY a.start_date DESC NULLS LAST`,
      managerSourceId,
    ),
  ]);
  const [aumDisclosureRows, feeDisclosureRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ year_month: string; aum_twd: unknown; nav_twd: unknown; total_holders: number | null; subscription_twd: unknown; redemption_twd: unknown; source: string }[]>(
      `SELECT year_month, aum_twd, nav_twd, total_holders, subscription_twd, redemption_twd, source FROM fund_aum_disclosure_monthly WHERE fund_id = $1 ORDER BY year_month DESC LIMIT 1`,
      aumSourceId,
    ),
    prisma.$queryRawUnsafe<{ year_month: string; mgmt_fee_pct: unknown; custodian_fee_pct: unknown; total_fee_pct: unknown }[]>(
      `SELECT year_month, mgmt_fee_pct, custodian_fee_pct, total_fee_pct FROM fund_fee_disclosure_monthly WHERE fund_id = $1 ORDER BY year_month DESC LIMIT 1`,
      feeSourceId,
    ),
  ]);
  // 2026-10-31: fund_annual_metrics_fundclear 這張表要等使用者核准
  // scratch_fundclear_annual_table.sql 才會存在——用 try/catch 包起來，表還沒建好之前這裡安靜
  // 回傳空陣列，不讓整個基金詳情頁因為一張還沒建的表而500。
  const annualMetricsRows = await prisma.$queryRawUnsafe<{ year: string; return_pct: unknown; fee_rate_pct: unknown; return_source: string | null }[]>(
    `SELECT year, return_pct, fee_rate_pct, return_source FROM fund_annual_metrics_fundclear WHERE fund_id = $1 ORDER BY year DESC`,
    rowId,
  ).catch(() => []);
  // 2026-10-31: fund_offshore_scale_tdcc 這張表要等使用者核准SQL才會存在，同樣用try/catch包起來。
  const offshoreScaleRows = await prisma.$queryRawUnsafe<{ scale_amount_millions: unknown; scale_currency: string; scale_as_of_date: Date }[]>(
    `SELECT scale_amount_millions, scale_currency, scale_as_of_date FROM fund_offshore_scale_tdcc WHERE fund_id = $1`,
    rowId,
  ).catch(() => []);
  // 2026-10-31: fund_offshore_tw_holding_fundclear 這張表要等使用者核准SQL才會存在。
  const offshoreTwHoldingRows = await prisma.$queryRawUnsafe<{ tw_holding_twd: unknown; tw_holding_pct: unknown; year_month: string }[]>(
    `SELECT tw_holding_twd, tw_holding_pct, year_month FROM fund_offshore_tw_holding_fundclear WHERE fund_id = $1`,
    rowId,
  ).catch(() => []);
  const nameOnlyHoldings = sectionLimit && dedupedHoldings.length === 0
    ? await prisma.$queryRaw<NameOnlyHoldingRow[]>(Prisma.sql`SELECT holding_name, as_of_date, source, updated_at FROM fund_holdings_name_only WHERE fund_id = ${holdingsSourceId} AND as_of_date = (SELECT MAX(as_of_date) FROM fund_holdings_name_only WHERE fund_id = ${holdingsSourceId}) ORDER BY rank ASC LIMIT ${FUND_DETAIL_LIMITS.holdings}`)
    : [];
  const source = row.lastNavSource ?? row.dataSource ?? row.dataProvider;
  const provenance = buildProvenance({ source, sourceRecordId: row.isin, asOfDate: row.latestNavDate, lastUpdated: row.updatedAt });
  const latestHistory = historyRows[0];
  const historyProvenance = buildProvenance({ source, sourceRecordId: row.id, asOfDate: latestHistory?.date, lastUpdated: latestHistory?.createdAt });
  const latestReturns = performance ?? latestHistory;
  const performanceDate = performance?.date ?? latestHistory?.date;
  const performanceProvenance = buildProvenance({ source, sourceRecordId: row.id, asOfDate: performanceDate, lastUpdated: performance?.createdAt ?? latestHistory?.createdAt });
  const riskLatest = riskMetrics[0];
  const holdingLatest = dedupedHoldings[0];
  const documentLatest = documents[0];
  const classificationLatest = classifications[0];
  const shareLatest = shareClasses[0];
  const fees: FundDetailData["feesTerms"]["data"] = shareClasses.map((shareClass) => ({ shareClass: shareClass.shareClassName, managementFee: numberOrNull(shareClass.managementFee), ongoingCharges: numberOrNull(shareClass.ongoingCharges), ter: numberOrNull(shareClass.ter), salesChargeFront: numberOrNull(shareClass.salesChargeFront), salesChargeBack: numberOrNull(shareClass.salesChargeBack), performanceFee: numberOrNull(shareClass.performanceFee), minimumInitialInvestment: numberOrNull(shareClass.minimumInitialInvestment), distributionFrequency: shareClass.distributionFrequency ?? row.distributionFreq, hedgingTerms: shareClass.hedged === null ? null : shareClass.hedged ? shareClass.hedgedCurrency ? `HEDGED_${shareClass.hedgedCurrency}` : "HEDGED" : "UNHEDGED", source: shareClass.termsSource ?? shareClass.source, asOfDate: isoOrNull(shareClass.termsAsOfDate) }));
  if (!fees.length && (row.expenseRatio !== null || row.distributionFreq)) fees.push({ shareClass: row.name, managementFee: null, ongoingCharges: null, ter: numberOrNull(row.expenseRatio), salesChargeFront: null, salesChargeBack: null, performanceFee: null, minimumInitialInvestment: null, distributionFrequency: row.distributionFreq, hedgingTerms: null, source, asOfDate: isoOrNull(row.latestNavDate) });
  const classificationAssetClass = classifications.find((item) => /ASSET.CLASS/i.test(item.classificationType))?.classificationValue ?? classifications.find((item) => /ASSET.CLASS/i.test(item.classificationType))?.classificationName ?? null;
  // 2026-10-29（使用者核准，免費功能缺口——基金風險指標，含3Y/5Y擴充）: VERIFIED核心母體
  // 5,884檔基金裡，fund_risk_metrics的sharpe_3y/std_dev_3y（Yahoo官方來源）覆蓋率是0，但另一批
  // 既有「DERIVED_FROM_FUND_HISTORY」一次性計算（2026-08-09~09-08，已經不是活躍排程，VERIFIED
  // 沒有任何現行cron還在寫入）用的是SHARPE_RF_ZERO（無風險利率固定當0），跟ETF這次統一採用的
  // 真實利率規則不一致。標準差不受無風險利率影響，既有的VOLATILITY_1Y/3Y/5Y保留；SHARPE_1Y/3Y/
  // 5Y無論有沒有既有值，一律用真實利率重新計算覆蓋過去，沒有官方利率來源的幣別就不顯示Sharpe、
  // 標示原因——跟ETF完全同一套規則。riskCalc.ts的calculateVolatilityAndSharpe本身就是「餵多少
  // 天的真實價格就算多長窗口的年化標準差/夏普值」，不需要另外改公式，只要餵3年/5年的NAV歷史
  // 進去即可，1Y/3Y/5Y三個窗口共用同一套函式與同一個無風險利率來源。
  const WINDOWS: Array<{ years: number; period: "1Y" | "3Y" | "5Y" }> = [{ years: 1, period: "1Y" }, { years: 3, period: "3Y" }, { years: 5, period: "5Y" }];
  let calculatedFundRisk: { period: string; value: number; label: string; observationCount: number }[] = [];
  let fundRiskMethodNote: string | null = null;
  {
    const riskFreeSource = RISK_FREE_RATE_SOURCES[row.currency ?? ""];
    let riskFreeRatePct: number | null = null;
    if (riskFreeSource) {
      const rfr = await prisma.$queryRawUnsafe<{ value: unknown }[]>(
        `SELECT value FROM treasury_fiscal_observations WHERE metric_code = $1 ORDER BY observation_date DESC LIMIT 1`,
        riskFreeSource.metricCode,
      );
      riskFreeRatePct = rfr[0]?.value != null ? Number(rfr[0].value) : null;
    }
    let anyCalculated = false;
    let anyFailedWithStaleRfZero = false;
    for (const w of WINDOWS) {
      const cutoff = new Date(Date.UTC(new Date().getUTCFullYear() - w.years, new Date().getUTCMonth(), new Date().getUTCDate()));
      const hasOfficialVolatility = riskMetrics.some((m) => new RegExp(`VOLATIL.*_${w.period}$|_${w.period}.*VOLATIL`, "i").test(m.metricCode));
      const navPoints = riskCalcHistoryRows.filter((r) => r.date >= cutoff && r.nav != null).map((r) => ({ date: r.date, close: Number(r.nav) }));
      const calc = calculateVolatilityAndSharpe(navPoints, riskFreeRatePct);
      if (!hasOfficialVolatility && calc.volatility1yPct != null) { calculatedFundRisk.push({ period: w.period, value: calc.volatility1yPct, label: `VOLATILITY_${w.period}（本App計算）`, observationCount: calc.observationCount }); anyCalculated = true; }
      if (calc.sharpe1y != null) { calculatedFundRisk.push({ period: w.period, value: calc.sharpe1y, label: `SHARPE_${w.period}（本App計算，取代RF=0的舊算法）`, observationCount: calc.observationCount }); anyCalculated = true; }
      else if (riskMetrics.some((m) => new RegExp(`SHARPE.*_${w.period}$|_${w.period}.*SHARPE`, "i").test(m.metricCode) && m.calculationMethod === "SHARPE_RF_ZERO")) anyFailedWithStaleRfZero = true;
    }
    if (anyCalculated) {
      fundRiskMethodNote = `${RISK_CALC_METHOD_LABEL}${riskFreeSource ? `無風險利率來源：${riskFreeSource.label}。` : "此幣別尚無官方無風險利率自動化來源，Sharpe暫不計算。"}`;
    } else if (anyFailedWithStaleRfZero) {
      // 有舊的RF=0版本，但重算失敗（例如價格資料不足20筆）——不留誤導性的RF=0舊值在畫面上。
      fundRiskMethodNote = riskFreeSource ? "資料不足以重新計算Sharpe（需至少20個交易日的真實NAV）" : "此幣別尚無官方無風險利率自動化來源，Sharpe暫不計算";
    }
  }
  // 舊版RF=0的SHARPE_1Y/3Y/5Y一律從既有riskMetrics拿掉，避免跟上面重新計算的版本同時顯示在畫面上。
  const filteredRiskMetrics = riskMetrics.filter((m) => !(/SHARPE.*_(1Y|3Y|5Y)$|_(1Y|3Y|5Y).*SHARPE/i.test(m.metricCode) && m.calculationMethod === "SHARPE_RF_ZERO"));

  const chronologicalHistory = historyRows.toReversed();
  const sampledHistory = chronologicalHistory.length <= FUND_DETAIL_LIMITS.history
    ? chronologicalHistory
    : Array.from({ length: FUND_DETAIL_LIMITS.history }, (_, index) => chronologicalHistory[Math.round(index * (chronologicalHistory.length - 1) / (FUND_DETAIL_LIMITS.history - 1))]);
  const data: FundDetailData = {
    identity: { ...fundIdentity(row), isin: row.isin, code: row.code }, company: row.company.trim() || null, assetClass: classificationAssetClass, category: row.category, fundCategory: mapFundMainCategory(row.category), fundSubcategory: row.category, riskRating: row.riskLevel, dividendYield: numberOrNull(row.dividendYieldA),
    // 2026-10-21（使用者核准）: VERIFIED live -- a fund still approved for sale (e.g. TDCC's own
    // dataset 3-2 confirms it today) can have a share class that has NEVER had the source publish a
    // single NAV for it at all (latestNav AND latestNavDate both null -- not "went stale after
    // reporting once", genuinely zero history ever). Reuses the existing SOURCE_PENDING coverage
    // state (same one "Fund Flows" already uses) so the UI shows "官方尚未申報淨值" instead of a
    // bare dash that reads the same as any other missing-data case. A fund that reported before and
    // then went stale (latestNavDate is set, just old) is a different, already-handled case and
    // stays UNAVAILABLE here -- distinguishing the two is the whole point of this fix.
    nav: { coverage: row.latestNav !== null ? "AVAILABLE" : row.latestNavDate === null ? "SOURCE_PENDING" : "UNAVAILABLE", data: { value: numberOrNull(row.latestNav), currency: row.currency, date: isoOrNull(row.latestNavDate) }, provenance },
    history: { coverage: sectionCoverage(historyRows.length, historyRows.length < 2), range, maxPoints: FUND_DETAIL_LIMITS.history, data: sampledHistory.map((item) => ({ date: item.date.toISOString(), nav: numberOrNull(item.nav) })), provenance: historyProvenance },
    performance: { coverage: latestReturns && [latestReturns.return1m, latestReturns.return3m, latestReturns.return6m, latestReturns.returnYtd, latestReturns.return1y, latestReturns.return3y, latestReturns.return5y].some((value) => value !== null) ? "AVAILABLE" : "UNAVAILABLE", data: { return1M: numberOrNull(latestReturns?.return1m), return3M: numberOrNull(latestReturns?.return3m), return6M: numberOrNull(latestReturns?.return6m), returnYtd: numberOrNull(latestReturns?.returnYtd), return1Y: numberOrNull(latestReturns?.return1y), return3YAnnualized: numberOrNull(latestReturns?.return3y), return5YAnnualized: numberOrNull(latestReturns?.return5y), semantics: "NAV_RETURN" }, provenance: performanceProvenance },
    // 2026-10-29（VERIFIED，順手修正）: 原本item.asOfDate.toISOString()假設一定有日期，但
    // fund_risk_metrics裡sharpe_3y/std_dev_3y這批Yahoo一次性回填的資料as_of_date全部是null，
    // 呼叫.toISOString()會直接丟錯誤——目前核心母體基金剛好沒有命中這個組合（抽查0筆），所以
    // 還沒在正式環境爆出來，但是個真的bug，順手用?. 防呆，不等它真的命中才修。
    riskMetrics: { coverage: sectionCoverage(filteredRiskMetrics.length + calculatedFundRisk.length), data: [
      ...filteredRiskMetrics.map((item) => ({ metricCode: item.metricCode, period: item.period, value: Number(item.value), asOfDate: item.asOfDate?.toISOString() ?? null, calculationMethod: item.calculationMethod, observationCount: item.observationCount, source: item.source, returnSemantics: item.returnSemantics })),
      ...calculatedFundRisk.map((item) => ({ metricCode: item.label, period: item.period, value: item.value, asOfDate: null, calculationMethod: fundRiskMethodNote ?? "本App計算", observationCount: item.observationCount, source: "SMARTMATCH_CALCULATED", returnSemantics: null })),
    ], provenance: buildProvenance({ source: riskLatest?.source ?? (calculatedFundRisk.length ? "SMARTMATCH_CALCULATED" : undefined), sourceRecordId: riskLatest?.id, asOfDate: riskLatest?.asOfDate, lastUpdated: riskLatest?.updatedAt }) },
    shareClasses: { coverage: sectionCoverage(shareClasses.length, shareClasses.length > 0), data: shareClasses.map((item) => ({ id: item.id, name: item.shareClassName, code: item.shareClassCode, isin: item.isin, currency: item.currency, distributionType: item.distributionType, accumulationDistribution: item.accumulatingDistributing, hedged: item.hedged, hedgedCurrency: item.hedgedCurrency, investorType: item.institutionalRetail, source: item.source })), provenance: buildProvenance({ source: shareLatest?.source, sourceRecordId: shareLatest?.sourceRecordId, asOfDate: shareLatest?.termsAsOfDate, lastUpdated: shareLatest?.updatedAt }) },
    feesTerms: { coverage: sectionCoverage(fees.length, fees.some((item) => Object.values(item).some((value) => value === null))), data: fees, provenance: buildProvenance({ source: shareLatest?.termsSource ?? shareLatest?.source ?? source, sourceRecordId: shareLatest?.termsSourceRecordId, asOfDate: shareLatest?.termsAsOfDate ?? row.latestNavDate, lastUpdated: shareLatest?.updatedAt ?? row.updatedAt }) },
    classifications: { coverage: sectionCoverage(classifications.length, classifications.length > 0), data: classifications.map((item) => ({ type: item.classificationType, name: item.classificationName, value: item.classificationValue, method: item.classificationMethod, benchmarkName: item.benchmarkName, benchmarkCode: item.benchmarkCode, benchmarkId: item.benchmarkId, source: item.source, asOfDate: isoOrNull(item.asOfDate) })), provenance: buildProvenance({ source: classificationLatest?.source, sourceRecordId: classificationLatest?.sourceRecordId, asOfDate: classificationLatest?.asOfDate, lastUpdated: classificationLatest?.updatedAt }) },
    holdings: nameOnlyHoldings.length
      ? { coverage: sectionCoverage(nameOnlyHoldings.length), data: { reportDate: isoOrNull(nameOnlyHoldings[0].as_of_date), staleWarning: holdingsStaleWarning(isoOrNull(nameOnlyHoldings[0].as_of_date)), items: nameOnlyHoldings.map((item) => ({ holdingName: item.holding_name, securityId: null, weight: null, marketValue: null, currency: null, source: item.source, weightDisclosed: false })) }, provenance: buildProvenance({ source: nameOnlyHoldings[0].source, sourceRecordId: row.id, asOfDate: nameOnlyHoldings[0].as_of_date, lastUpdated: nameOnlyHoldings[0].updated_at }) }
      : { coverage: sectionCoverage(dedupedHoldings.length), data: { reportDate: isoOrNull(holdingLatest?.report_date), staleWarning: holdingsStaleWarning(isoOrNull(holdingLatest?.report_date)), items: dedupedHoldings.map((item) => ({ holdingName: item.holding_name, securityId: item.security_id, weight: numberOrNull(item.weight), marketValue: numberOrNull(item.market_value), currency: item.currency, source: item.source, weightDisclosed: true })) }, provenance: buildProvenance({ source: holdingLatest?.source, sourceRecordId: row.id, asOfDate: holdingLatest?.report_date, lastUpdated: holdingLatest?.updated_at }) },
    documents: { coverage: sectionCoverage(documents.length, documents.length > 0), data: documents.map((item) => ({ type: item.documentType, title: item.documentTitle, date: isoOrNull(item.documentDate ?? item.effectiveDate), language: item.language, url: item.url, source: item.source })), provenance: buildProvenance({ source: documentLatest?.source, sourceRecordId: documentLatest?.sourceRecordId, asOfDate: documentLatest?.documentDate ?? documentLatest?.effectiveDate, lastUpdated: documentLatest?.updatedAt }) },
    sectorAllocation: { coverage: sectionCoverage(sectorAllocationRows.length), data: sectorAllocationRows.map((r) => ({ label: r.classification_code, weight: Number(r.classification_value) })), asOfDate: isoOrNull(sectorAllocationRows[0]?.as_of_date), provenance: buildProvenance({ source: "YAHOO_FUND_HOLDINGS_PAGE", sourceRecordId: row.id, asOfDate: sectorAllocationRows[0]?.as_of_date, lastUpdated: sectorAllocationRows[0]?.as_of_date }) },
    regionAllocation: { coverage: sectionCoverage(regionAllocationRows.length), data: regionAllocationRows.map((r) => ({ label: r.classification_code, weight: Number(r.classification_value) })), asOfDate: isoOrNull(regionAllocationRows[0]?.as_of_date), provenance: buildProvenance({ source: "YAHOO_FUND_HOLDINGS_PAGE", sourceRecordId: row.id, asOfDate: regionAllocationRows[0]?.as_of_date, lastUpdated: regionAllocationRows[0]?.as_of_date }) },
    managers: { coverage: sectionCoverage(managerRows.length), data: managerRows.map((m) => ({ name: m.name, role: m.role, startDate: isoOrNull(m.start_date) })), provenance: buildProvenance({ source: "YAHOO_FUND_HOLDINGS_PAGE", sourceRecordId: row.id, asOfDate: managerRows[0]?.start_date, lastUpdated: managerRows[0]?.start_date }) },
    flows: { coverage: "SOURCE_PENDING", data: null, provenance: buildProvenance({}) },
    monthlyDisclosure: {
      coverage: aumDisclosureRows.length || feeDisclosureRows.length ? "AVAILABLE" : "UNAVAILABLE",
      data: {
        yearMonth: aumDisclosureRows[0]?.year_month ?? feeDisclosureRows[0]?.year_month ?? null,
        aumTwd: numberOrNull(aumDisclosureRows[0]?.aum_twd),
        navTwd: numberOrNull(aumDisclosureRows[0]?.nav_twd),
        totalHolders: aumDisclosureRows[0]?.total_holders ?? null,
        subscriptionTwd: numberOrNull(aumDisclosureRows[0]?.subscription_twd),
        redemptionTwd: numberOrNull(aumDisclosureRows[0]?.redemption_twd),
        mgmtFeePct: numberOrNull(feeDisclosureRows[0]?.mgmt_fee_pct),
        custodianFeePct: numberOrNull(feeDisclosureRows[0]?.custodian_fee_pct),
        totalFeePct: numberOrNull(feeDisclosureRows[0]?.total_fee_pct),
        aumSource: aumDisclosureRows[0]?.source ?? null,
      },
      provenance: buildProvenance({ source: aumDisclosureRows[0]?.source ?? "SITCA_IN2201_IN2211", sourceRecordId: row.id, asOfDate: yearMonthToDate(aumDisclosureRows[0]?.year_month ?? feeDisclosureRows[0]?.year_month), lastUpdated: row.updatedAt }),
    },
    annualMetricsFundclear: {
      coverage: sectionCoverage(annualMetricsRows.length),
      data: annualMetricsRows.map((r) => ({ year: r.year, returnPct: numberOrNull(r.return_pct), feeRatePct: numberOrNull(r.fee_rate_pct), returnSource: r.return_source })),
      provenance: buildProvenance({ source: "FUNDCLEAR_QUERY_RATE", sourceRecordId: row.id, asOfDate: annualMetricsRows[0]?.year ? `${annualMetricsRows[0].year}-12-31` : undefined, lastUpdated: row.updatedAt }),
    },
    offshoreScaleTdcc: {
      coverage: sectionCoverage(offshoreScaleRows.length),
      data: {
        scaleAmountMillions: numberOrNull(offshoreScaleRows[0]?.scale_amount_millions),
        scaleCurrency: offshoreScaleRows[0]?.scale_currency ?? null,
        scaleAsOfDate: isoOrNull(offshoreScaleRows[0]?.scale_as_of_date),
      },
      provenance: buildProvenance({ source: "TDCC_OPENDATA_3-2", sourceRecordId: row.id, asOfDate: offshoreScaleRows[0]?.scale_as_of_date, lastUpdated: row.updatedAt }),
    },
    offshoreTwHolding: {
      coverage: sectionCoverage(offshoreTwHoldingRows.length),
      data: {
        twHoldingTwd: numberOrNull(offshoreTwHoldingRows[0]?.tw_holding_twd),
        twHoldingPct: numberOrNull(offshoreTwHoldingRows[0]?.tw_holding_pct),
        yearMonth: offshoreTwHoldingRows[0]?.year_month ?? null,
      },
      provenance: buildProvenance({ source: "FUNDCLEAR_QUERY_FUND_REPORT", sourceRecordId: row.id, asOfDate: yearMonthToDate(offshoreTwHoldingRows[0]?.year_month), lastUpdated: row.updatedAt }),
    },
  };
  if (data.company && /^(待補|unknown|n\/a)/i.test(data.company)) data.company = null;
  const meta: ResponseMeta = { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" };
  return { data, meta, pagination: null, error: null };
}

export async function getFundHistory(identifier: string, query: HistoryQuery = {}): Promise<ServiceResponse<Array<{ date: string; nav: number | null; aum: number | null; return1M: number | null; return3M: number | null; return1Y: number | null }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const fund = await prisma.fund.findFirst({ where: { OR: [{ id: identifier }, { code: { equals: identifier, mode: "insensitive" } }, { isin: { equals: identifier, mode: "insensitive" } }] }, select: { id: true, lastNavSource: true, dataSource: true, dataProvider: true } });
  if (!fund) throw new WebDataError("NOT_FOUND", "Fund not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = { fundId: fund.id, date: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) } };
  const [total, rows] = await prisma.$transaction([prisma.fundHistory.count({ where }), prisma.fundHistory.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { date: "desc" } })]);
  const source = fund.lastNavSource ?? fund.dataSource ?? fund.dataProvider;
  const provenance = buildProvenance({ source, asOfDate: rows[0]?.date, lastUpdated: rows[0]?.createdAt });
  return { data: rows.map((row) => ({ date: row.date.toISOString(), nav: numberOrNull(row.nav), aum: numberOrNull(row.aum), return1M: numberOrNull(row.return1m), return3M: numberOrNull(row.return3m), return1Y: numberOrNull(row.return1y) })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(rows[0]?.date, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.date.toISOString() ?? null : null), error: null };
}


