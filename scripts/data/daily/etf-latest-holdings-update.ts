import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db=new PrismaClient();
function run(args:string[]){return new Promise<void>((done,reject)=>{const child=spawn(process.execPath,["--experimental-strip-types","--env-file=.env",...args],{cwd:process.cwd(),windowsHide:true,stdio:"inherit"});child.on("error",reject);child.on("exit",code=>code===0?done():reject(new Error(`${args[0]}_EXIT_${code}`)))})}
async function main(){
 const total=await db.etf.count({where:{isActive:true}}),batch=500;
 for(let offset=0;offset<total;offset+=batch)await run(["scripts/data/etf-moneydj/run-etf-moneydj-holdings-bounded.ts",`--limit=${batch}`,`--offset=${offset}`]);
 const cfg=JSON.parse(await readFile("config/etf-yahoo-product-modules.json","utf8"));
 const yahooBatches=Math.ceil(total/Number(cfg.batchSize??100))+1;
 for(let index=0;index<yahooBatches;index++)await run(["scripts/data/etf-yahoo/run-etf-yahoo-product-modules.ts","--once"]);
 const [covered]=await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(DISTINCT etf_id)::int n FROM etf_holding_snapshots WHERE canonical_row_count>0`);
 console.log(JSON.stringify({pipeline:"ETF_LATEST_HOLDINGS_UPDATE",total,attempted:total,success:covered.n,failed:total-covered.n}));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
