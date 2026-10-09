import type { Prisma } from "@prisma/client";
import { load } from "cheerio";
import { randomUUID } from "node:crypto";

type Input={fundId:string;moneydjCode:string};
const source="MONEYDJ_PUBLIC_FUND_PROFILE";
const clean=(s:string)=>s.replace(/\s+/g," ").trim();
const date=(s:string|null)=>s?.match(/\d{4}\/\d{2}\/\d{2}/)?.[0]?.replaceAll("/","-")??null;
function between(body:string,label:string,next:string){return clean(body.match(new RegExp(`${label}\\s*[:：]?\\s*(.+?)(?=${next})`))?.[1]??"")||null;}

export async function enrichMoneyDjPublicProfile(tx:Prisma.TransactionClient,input:Input){
  const url=`https://b2bfundrwd.moneydj.com/w/wb/wb01.djhtm?a=${encodeURIComponent(input.moneydjCode)}-${encodeURIComponent(input.moneydjCode)}`;
  const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 SmartFund Fund Research/1.0"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`BLOCKED_SOURCE:MONEYDJ_PROFILE_HTTP_${response.status}`);
  const html=new TextDecoder("big5").decode(await response.arrayBuffer()),$=load(html),body=clean($("body").text());
  const fields:{[key:string]:string|null}={
    english_name:between(body,"英文名稱","台灣總代理|境外基金公司"),
    overseas_issuer:between(body,"境外基金公司","指標指數|成立日期"),
    domicile:between(body,"註冊地","台灣核准生效日|總代理基金生效日"),
    investment_currency:between(body,"計價幣別","基金類型"),
    fund_category:between(body,"基金類型","投資區域"),
    investment_region:between(body,"投資區域","投資標的"),
    investment_target:between(body,"投資標的","風險等級"),
    risk_level:between(body,"風險等級","最高管理年費|管理費"),
    custodian:between(body,"保管銀行","傘型基金"),
    umbrella_status:between(body,"傘型基金","基金經理人|經理人")
  };
  const approval=date(between(body,"台灣核准生效日","總代理基金生效日|基金規模"));
  const aumText=between(body,"基金規模","計價幣別"),aumNumber=aumText?.match(/[\d,.]+/)?.[0]?.replaceAll(",","")??null,aumDate=date(aumText),aumCurrency=aumText?.match(/(?:USD|TWD|EUR|JPY|GBP|AUD|CNY|RMB)/i)?.[0]?.toUpperCase()??fields.investment_currency?.match(/[A-Z]{3}/)?.[0]??null;
  let persisted=0;
  const addProvenance=async(name:string,value:string)=>{const n=await tx.$executeRawUnsafe(`INSERT INTO fund_profile_provenance(id,fund_id,share_class_id,field_name,source,source_record_id,as_of_date,verification_status,grain,created_at,updated_at) VALUES($1,$2,NULL,$3,$4,$5,CURRENT_DATE,'VERIFIED_SUPPLEMENTAL','FUND_LEVEL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,share_class_id,field_name,source,source_record_id) DO NOTHING`,randomUUID(),input.fundId,name,source,`${input.moneydjCode}:${name}:${value}`);persisted+=n;};
  for(const [name,value] of Object.entries(fields))if(value){
    const exists=await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_classifications WHERE fund_id=$1 AND share_class_id IS NULL AND classification_type=$2 AND classification_name=$3 AND source=$4 LIMIT 1`,input.fundId,`MONEYDJ_${name.toUpperCase()}`,value,source);
    if(!exists[0]){await tx.$executeRawUnsafe(`INSERT INTO fund_classifications(id,fund_id,share_class_id,classification_type,classification_code,classification_name,classification_value,source,source_record_id,as_of_date,classification_method,created_at,updated_at) VALUES($1,$2,NULL,$3,NULL,$4,$4,$5,$6,CURRENT_DATE,'SUPPLEMENTAL_PUBLIC_PROFILE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,randomUUID(),input.fundId,`MONEYDJ_${name.toUpperCase()}`,value,source,`${input.moneydjCode}:${name}`);persisted++;}
    await addProvenance(name,value);
  }
  if(approval){await tx.$executeRawUnsafe(`INSERT INTO fund_events(id,fund_id,share_class_id,event_type,announcement_date,effective_date,source,source_record_id,verification_status,created_at,updated_at) VALUES($1,$2,NULL,'REGULATORY_APPROVAL_EFFECTIVE',NULL,$3::date,$4,$5,'VERIFIED_SUPPLEMENTAL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,share_class_id,event_type,effective_date,source,source_record_id) DO NOTHING`,randomUUID(),input.fundId,approval,source,`${input.moneydjCode}:approval:${approval}`);await addProvenance("regulatory_effective_date",approval);}
  if(aumNumber&&aumDate&&aumCurrency){await tx.$executeRawUnsafe(`INSERT INTO fund_aum_observations(id,fund_id,share_class_id,aum,currency,observation_date,grain,source,source_record_id,created_at,updated_at) VALUES($1,$2,NULL,$3::numeric,$4,$5::date,'FUND_LEVEL',$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,share_class_id,observation_date,source) DO NOTHING`,randomUUID(),input.fundId,aumNumber,aumCurrency,aumDate,source,`${input.moneydjCode}:aum:${aumDate}`);await addProvenance("aum_with_date_currency",`${aumNumber}:${aumCurrency}:${aumDate}`);}
  const docs:{title:string,url:string}[]=[];$("a[href]").each((_,el)=>{const title=clean($(el).text()),href=$(el).attr("href");if(href&&/(公開說明書|月報|投資人須知|費用結構|財務報告)/.test(title))docs.push({title,url:new URL(href,url).href});});
  for(const doc of docs){const exists=await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_documents WHERE fund_id=$1 AND source=$2 AND url=$3 LIMIT 1`,input.fundId,source,doc.url);if(!exists[0]){await tx.$executeRawUnsafe(`INSERT INTO fund_documents(id,fund_id,share_class_id,document_type,document_title,url,source,source_record_id,is_current,created_at,updated_at) VALUES($1,$2,NULL,'MONEYDJ_PUBLIC_DOCUMENT',$3,$4,$5,$6,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,randomUUID(),input.fundId,doc.title,doc.url,source,`${input.moneydjCode}:document:${doc.title}`);persisted++;}}
  const readback=(await tx.$queryRawUnsafe<any[]>(`SELECT (SELECT COUNT(*)::int FROM fund_profile_provenance WHERE fund_id=$1 AND source=$2 AND field_name<>'MONEYDJ_LIFECYCLE_MANAGER_EVALUATED') profile_fields,(SELECT COUNT(*)::int FROM fund_aum_observations WHERE fund_id=$1 AND source=$2) aum_rows,(SELECT COUNT(*)::int FROM fund_documents WHERE fund_id=$1 AND source=$2) documents`,input.fundId,source))[0];
  const inputConstrained=!Number(readback?.profile_fields)&&!Number(readback?.aum_rows)&&!Number(readback?.documents);
  return{persisted,readback,inputConstrained,fields:{...fields,regulatory_effective_date:approval,aum_with_date_currency:aumNumber&&aumDate&&aumCurrency?`${aumNumber} ${aumCurrency} ${aumDate}`:null,stable_document_links:docs.length},sourceUrl:url};
}
