export type WebDataCacheDomain = "MARKET" | "PUBLICATION" | "REFERENCE";

export const WEB_DATA_CACHE_POLICY: Record<WebDataCacheDomain, { seconds: number; strategy: string }> = {
  MARKET: { seconds: 60, strategy: "MARKET_AWARE_SHORT" },
  PUBLICATION: { seconds: 900, strategy: "PUBLICATION_AWARE" },
  REFERENCE: { seconds: 3600, strategy: "CONSERVATIVE_REFERENCE" },
};

export const cacheControlFor = (domain: WebDataCacheDomain) =>
  `public, s-maxage=${WEB_DATA_CACHE_POLICY[domain].seconds}, stale-while-revalidate=${WEB_DATA_CACHE_POLICY[domain].seconds * 2}`;
