import { spawn } from "node:child_process";
const root=process.cwd(),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms)),once=process.argv.includes("--once");
async function child(script:string){await new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,["--experimental-strip-types","--env-file=.env",script,"--once"],{cwd:root,stdio:"inherit",windowsHide:true});p.once("exit",code=>code===0?resolve():reject(new Error(`${script}:EXIT_${code}`)));p.once("error",reject)})}
do{await child("scripts/data/institutional-holdings/run-p0-depth-recovery.ts");await child("scripts/data/institutional-holdings/run-p0-completion-v2-compatible.ts");await child("scripts/data/institutional-holdings/run-p0-closeout-v3.ts");if(!once)await sleep(6*60*60*1000)}while(!once);
