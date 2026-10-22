import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER ?? process.env.DATABASE_URL } } });
const norm = (value: string | null) => value?.toUpperCase().replace(/[\s-]/g, "") || null;
async function main() {
  const holdings = await prisma.$queryRawUnsafe<Array<{id:string;source:string;isin:string|null;cusip:string|null;ticker:string|null}>>(`SELECT id,source,isin,cusip,ticker FROM holdings WHERE fund_id IS NOT NULL AND security_id IS NULL`);
  const isins = [...new Set(holdings.map(row => row.isin).filter((value): value is string => Boolean(value)))];
  const cusips = [...new Set(holdings.map(row => row.cusip).filter((value): value is string => Boolean(value)))];
  const securities = await prisma.$queryRawUnsafe<Array<{id:string;isin:string|null;cusip:string|null}>>(`SELECT id,isin,cusip FROM securities WHERE isin=ANY($1::text[]) OR cusip=ANY($2::text[])`, isins, cusips);
  const isinMap = new Map<string,string[]>(), cusipMap = new Map<string,string[]>();
  for (const security of securities) {
    const isin=norm(security.isin),cusip=norm(security.cusip);
    if(isin) isinMap.set(isin,[...(isinMap.get(isin)??[]),security.id]);
    if(cusip) cusipMap.set(cusip,[...(cusipMap.get(cusip)??[]),security.id]);
  }
  const classified=holdings.map(row=>{const i=norm(row.isin),c=norm(row.cusip),im=i?isinMap.get(i)??[]:[],cm=c?cusipMap.get(c)??[]:[];const matches=im.length?im:cm;return{...row,status:matches.length===1?"EXACT_UNIQUE":matches.length>1?"AMBIGUOUS":!i&&!c&&!row.ticker?"IDENTIFIER_MISSING":!i&&!c&&row.ticker?"EXCHANGE_MISSING":"IDENTIFIER_NOT_FOUND"};});
  const count=(status:string,source?:string)=>classified.filter(row=>row.status===status&&(!source||row.source===source)).length;
  console.log(JSON.stringify({total:holdings.length,nport:holdings.filter(row=>row.source==='SEC_EDGAR_NPORT_P').length,moneydj:holdings.filter(row=>row.source==='MONEYDJ_PUBLIC_DISCLOSURE').length,withIsin:holdings.filter(row=>row.isin).length,withCusip:holdings.filter(row=>row.cusip).length,exactUnique:count('EXACT_UNIQUE'),ambiguous:count('AMBIGUOUS'),identifierMissing:count('IDENTIFIER_MISSING'),identifierNotFound:count('IDENTIFIER_NOT_FOUND'),exchangeMissing:count('EXCHANGE_MISSING'),nportMapped:count('EXACT_UNIQUE','SEC_EDGAR_NPORT_P'),moneydjMapped:count('EXACT_UNIQUE','MONEYDJ_PUBLIC_DISCLOSURE')}));
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => prisma.$disconnect());
