import type { PrismaClient } from "@prisma/client";

type Db = PrismaClient;

export type FundHoldingsResolution = {
  requestedFundId: string;
  masterFundId: string | null;
  resolutionStatus: "DIRECT" | "INHERITED_FROM_MASTER" | "HOLDINGS_UNAVAILABLE";
  source: string | null;
  asOfDate: Date | null;
  completeness: string | null;
  holdings: Array<Record<string, unknown>>;
};

function clean(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").toLowerCase()
    .replace(/\([^)]*(?:本基金|配息來源|未申報|已撤銷)[^)]*\)/g, "")
    .replace(/（[^）]*(?:本基金|配息來源|未申報|已撤銷)[^）]*）/g, "")
    .replace(/臺/g, "台");
}

export function providerKey(value: string | null | undefined) {
  return clean(value)
    .replace(/待補.*發行機構資訊.*/g, "")
    .replace(/allianzglobalinvestors|安聯環球投資基金/g, "安聯")
    .replace(/blackrockglobalfunds|貝萊德全球基金/g, "貝萊德")
    .replace(/fidelityfunds|富達基金/g, "富達")
    .replace(/jpmorganfunds|摩根基金/g, "摩根")
    .replace(/股份有限公司|有限公司|投資信託股份|證券投資信託|投資信託|投信|資產管理|assetmanagement|investmentmanagement|investments?/g, "")
    .replace(/[\s\-_,.()（）/／:]/g, "");
}

export function portfolioKey(value: string | null | undefined) {
  return clean(value)
    .replace(/(?:class\s*)?[a-z]{1,4}\d{0,3}(?=(?:累積|配息|月配|分配|美元|美金|歐元|澳幣|南非幣|日圓|人民幣|台幣|新台幣|避險|不避險))/gi, "")
    .replace(/(?:class\s*[a-z0-9-]+|[a-z]{1,4}\d{0,3}\s*(?:class|shares?|類|級|股|股份))/gi, "")
    .replace(/\b(?:usd|eur|aud|zar|twd|jpy|cnh|cny)\b|新?台幣|美元|美金|歐元|澳幣|南非幣|日圓|日幣|(?:離岸)?人民幣|計價/g, "")
    .replace(/未避險|不避險|非避險|unhedged|避險|對沖|hedged/g, "")
    .replace(/每月配息|每月分配|穩定月配息|月配息?|配息型?|分配型?|distribution|distributing|dist\b|累積型?|不配息|不分配|accumulating|acc\b/g, "")
    .replace(/前收|後收|front.?load|back.?load/g, "")
    .replace(/(?:h\d+|[a-z]{1,4}\d{0,3})(?:股|類|級|股份)?(?=$|[\s\-)）])/gi, "")
    .replace(/類型|級別/g, "")
    .replace(/(?:第[一二三四五六七八九十]+類股|[a-z]{1,4}\d{0,3}(?:股|類|級|股份)?)(?=$|[\s\-)）])/gi, "")
    .replace(/(?:^|[\s\-(（])(?:[a-z]{1,3}\d{0,3})(?:類|級|股|股份)?(?=$|[\s\-)）])/gi, " ")
    .replace(/[a-z]{1,3}\d{0,3}(?=(?:累積|配息|月配|美元|歐元|澳幣|南非幣|避險))/gi, "")
    .replace(/soci[eé]t[eé]dinvestissement[aà]capitalvariable|sicav|publiclimitedcompany|plc|limited|ltd|incorporated|inc/g, "")
    .replace(/[\s\-_,.()（）/／:。，]/g, "");
}

export function deterministicMasterKey(fund: { company: string; name: string; legal_name: string | null; name_en: string | null }) {
  return `${providerKey(fund.company)}|${portfolioKey(fund.legal_name || fund.name_en || fund.name)}`;
}

function candidatePoolKey(fund: { company: string; name: string; legal_name: string | null; name_en: string | null }) {
  return deterministicMasterKey(fund).replace(/基金|funds?|portfolio|系列/g, "").replace(/[a-z]{1,3}\d{0,3}$/i, "");
}

function shareClassFingerprint(fund: { name:string; currency?:string|null; distribution_freq?:string|null }) {
  const name = clean(fund.name);
  const match = name.match(/(?:class\s*)?([a-z]{1,4}\d{0,3})(?=(?:累積|配息|月配|分配|美元|歐元|澳幣|南非幣|避險|不避險))/i)
    ?? name.match(/(?:class\s*([a-z0-9-]+)|([a-z]{1,4}\d{0,3})\s*(?:class|shares?|類|級|股|股份))/i);
  const family = (match?.[1] ?? match?.[2] ?? "").toLowerCase();
  const distribution = fund.distribution_freq || (/累積|不配息|accum/i.test(name) ? "ACC" : /配息|分配|distribut|dist/i.test(name) ? "DIST" : "UNKNOWN");
  const hedge = /未避險|不避險|unhedged/i.test(name) ? "UNHEDGED" : /避險|hedged/i.test(name) ? "HEDGED" : "UNKNOWN";
  return `${(fund.currency ?? "").toUpperCase()}|${distribution.toUpperCase()}|${hedge}|${family}`;
}

