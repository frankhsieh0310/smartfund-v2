const products=[
  {code:"IVV",url:"https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv"},
  {code:"IWM",url:"https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv"},
  {code:"AGG",url:"https://www.ishares.com/us/products/239458/ishares-core-u-s-aggregate-bond-etf/latest-holdings.csv"}
];
const requested=["20260630","20251231"];
const results=[];
for(const p of products){try{const page=await (await fetch(p.url.replace(/\/latest-holdings\.csv.*/,""),{signal:AbortSignal.timeout(30000),headers:{"user-agent":"SmartFund-ETF-Holdings/3.0"}})).text();const candidates=[...page.matchAll(/(?:https?:\\?\/\\?\/|\/)[^"'<>\s]{0,500}(?:ajax|holdings)[^"'<>\s]{0,500}/gi)].map(x=>x[0].replaceAll("\\/","/")).filter(x=>/fileType|asOfDate|dataType=fund/i.test(x));results.push({code:p.code,discovery:"OFFICIAL_PRODUCT_HTML",historicalCandidates:[...new Set(candidates)].slice(0,2)})}catch(error){results.push({code:p.code,discovery:"OFFICIAL_PRODUCT_HTML",error:String(error)})}}
for(const p of products)for(const date of requested){
  const u=new URL(p.url);u.searchParams.set("asOfDate",date);
  try{const r=await fetch(u,{redirect:"follow",signal:AbortSignal.timeout(30000),headers:{"user-agent":"SmartFund-ETF-Holdings/3.0","accept":"text/csv,text/plain,*/*;q=0.1"}});const text=await r.text();const effective=/Fund Holdings as of,"?([^"\r\n]+)"?/i.exec(text)?.[1]?.trim()??null;results.push({code:p.code,requested:date,httpStatus:r.status,effectiveDate:effective,bytes:Buffer.byteLength(text),historicalMatch:effective?new Date(effective).toISOString().slice(0,10).replaceAll("-","")===date:false,finalUrl:r.url})}catch(error){results.push({code:p.code,requested:date,error:String(error)})}
}
console.log(JSON.stringify(results,null,2));
