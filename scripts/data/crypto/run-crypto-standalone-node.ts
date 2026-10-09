import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root=resolve("."),runtime=resolve("runtime/crypto"),pidPath=resolve(runtime,"standalone.pid"),heartbeatPath=resolve(runtime,"heartbeat.json");
const steps=["--enqueue","--work","--complete-p0","--validate"],sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let stopping=false,failures=0;
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function writeHeartbeat(status:string,nextRunAt:string|null,error:string|null=null){await writeFile(heartbeatPath,`${JSON.stringify({pid:process.pid,status,stage:"HISTORICAL_INCREMENTAL",heartbeatAt:new Date().toISOString(),nextRunAt,failures,error},null,2)}\n`)}
async function acquire(){await mkdir(runtime,{recursive:true});const prior=Number((await readFile(pidPath,"utf8").catch(()=>"0")).trim());if(prior&&prior!==process.pid&&alive(prior))throw new Error(`CRYPTO_SINGLE_WRITER_ACTIVE:${prior}`);await writeFile(pidPath,`${process.pid}\n`)}
async function runStep(step:string){return new Promise<number>((done,reject)=>{const child=spawn(process.execPath,["--experimental-strip-types","--env-file=.env","scripts/data/crypto/run-global-crypto.ts",step],{cwd:root,env:process.env,stdio:"inherit",windowsHide:true});child.once("error",reject);child.once("exit",code=>done(code??1))})}
async function main(){await acquire();try{while(!stopping){await writeHeartbeat("RUNNING",null);let exitCode=0;for(const step of steps){exitCode=await runStep(step);if(exitCode!==0||stopping)break}failures=exitCode===0?0:failures+1;const delay=exitCode===0?30000:Math.min(900000,Math.max(30000,15000*2**Math.min(failures,9))),nextRunAt=new Date(Date.now()+delay).toISOString();await writeHeartbeat(exitCode===0?"SCHEDULED_WAIT":"RETRY_PENDING",nextRunAt,exitCode===0?null:`CRYPTO_STEP_EXIT_${exitCode}`);await sleep(delay)}}finally{await rm(pidPath,{force:true})}}
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{stopping=true});
main().catch(async error=>{await writeHeartbeat("BLOCKED",null,error instanceof Error?error.message:String(error)).catch(()=>undefined);console.error(error);process.exitCode=1});