async function snapshot(db: Db, fundId: string, shareClassId: string | null) {
  const candidates = await db.$queryRawUnsafe<Array<{ source:string; filing_id:string; as_of_date:Date; completeness:string|null; rows:number }>>(
    `SELECT source,filing_id,as_of_date,min(weight_method) completeness,count(*)::int rows
     FROM holdings WHERE fund_id=$1 AND share_class_id IS NOT DISTINCT FROM $2
     GROUP BY source,filing_id,as_of_date ORDER BY as_of_date DESC,rows DESC LIMIT 1`, fundId, shareClassId,
  );
  const selected = candidates[0];
  if (!selected) return null;
  const holdings = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM holdings WHERE fund_id=$1 AND share_class_id IS NOT DISTINCT FROM $2 AND source=$3 AND filing_id=$4 ORDER BY rank NULLS LAST,id`,
    fundId, shareClassId, selected.source, selected.filing_id,
  );
  return { ...selected, holdings };
}

export async function resolveFundHoldings(db: Db, fundId: string, shareClassId: string | null = null): Promise<FundHoldingsResolution> {
  const funds = await db.$queryRawUnsafe<Array<{id:string;company:string;name:string;legal_name:string|null;name_en:string|null;currency:string|null;distribution_freq:string|null}>>(
    `SELECT id,company,name,legal_name,name_en,currency,distribution_freq FROM funds WHERE is_active=true`,
  );
  const requested = funds.find((fund) => fund.id === fundId);
  if (!requested) throw new Error(`FUND_NOT_FOUND:${fundId}`);
  const key = deterministicMasterKey(requested);
  const groupIds = funds.filter((fund) => deterministicMasterKey(fund) === key).map((fund) => fund.id);
  const [groupMaster] = await db.$queryRawUnsafe<Array<{fund_id:string}>>(
    `SELECT fund_id FROM holdings WHERE fund_id=ANY($1::text[]) AND share_class_id IS NULL GROUP BY fund_id,source,filing_id,as_of_date ORDER BY as_of_date DESC,count(*) DESC,fund_id LIMIT 1`, groupIds,
  );
  if (groupMaster) {
    const inherited = await snapshot(db, groupMaster.fund_id, null);
    if (inherited) return { requestedFundId: fundId, masterFundId: groupMaster.fund_id, resolutionStatus: groupMaster.fund_id === fundId ? "DIRECT" : "INHERITED_FROM_MASTER", source: inherited.source, asOfDate: inherited.as_of_date, completeness: inherited.completeness, holdings: inherited.holdings };
  }
  let peers = funds.filter((fund) => fund.id !== fundId && deterministicMasterKey(fund) === key).map((fund) => fund.id);
  if (!peers.length) {
    const pool = funds.filter((fund) => fund.id !== fundId && candidatePoolKey(fund) === candidatePoolKey(requested));
    if (pool.length > 1) {
      const mappings = await db.$queryRawUnsafe<Array<{fund_id:string;moneydj_code:string}>>(
        `SELECT fund_id,moneydj_code FROM fund_mappings WHERE fund_id=ANY($1::text[]) AND moneydj_code IS NOT NULL AND moneydj_code<>'1'`,
        [requested.id, ...pool.map((fund) => fund.id)],
      );
      const aliases = new Map(mappings.map((mapping) => [mapping.fund_id, mapping.moneydj_code]));
      const sameAlias = aliases.get(requested.id) ? pool.filter((fund) => aliases.get(fund.id) === aliases.get(requested.id)) : [];
      const sameFingerprint = pool.filter((fund) => shareClassFingerprint(fund) === shareClassFingerprint(requested));
      const unique = sameAlias.length === 1 ? sameAlias : sameFingerprint.length === 1 ? sameFingerprint : [];
      peers = unique.map((fund) => fund.id);
    }
  }
  if (peers.length) {
    const [master] = await db.$queryRawUnsafe<Array<{fund_id:string;source:string;filing_id:string;as_of_date:Date;completeness:string|null;rows:number}>>(
      `SELECT fund_id,source,filing_id,as_of_date,min(weight_method) completeness,count(*)::int rows
       FROM holdings WHERE fund_id=ANY($1::text[]) AND share_class_id IS NULL
       GROUP BY fund_id,source,filing_id,as_of_date ORDER BY as_of_date DESC,rows DESC,fund_id LIMIT 1`, peers,
    );
    if (master) {
      const inherited = await snapshot(db, master.fund_id, null);
      if (inherited) return { requestedFundId: fundId, masterFundId: master.fund_id, resolutionStatus: "INHERITED_FROM_MASTER", source: inherited.source, asOfDate: inherited.as_of_date, completeness: inherited.completeness, holdings: inherited.holdings };
    }
  }
  return { requestedFundId: fundId, masterFundId: null, resolutionStatus: "HOLDINGS_UNAVAILABLE", source: null, asOfDate: null, completeness: null, holdings: [] };
}
