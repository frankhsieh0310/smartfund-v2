import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { freshnessStatus } from "./freshness.ts";
import type { HomeRankData, HomeRankItem } from "@/lib/web/home-ranking-types";

const n = (value: unknown) => value == null ? null : Number(value);
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;
const trend = (rows: Array<{ close?: unknown; price?: unknown; nav?: unknown }>) => rows.slice().reverse().map((row) => n(row.close ?? row.price ?? row.nav)).filter((value): value is number => value !== null);

type StockRankRow={id:string;ticker:string;yahoo_symbol:string;name:string;currency:string;date:Date;close:unknown;volume:unknown;updated_at:Date|null;change_pct:unknown};
type EtfRankRow={id:string;code:string;name:string;currency:string;date:Date;price:unknown;volume:unknown;trading_amount:unknown;updated_at:Date;change_pct:unknown};
const md=(date:Date|null|undefined)=>date?`${date.getUTCMonth()+1}/${date.getUTCDate()}`:"";
async function stockRanks(){
 const rows=await prisma.$queryRaw<StockRankRow[]>(Prisma.sql`WITH candidates AS (SELECT s.id,s.ticker,s.yahoo_symbol,coalesce(s.company_name_zh,s.company_name) name,s.currency,h.date,h.close,h.volume,CASE WHEN p.close IS NOT NULL AND p.close<>0 THEN ((h.close-p.close)/p.close)*100 END change_pct,coalesce(h.updated_at,h.imported_at,h.created_at) updated_at FROM stocks s CROSS JOIN LATERAL (SELECT date,close,volume,updated_at,imported_at,created_at FROM stock_history WHERE stock_id=s.id AND volume>0 ORDER BY date DESC LIMIT 1) h LEFT JOIN LATERAL (SELECT close FROM stock_history WHERE stock_id=s.id AND date<h.date ORDER BY date DESC LIMIT 1) p ON true WHERE s.is_active AND s.country='TW' AND s.exchange IN ('TWSE','TPEx')), latest AS (SELECT max(date) date FROM candidates) SELECT c.* FROM candidates c JOIN latest l ON c.date=l.date ORDER BY c.volume DESC,c.ticker ASC LIMIT 5`);
 const items=rows.map((row):HomeRankItem=>({id:row.id,code:row.ticker,name:row.name,href:`/stocks/${encodeURIComponent(row.yahoo_symbol)}`,value:n(row.close),metric:n(row.change_pct),metricLabel:"漲跌幅",currency:row.currency,asOfDate:iso(row.date),lastUpdated:iso(row.updated_at),trend:[]}));
 return{primary:{label:`${md(rows[0]?.date)} 台股成交量前五大`,asOfDate:iso(rows[0]?.date),items},secondary:{label:"",asOfDate:null,items:[] as HomeRankItem[]}};
}
async function etfRanks(){
 const rows=await prisma.$queryRaw<EtfRankRow[]>(Prisma.sql`WITH candidates AS (SELECT e.id,e.code,e.name,e.currency,h.date,h.price,h.volume,(h.price*h.volume) trading_amount,CASE WHEN p.price IS NOT NULL AND p.price<>0 THEN ((h.price-p.price)/p.price)*100 END change_pct,e.updated_at FROM etfs e CROSS JOIN LATERAL (SELECT date,coalesce(close,price) price,volume FROM etf_history WHERE etf_id=e.id AND volume>0 AND coalesce(close,price) IS NOT NULL ORDER BY date DESC LIMIT 1) h LEFT JOIN LATERAL (SELECT coalesce(close,price) price FROM etf_history WHERE etf_id=e.id AND date<h.date AND coalesce(close,price) IS NOT NULL ORDER BY date DESC LIMIT 1) p ON true WHERE e.is_active AND e.currency='TWD' AND e.exchange IN ('TWSE','TPEx')), latest AS (SELECT max(date) date FROM candidates) SELECT c.* FROM candidates c JOIN latest l ON c.date=l.date ORDER BY c.trading_amount DESC,c.code ASC LIMIT 5`);
 const items=rows.map((row):HomeRankItem=>({id:row.id,code:row.code,name:row.name,href:`/etf/${encodeURIComponent(row.code)}`,value:n(row.price),metric:n(row.change_pct),metricLabel:"漲跌幅",currency:row.currency,asOfDate:iso(row.date),lastUpdated:iso(row.updated_at),trend:[]}));
 return{primary:{label:`${md(rows[0]?.date)} 台灣ETF成交金額前五大`,asOfDate:iso(rows[0]?.date),items},secondary:{label:"",asOfDate:null,items:[] as HomeRankItem[]}};
}async function fundRanks() {
  const select={id:true,code:true,isin:true,name:true,currency:true,return1y:true,latestNav:true,latestNavDate:true,updatedAt:true,history:{orderBy:{date:"desc" as const},take:8,select:{nav:true}}};
  const [totalCount,comparableCount,asOf,candidates]=await Promise.all([
    prisma.fund.count({where:{isActive:true}}),
    prisma.fund.count({where:{isActive:true,return1y:{not:null}}}),
    prisma.fund.aggregate({where:{isActive:true,return1y:{not:null}},_max:{latestNavDate:true}}),
    prisma.fund.findMany({where:{isActive:true,return1y:{not:null}},orderBy:[{return1y:{sort:"desc",nulls:"last"}},{id:"asc"}],take:100,select}),
  ]);
  const readiness=candidates.length?await prisma.$queryRaw<Array<{id:string;history_ready:boolean}>>(Prisma.sql`SELECT f.id,EXISTS(SELECT 1 FROM fund_history h WHERE h.fund_id=f.id OFFSET 19 LIMIT 1) history_ready FROM funds f WHERE f.id IN (${Prisma.join(candidates.map(row=>row.id))})`):[];
  const readyByFund=new Map(readiness.map(row=>[row.id,row.history_ready]));
  const ready=candidates.filter(row=>row.latestNav!=null&&row.latestNavDate!=null&&(row.code!=null||row.isin!=null)&&/\p{Script=Han}/u.test(row.name)&&readyByFund.get(row.id)===true&&!['STALE','UNKNOWN','UNAVAILABLE'].includes(freshnessStatus(row.latestNavDate,"PUBLICATION_AWARE"))).slice(0,5);
  const items=ready.map((row):HomeRankItem=>{const code=row.code??row.isin??row.id;return{id:row.id,code,name:row.name,href:`/funds/${encodeURIComponent(row.id)}`,value:n(row.latestNav),metric:n(row.return1y),metricLabel:"近1年報酬率",currency:row.currency,asOfDate:iso(row.latestNavDate),lastUpdated:iso(row.updatedAt),trend:trend(row.history)}});
  return {primary:{label:"近1年績效",asOfDate:iso(asOf._max.latestNavDate),items,comparableCount,totalCount},secondary:{label:"",asOfDate:null,items:[] as HomeRankItem[]}};
}export async function getHomeRankData():Promise<HomeRankData>{
  const [stocks,etfs,funds]=await Promise.allSettled([stockRanks(),etfRanks(),fundRanks()]);
  const empty=(a:string,b:string)=>({primary:{label:a,asOfDate:null,items:[]},secondary:{label:b,asOfDate:null,items:[]}});
  return {stocks:stocks.status==="fulfilled"?stocks.value:empty("成交額排行","漲幅排行"),etfs:etfs.status==="fulfilled"?etfs.value:empty("規模排行","績效排行"),funds:funds.status==="fulfilled"?funds.value:empty("績效排行","規模排行")};
}

