import { prisma } from '@/lib/prisma';

/**
 * Returns only financial facts that were knowable at `asKnownAt`.
 * Period end alone is never treated as publication evidence.
 */
export async function getStockFinancialFactsAsKnownAt(
  stockId: string,
  asKnownAt: Date,
) {
  return prisma.stockFinancialFact.findMany({
    where: {
      stockId,
      OR: [
        { publicationDate: { lte: asKnownAt } },
        {
          publicationDate: null,
          filingDate: { lte: asKnownAt },
        },
      ],
    },
    orderBy: [
      { periodEnd: 'desc' },
      { publicationDate: 'desc' },
      { filingDate: 'desc' },
    ],
  });
}
