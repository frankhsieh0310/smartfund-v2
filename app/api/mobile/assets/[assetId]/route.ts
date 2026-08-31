import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERIOD_DAYS = {
  '1M': 31,
  '3M': 93,
  '6M': 186,
  '1Y': 366,
  '3Y': 1096,
  '5Y': 1827,
  '10Y': 3653,
  MAX: null,
} as const;

type Period = keyof typeof PERIOD_DAYS;
type SupportedAssetType = 'ETF' | 'FUND';

const numberOrNull = (value: unknown) => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const fromFor = (period: Period) => {
  const days = PERIOD_DAYS[period];
  return days === null ? undefined : new Date(Date.now() - days * 86_400_000);
};

const responseMeta = (asOfDate: Date | null, lastUpdated: Date | null, source: string | null, hasData: boolean) => ({
  asOfDate: asOfDate?.toISOString() ?? null,
  lastUpdated: lastUpdated?.toISOString() ?? null,
  freshnessStatus: asOfDate ? 'CURRENT' : 'UNKNOWN',
  source,
  coverageStatus: hasData ? 'FULL' : 'UNKNOWN',
});

const apiError = (status: number, code: string, message: string) =>
  Response.json({ data: null, meta: null, error: { code, message } }, { status });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId: encodedAssetId } = await params;
  const assetId = decodeURIComponent(encodedAssetId).trim();
  const searchParams = new URL(request.url).searchParams;
  const assetType = searchParams.get('type')?.toUpperCase() as SupportedAssetType | undefined;
  const periodValue = searchParams.get('period')?.toUpperCase();

  if (!assetId) return apiError(400, 'INVALID_ASSET_ID', 'An asset ID is required.');
  if (assetType !== 'ETF' && assetType !== 'FUND') {
    return apiError(400, 'UNSUPPORTED_ASSET_TYPE', 'This deployment candidate supports ETF and FUND assets.');
  }
  if (!periodValue || !(periodValue in PERIOD_DAYS)) {
    return apiError(400, 'INVALID_PERIOD', 'period must be one of 1M, 3M, 6M, 1Y, 3Y, 5Y, 10Y, or MAX.');
  }

  const period = periodValue as Period;
  const from = fromFor(period);

  try {
    if (assetType === 'ETF') {
      const etf = await prisma.etf.findFirst({
        where: {
          OR: [
            { id: assetId },
            { code: { equals: assetId, mode: 'insensitive' } },
            { isin: { equals: assetId, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          code: true,
          name: true,
          currency: true,
          exchange: true,
          region: true,
          dataSource: true,
          dataProvider: true,
          provider: true,
          updatedAt: true,
          history: {
            where: {
              ...(from ? { date: { gte: from } } : {}),
              OR: [{ price: { not: null } }, { nav: { not: null } }],
            },
            orderBy: { date: 'asc' },
            take: 5000,
            select: { date: true, price: true, nav: true, createdAt: true },
          },
        },
      });

      if (!etf) return apiError(404, 'NOT_FOUND', 'ETF not found.');
      const points = etf.history.flatMap((row) => {
        const value = numberOrNull(row.price ?? row.nav);
        return value == null ? [] : [{ date: row.date.toISOString(), value }];
      });
      const latest = etf.history.at(-1);
      const source = etf.dataSource ?? etf.dataProvider ?? etf.provider;
      return Response.json({
        data: {
          identity: { assetType: 'ETF', id: etf.id, symbol: etf.code, name: etf.name, displayName: etf.name, currency: etf.currency, market: etf.exchange, country: etf.region },
          period,
          points,
        },
        meta: responseMeta(latest?.date ?? null, latest?.createdAt ?? etf.updatedAt, source, points.length > 0),
        error: null,
      });
    }

    const fund = await prisma.fund.findFirst({
      where: {
        OR: [
          { id: assetId },
          { code: { equals: assetId, mode: 'insensitive' } },
          { isin: { equals: assetId, mode: 'insensitive' } },
          { name: { equals: assetId, mode: 'insensitive' } },
          { nameEn: { equals: assetId, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        code: true,
        isin: true,
        name: true,
        currency: true,
        company: true,
        region: true,
        dataSource: true,
        dataProvider: true,
        lastNavSource: true,
        updatedAt: true,
        history: {
          where: { ...(from ? { date: { gte: from } } : {}), nav: { not: null } },
          orderBy: { date: 'asc' },
          take: 5000,
          select: { date: true, nav: true, createdAt: true },
        },
      },
    });

    if (!fund) return apiError(404, 'NOT_FOUND', 'Fund not found.');
    const points = fund.history.flatMap((row) => {
      const value = numberOrNull(row.nav);
      return value == null ? [] : [{ date: row.date.toISOString(), value }];
    });
    const latest = fund.history.at(-1);
    const source = fund.dataSource ?? fund.dataProvider ?? fund.lastNavSource;
    return Response.json({
      data: {
        identity: { assetType: 'FUND', id: fund.id, symbol: fund.code ?? fund.isin ?? fund.id, name: fund.name, displayName: fund.name, currency: fund.currency, market: fund.company, country: fund.region },
        period,
        points,
      },
      meta: responseMeta(latest?.date ?? null, latest?.createdAt ?? fund.updatedAt, source, points.length > 0),
      error: null,
    });
  } catch (error) {
    console.error('Mobile asset API read failed', error);
    return apiError(500, 'INTERNAL_ERROR', 'Unable to read asset data.');
  }
}
