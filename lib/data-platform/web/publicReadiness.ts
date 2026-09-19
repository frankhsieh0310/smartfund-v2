import { prisma } from "../../prisma.ts";
import { dateKey, latestClosedTradingDate, loadExchangeCalendarRegistry } from "../../../scripts/data/daily/exchange-calendar.ts";
import { freshnessStatus } from "./freshness.ts";

export const PUBLIC_HISTORY_MIN_ROWS=20;
export type PublicReadyState={currentReady:boolean;historyReady:boolean;detailReady:boolean;publicReady:boolean;historyRows:number;earliestDate:string|null;latestDate:string|null;freshness:string;reason:string};
type IndexEvidenceRow={index_id:string;country:string|null;exchange:string|null;timezone:string;rows:bigint|number;earliest:Date|null;latest:Date|null;latest_close:unknown;latest_source:string|null;latest_license:string|null};
const iso=(d:Date|null)=>d?d.toISOString():null;
export async function getIndexReadinessMap(ids:readonly string[]){const unique=[...new Set(ids)].filter(Boolean);if(!unique.length)return new Map<string,PublicReadyState>();const [rows,registry]=await Promise.all([prisma.$queryRawUnsafe<IndexEvidenceRow[]>(`SELECT r.id index_id,r.country,r.exchange,r.timezone,count(c.*)::bigint rows,min(c.timestamp) earliest,max(c.timestamp) latest,(array_agg(c.close ORDER BY c.timestamp DESC) FILTER(WHERE c.close IS NOT NULL))[1] latest_close,(array_agg(c.source ORDER BY c.timestamp DESC) FILTER(WHERE c.source IS NOT NULL))[1] latest_source,(array_agg(c.license_status ORDER BY c.timestamp DESC) FILTER(WHERE c.license_status IS NOT NULL))[1] latest_license FROM global_index_registry r LEFT JOIN global_index_candles c ON c.index_id=r.id AND c.interval='1d' WHERE r.id=ANY($1::text[]) GROUP BY r.id`,unique),loadExchangeCalendarRegistry().catch(()=>null)]);return new Map(rows.map(row=>{const historyRows=Number(row.rows),job=registry?.jobs.find(candidate=>candidate.exchanges.includes(row.exchange??"")||candidate.country===row.country||candidate.timezone===row.timezone),fresh=row.latest&&job&&dateKey(row.latest,job.timezone)>=latestClosedTradingDate(job)?"CURRENT":freshnessStatus(row.latest,"MARKET_DAY"),licenseBlocked=/LICENSE_CONSTRAINED|LICENSE_REQUIRED|RESTRICTED/i.test(row.latest_license??"");const state={currentReady:row.latest_close!=null&&row.latest!=null&&fresh==="CURRENT",historyReady:historyRows>=PUBLIC_HISTORY_MIN_ROWS,detailReady:row.latest_close!=null&&historyRows>=PUBLIC_HISTORY_MIN_ROWS,publicReady:false,historyRows,earliestDate:iso(row.earliest),latestDate:iso(row.latest),freshness:fresh,reason:""};state.publicReady=state.currentReady&&state.historyReady&&state.detailReady&&!licenseBlocked;state.reason=state.publicReady?"CURRENT_HISTORY_DETAIL_READY":licenseBlocked?"LICENSE_CONSTRAINED":!state.currentReady?"CURRENT_OR_FRESHNESS_MISSING":!state.historyReady?"USABLE_HISTORY_MISSING":"DETAIL_NOT_READY";return[row.index_id,state]}));}
export async function getIndexReadinessCensus(){const ids=await prisma.globalIndexRegistry.findMany({where:{active:true},select:{id:true}});const map=await getIndexReadinessMap(ids.map(x=>x.id));const rows=ids.map(x=>({id:x.id,...map.get(x.id)!}));return{denominator:rows.length,numerator:rows.filter(x=>x.publicReady).length,rows};}
export async function isPublicReadyAsset(assetType:string,identifier:string){
  const type=assetType.trim().toUpperCase(),key=identifier.trim();
  if(!key)return false;
  if(type==="INDEX"){
    const row=await prisma.globalIndexRegistry.findFirst({where:{active:true,OR:[{id:key},{symbol:{equals:key,mode:"insensitive"}},{providerExternalId:{equals:key,mode:"insensitive"}}]},select:{id:true}});
    return row?Boolean((await getIndexReadinessMap([row.id])).get(row.id)?.publicReady):false;
  }
  if(type==="STOCK"){
    const normalized=key.toUpperCase();
    const identity=await prisma.stock.findUnique({where:{yahooSymbol:normalized},select:{id:true}})
      ??await prisma.stock.findUnique({where:{id:key},select:{id:true}})
      ??await prisma.stock.findFirst({where:{ticker:normalized},select:{id:true}});
    const row=identity?await prisma.stock.findUnique({where:{id:identity.id},select:{isActive:true,latestClose:true,latestDate:true,history:{orderBy:{date:"desc"},take:1,select:{date:true}},_count:{select:{history:true}}}}):null;
    const sourceDate=row?.history[0]?.date;
    const sourceDateCurrent=Boolean(row?.latestDate&&sourceDate&&row.latestDate.toISOString().slice(0,10)===sourceDate.toISOString().slice(0,10));
    return Boolean(row?.isActive&&row.latestClose!=null&&row.latestDate&&row._count.history>=PUBLIC_HISTORY_MIN_ROWS&&sourceDateCurrent);
  }
  if(type==="ETF"){
    const row=await prisma.etf.findFirst({where:{isActive:true,OR:[{id:key},{code:{equals:key,mode:"insensitive"}}]},select:{latestPrice:true,latestNav:true,history:{orderBy:{date:"desc"},take:PUBLIC_HISTORY_MIN_ROWS,select:{date:true}}}});
    return Boolean((row?.latestPrice!=null||row?.latestNav!=null)&&row?.history.length>=PUBLIC_HISTORY_MIN_ROWS&&freshnessStatus(row.history[0]?.date,"MARKET_DAY")==="CURRENT");
  }
  if(type==="FUND"){
    const row=await prisma.fund.findFirst({where:{isActive:true,OR:[{id:key},{code:{equals:key,mode:"insensitive"}},{isin:{equals:key,mode:"insensitive"}}]},select:{latestNav:true,latestNavDate:true,history:{orderBy:{date:"desc"},take:PUBLIC_HISTORY_MIN_ROWS,select:{date:true}}}});
    return Boolean(row?.latestNav!=null&&row.latestNavDate&&row.history.length>=PUBLIC_HISTORY_MIN_ROWS&&!['STALE','UNKNOWN','UNAVAILABLE'].includes(freshnessStatus(row.latestNavDate,"PUBLICATION_AWARE")));
  }
  return false;
}
