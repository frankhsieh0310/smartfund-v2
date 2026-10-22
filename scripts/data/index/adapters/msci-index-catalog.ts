import { PrismaClient } from "@prisma/client";

const SOURCE_URL = "https://www.msci.com/indexes";

function extractJsonObject(text: string, marker: string) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("MSCI_CATALOG_STATE_NOT_FOUND");
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("MSCI_CATALOG_STATE_TRUNCATED");
}

export function parseMsciCatalogHtml(html: string) {
  const chunks: string[] = [];
  for (const match of html.matchAll(/<script>self\.__next_f\.push\((.*?)\)<\/script>/gs)) {
    try { const frame = JSON.parse(match[1]); if (typeof frame?.[1] === "string") chunks.push(frame[1]); } catch { /* unrelated Flight frame */ }
  }
  const chunk = chunks.find(value => value.includes("totalNumberOfDisplayedIndexes"));
  if (!chunk) throw new Error("MSCI_CATALOG_FLIGHT_PAYLOAD_NOT_FOUND");
  const state = extractJsonObject(chunk, '{"dehydratedAt"');
  return { rows: state.state.data.data as any[], page: state.state.data.page as number[], total: Number(state.state.data.total), queryKey: state.queryKey };
}

export async function ingestMsciCatalogCanary(prisma: PrismaClient) {
  const response = await fetch(SOURCE_URL, { headers: { "user-agent": "Mozilla/5.0 SmartFundResearch/2.0" } });
  if (!response.ok) throw new Error(`MSCI_CATALOG_HTTP_${response.status}`);
  const parsed = parseMsciCatalogHtml(await response.text());
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS global_index_provider_catalog(
    provider text NOT NULL, provider_index_code text NOT NULL, provider_index_id text, index_name text NOT NULL,
    asset_class text, category text, index_type text, inception_date date, launch_date date, calculation_date date,
    sizes jsonb NOT NULL DEFAULT '[]', markets jsonb NOT NULL DEFAULT '[]', currencies jsonb NOT NULL DEFAULT '[]', variants jsonb NOT NULL DEFAULT '[]',
    taxonomy_groups jsonb NOT NULL DEFAULT '[]', taxonomy_categories jsonb NOT NULL DEFAULT '[]', taxonomy_region jsonb NOT NULL DEFAULT '[]',
    region jsonb, country jsonb, reference_index_codes jsonb NOT NULL DEFAULT '[]', parent_index_codes jsonb NOT NULL DEFAULT '[]',
    description text, featured boolean NOT NULL DEFAULT false, ranking integer, universe_source jsonb,
    source_url text NOT NULL, verification_status text NOT NULL, rights_status text NOT NULL, materiality_status text NOT NULL,
    source_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(provider,provider_index_code))`);
  for (const row of parsed.rows) {
    const categories = row.taxonomyCategories ?? [];
    const category = categories.some((x:string)=>/market cap/i.test(x)) ? "MARKET_CAP" : categories.some((x:string)=>/factor/i.test(x)) ? "FACTOR" : categories.some((x:string)=>/thematic/i.test(x)) ? "THEMATIC" : categories.some((x:string)=>/climate/i.test(x)) ? "CLIMATE" : categories.some((x:string)=>/sustainability|esg/i.test(x)) ? "SUSTAINABILITY" : categories.some((x:string)=>/custom/i.test(x)) ? "CUSTOM" : "OTHER";
    await prisma.$executeRawUnsafe(`INSERT INTO global_index_provider_catalog(provider,provider_index_code,provider_index_id,index_name,asset_class,category,index_type,inception_date,launch_date,calculation_date,sizes,markets,currencies,variants,taxonomy_groups,taxonomy_categories,taxonomy_region,region,country,reference_index_codes,parent_index_codes,description,featured,ranking,universe_source,source_url,verification_status,rights_status,materiality_status,source_payload)
      VALUES('MSCI',$1,$2,$3,$4,$5,$6,$7::date,$8::date,$9::date,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24::jsonb,$25,'VERIFIED_OFFICIAL_EXPLORER','NON_COMMERCIAL_INTERNAL_RESEARCH_ONLY',$26,$27::jsonb)
      ON CONFLICT(provider,provider_index_code) DO UPDATE SET provider_index_id=EXCLUDED.provider_index_id,index_name=EXCLUDED.index_name,asset_class=EXCLUDED.asset_class,category=EXCLUDED.category,index_type=EXCLUDED.index_type,inception_date=EXCLUDED.inception_date,launch_date=EXCLUDED.launch_date,calculation_date=EXCLUDED.calculation_date,sizes=EXCLUDED.sizes,markets=EXCLUDED.markets,currencies=EXCLUDED.currencies,variants=EXCLUDED.variants,taxonomy_groups=EXCLUDED.taxonomy_groups,taxonomy_categories=EXCLUDED.taxonomy_categories,taxonomy_region=EXCLUDED.taxonomy_region,region=EXCLUDED.region,country=EXCLUDED.country,reference_index_codes=EXCLUDED.reference_index_codes,parent_index_codes=EXCLUDED.parent_index_codes,description=EXCLUDED.description,featured=EXCLUDED.featured,ranking=EXCLUDED.ranking,universe_source=EXCLUDED.universe_source,source_payload=EXCLUDED.source_payload,updated_at=now()`,
      String(row.indexCode),row.indexId??null,row.indexName,row.assetClass??null,category,row.indexType??null,row.indexInceptionDate??null,row.launchDate??null,row.calcDate??null,JSON.stringify(row.sizes??[]),JSON.stringify(row.markets??[]),JSON.stringify(row.currencies??[]),JSON.stringify(row.variants??[]),JSON.stringify(row.taxonomyGroups??[]),JSON.stringify(categories),JSON.stringify(row.taxonomyRegion??[]),JSON.stringify(row.region??null),JSON.stringify(row.country??null),JSON.stringify(row.referenceIndexCodes??[]),JSON.stringify(row.parentIndexCodes??[]),row.indexDescription??null,Boolean(row.featured),row.ranking??null,JSON.stringify(row.universeSource??null),SOURCE_URL,row.featured?"CORE_MATERIAL":"CATALOG_ONLY",JSON.stringify({identityMetadataOnly:true,performanceValuesPersisted:false}));
  }
  const [readback] = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(DISTINCT provider_index_code)::int unique_codes,count(*) FILTER(WHERE jsonb_array_length(variants)>0)::int with_variants FROM global_index_provider_catalog WHERE provider='MSCI'`);
  return { sourceDenominator: parsed.total, page: parsed.page, persisted: parsed.rows.length, readback, nextPage: 2, checkpoint: `MSCI_EXPLORER_CANARY_PAGE_1_OF_${Math.ceil(parsed.total/20)}_CLIENT_ACTION_REQUIRED` };
}
