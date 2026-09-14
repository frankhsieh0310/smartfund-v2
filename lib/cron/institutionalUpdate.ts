import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";

type Row = { ticker: string; market: string; foreignBuy: number; foreignSell: number; foreignNet: number; trustBuy: number; trustSell: number; trustNet: number; dealerBuy: number; dealerSell: number; dealerNet: number };
const number = (value: unknown) => Number(String(value ?? "0").replaceAll(",", "")) || 0;
const compact = (date: string) => date.replaceAll("-", "");
const slash = (date: string) => date.replaceAll("-", "/");
const pick = (record: Record<string, unknown>, patterns: RegExp[]) => number(Object.entries(record).find(([key]) => patterns.every(pattern => pattern.test(key)))?.[1]);
function normalize(headers: string[], values: unknown[], market: string): Row | null {
  const record = Object.fromEntries(headers.map((header, index) => [header.replaceAll(" ", ""), values[index]])), ticker = String(values[0] ?? "").trim();
  if (!/^\d{4,6}[A-Z]?$/.test(ticker)) return null;
  const foreignBuy=pick(record,[/外資|外陸資/,/買進/]),foreignSell=pick(record,[/外資|外陸資/,/賣出/]),foreignNet=pick(record,[/外資|外陸資/,/買賣超/]);
  const trustBuy=pick(record,[/投信/,/買進/]),trustSell=pick(record,[/投信/,/賣出/]),trustNet=pick(record,[/投信/,/買賣超/]);
  const dealerBuy=pick(record,[/自營商/,/買進/]),dealerSell=pick(record,[/自營商/,/賣出/]),dealerNet=pick(record,[/自營商/,/買賣超/]);
  return { ticker, market, foreignBuy, foreignSell, foreignNet, trustBuy, trustSell, trustNet, dealerBuy, dealerSell, dealerNet };
}
const taipeiDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export async function updateInstitutional(date = taipeiDate()) {
  const [twse,tpex]=await Promise.all([
    fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${compact(date)}&selectType=ALLBUT0999&response=json`,{headers:{accept:"application/json"}}).then(r=>r.json()),
    fetch(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?date=${slash(date)}&type=Daily&sect=EW&order=1&id=&response=json`,{headers:{accept:"application/json"}}).then(r=>r.json()),
  ]);
  const twseRows=((twse as {fields?:string[];data?:unknown[][]}).data??[]).map(row=>normalize((twse as {fields?:string[]}).fields??[],row,"TWSE"));
  const table=(tpex as {tables?:Array<{fields?:string[];data?:unknown[][]}>}).tables?.[0],tpexRows=(table?.data??[]).map(row=>normalize(table?.fields??[],row,"TPEx"));
  const rows=[...twseRows,...tpexRows].filter((row):row is Row=>row!=null), securities=await prisma.security.findMany({where:{ticker:{in:rows.map(row=>row.ticker)}},select:{id:true,ticker:true}}),securityByTicker=new Map(securities.filter(x=>x.ticker).map(x=>[x.ticker!,x.id]));
  let written=0; const unmapped:string[]=[]; const day=new Date(`${date}T00:00:00.000Z`);
  for(const row of rows){const securityId=securityByTicker.get(row.ticker);if(!securityId){unmapped.push(row.ticker);continue}const totalNet=row.foreignNet+row.trustNet+row.dealerNet;await prisma.$executeRawUnsafe(`INSERT INTO institutional_daily(id,date,security_id,ticker,market,foreign_buy,foreign_sell,foreign_net,trust_buy,trust_sell,trust_net,dealer_buy,dealer_sell,dealer_net,total_net,created_at,updated_at) VALUES($1::uuid,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now()) ON CONFLICT(date,security_id) DO UPDATE SET ticker=EXCLUDED.ticker,market=EXCLUDED.market,foreign_buy=EXCLUDED.foreign_buy,foreign_sell=EXCLUDED.foreign_sell,foreign_net=EXCLUDED.foreign_net,trust_buy=EXCLUDED.trust_buy,trust_sell=EXCLUDED.trust_sell,trust_net=EXCLUDED.trust_net,dealer_buy=EXCLUDED.dealer_buy,dealer_sell=EXCLUDED.dealer_sell,dealer_net=EXCLUDED.dealer_net,total_net=EXCLUDED.total_net,updated_at=now()`,randomUUID(),day,securityId,row.ticker,row.market,row.foreignBuy,row.foreignSell,row.foreignNet,row.trustBuy,row.trustSell,row.trustNet,row.dealerBuy,row.dealerSell,row.dealerNet,totalNet);written++}
  return {date,sourceRows:rows.length,written,unmapped};
}
