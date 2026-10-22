export const adapterKinds = [
  "XBRL_CORPORATE_DISCLOSURE_ADAPTER",
  "REGULATORY_FILING_API_ADAPTER",
  "STRUCTURED_EXCHANGE_DISCLOSURE_ADAPTER",
  "PUBLIC_COMPANY_REGISTRY_ADAPTER",
  "STOCK_POSITIONING_OFFICIAL_ADAPTER",
  "PUBLIC_DOCUMENT_EVENT_ADAPTER",
  "VERIFIED_THEME_EVIDENCE_ADAPTER"
] as const;

export type AdapterKind = typeof adapterKinds[number];
export type PublicRoute = {
  id: string;
  markets: string[];
  adapter: AdapterKind;
  officialSources: string[];
  domains: string[];
  state: "READY" | "WAITING_DEPENDENCY_API_KEY" | "INPUT_GATED_AUTO_CONTINUING";
  fullEligibleUniverse: boolean;
  deepestReliablePublicHistory: boolean;
  incremental: boolean;
  scheduledRefresh: boolean;
  sourcePriority: "DIRECT_REGULATOR" | "OFFICIAL_EXCHANGE" | "ISSUER" | "PUBLIC_SUPPLEMENTAL";
  checkpoint: string;
  notes?: string;
};

export function validateRoutes(routes: PublicRoute[]): void {
  const ids = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) throw new Error(`DUPLICATE_PUBLIC_ROUTE:${route.id}`);
    if (!adapterKinds.includes(route.adapter)) throw new Error(`UNKNOWN_COMMON_ADAPTER:${route.id}`);
    if (!route.officialSources.length || !route.domains.length) throw new Error(`INCOMPLETE_PUBLIC_ROUTE:${route.id}`);
    if (!route.checkpoint.startsWith("runtime/stock-public-source-expansion/checkpoints/")) throw new Error(`CHECKPOINT_NOT_ISOLATED:${route.id}`);
    ids.add(route.id);
  }
}
