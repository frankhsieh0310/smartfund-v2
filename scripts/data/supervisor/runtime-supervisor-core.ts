import { readFile, rm, stat } from "node:fs/promises";

export type Snapshot = { pid: number | null; processAlive: boolean; state: string; heartbeat: string | null; checkpoint: unknown; processed: number | null; rows: number | null; coverage: number | null; pending: number | null; failed: number | null; earliest: string | null; latest: string | null; historyYears: number | null; density: number | null; lastSuccess: string | null; lastDbWrite: string | null; lastTargetProgress: string | null; nextRun: string | null; blocker: string | null; codeVersion: string | null };
const get = (value: any, names: string[]) => { for (const name of names) if (value?.[name] !== undefined && value[name] !== "") return value[name]; return null; };
const number = (value: unknown) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value: unknown) => value === null || value === undefined || value === "" ? null : typeof value === "string" ? value : JSON.stringify(value);
export function normalize(raw: any, alive: (pid: number) => boolean): Snapshot {
  const pid = number(get(raw,["PROCESS_ID","process_id","pid","supervisorPid"]));
  const coverageRaw = get(raw,["COVERAGE","coverage"]); const coverageMatch = String(coverageRaw ?? "").match(/([0-9.]+)\s*%/);
  return { pid, processAlive: Boolean(pid && alive(pid)), state: String(get(raw,["RUN_STATE","run_state","STATE","state","status"]) ?? "UNKNOWN"), heartbeat:text(get(raw,["HEARTBEAT_AT","heartbeat_at","heartbeatAt","heartbeat","lastHeartbeat","updatedAt"])), checkpoint:get(raw,["CHECKPOINT","checkpoint","current"]), processed:number(get(raw,["PROCESSED","processed","completed"])), rows:number(get(raw,["ROWS","rows","rowCount","observations"])), coverage:coverageMatch?Number(coverageMatch[1]):number(coverageRaw), pending:number(get(raw,["PENDING","pending","pending_count"])), failed:number(get(raw,["FAILED","failed","failureCount"])), earliest:text(get(raw,["EARLIEST","earliest"])), latest:text(get(raw,["LATEST","latest","lastCanonicalDate"])), historyYears:number(get(raw,["HISTORY_YEARS","history_years","historyYears"])), density:number(get(raw,["DENSITY","density"])), lastSuccess:text(get(raw,["LAST_SUCCESS","last_success","lastSuccess","lastSuccessfulRun"])), lastDbWrite:text(get(raw,["LAST_DB_WRITE","last_db_write","lastDbWrite"])), lastTargetProgress:text(get(raw,["LAST_TARGET_PROGRESS","last_target_progress","lastTargetProgress","LAST_PROGRESS_AT","lastProgressAt"])), nextRun:text(get(raw,["NEXT_RUN_AT","next_run_at","nextRunAt","nextRun"])), blocker:text(get(raw,["BLOCKER","blocker","LAST_ERROR","lastError","error","reason"])), codeVersion:text(get(raw,["CODE_VERSION","code_version","version"])) };
}
export function delta(previous: Snapshot | null, current: Snapshot) { const diff=(key:keyof Snapshot)=>typeof current[key]==="number"&&typeof previous?.[key]==="number"?Number(current[key])-Number(previous[key]):null; return { processed:diff("processed"),rows:diff("rows"),coverage:diff("coverage"),pending:diff("pending"),failed:diff("failed"),historyYears:diff("historyYears"),density:diff("density"),cursorChanged:previous?JSON.stringify(previous.checkpoint)!==JSON.stringify(current.checkpoint):null,earliestChanged:previous?previous.earliest!==current.earliest:null,latestChanged:previous?previous.latest!==current.latest:null,lastSuccessChanged:previous?previous.lastSuccess!==current.lastSuccess:null }; }
export function classify(previous: Snapshot | null,current: Snapshot,d:ReturnType<typeof delta>,expectedRunning:boolean,now=Date.now(),asset="") {
  const scheduledTerminalMaintenance=/TERMINAL_SOURCE_LIMITED/.test(current.state)&&Boolean(current.nextRun);
  if (/COMPLETE|TERMINAL/.test(current.state) && !/CONTINUING/.test(current.state) && !scheduledTerminalMaintenance) return "COMPLETE";
  if (/SOURCE_WAIT|SOURCE_LIMITED/.test(current.state) && !scheduledTerminalMaintenance) return "SOURCE_WAIT";
  if (/LICENSE_WAIT|LICENSE_LIMITED|LICENSE_CONSTRAINED/.test(current.state)) return "LICENSE_WAIT";
  if (current.blocker && /401|403|auth|credential/i.test(current.blocker)) return "BLOCKED_AUTH";
  if (current.blocker && /license|terms/i.test(current.blocker)) return "LICENSE_WAIT";
  if (current.blocker && /database|emaxconnsession|max clients|connection|timeout/i.test(current.blocker)) return "BLOCKED_DB";
  const due=!current.nextRun||Date.parse(current.nextRun)<=now;
  if (!due) return "SCHEDULED_WAIT";
  // A scheduled autonomous owner that is absent after its due time is not
  // waiting anymore.  Promote it to DEAD so the verified recovery contract
  // can run; future schedules were already preserved by the branch above.
  if (expectedRunning && !current.processAlive && current.nextRun && /SCHEDULED_WAIT|RETRY_WAIT|RUNNING|ACTIVE|UNKNOWN|TERMINAL_SOURCE_LIMITED/.test(current.state)) return "DEAD";
  if (/SCHEDULED_WAIT/.test(current.state) && !((current.pending??0)>0)) return "SCHEDULED_WAIT";
  const lifecycle=(value:unknown)=>String(value??"").split(":")[0];
  if(asset==="CRYPTO"&&previous&&lifecycle(previous.checkpoint)!==lifecycle(current.checkpoint))return "LIFECYCLE_GRACE";
  const advancing=(d.processed??0)>0||(d.rows??0)>0||(d.coverage??0)>0||(d.pending??0)<0||d.latestChanged===true;
  if (advancing) return "PROGRESSING";
  const executableDue=(current.pending??0)>0||/RUNNING/.test(current.state);
  if(!expectedRunning||!executableDue||!previous)return "SCHEDULED_WAIT";
  return current.processAlive?"STALLED":"DEAD";
}
export type ExecutionMode="continuous"|"scheduled"|"publication";
export function applyContractSemantics(status:string,current:Snapshot,options:{mode:ExecutionMode;requiredAutonomous:boolean;startupGraceExpired:boolean;now?:number}){if(!options.requiredAutonomous||["COMPLETE","SOURCE_WAIT","LICENSE_WAIT","LIFECYCLE_GRACE","STARTUP_GRACE"].includes(status))return status;const now=options.now??Date.now(),nextAt=Date.parse(current.nextRun??""),future=Number.isFinite(nextAt)&&nextAt>now;if(future)return "SCHEDULED_WAIT";if(!current.processAlive&&options.startupGraceExpired){if(options.mode==="continuous")return "DEAD";if(options.mode==="scheduled"&&(!current.nextRun||nextAt<=now))return "DEAD";}return status;}
export async function clearStaleSingleWriter(path:string,alive:(pid:number)=>boolean){let raw:string;try{raw=await readFile(path,"utf8")}catch{return{removed:false,pid:null,reason:"ABSENT"}}let parsed:any;try{parsed=JSON.parse(raw.replace(/^\uFEFF/,""))}catch{parsed=raw.trim()}const pid=Number((typeof parsed==="number"||typeof parsed==="string")?parsed:(parsed?.pid??parsed?.processId??parsed?.PROCESS_ID??parsed?.supervisorPid??parsed?.runnerPid??parsed?.childPid??parsed?.ownerPid??0));if(pid>0&&alive(pid))return{removed:false,pid,reason:"LIVE_OWNER"};await rm(path,{force:true});return{removed:true,pid:pid||null,reason:"STALE_OWNER"}}
export async function checkpointMark(path?:string){if(!path)return null;return stat(path).then(x=>x.mtime.toISOString()).catch(()=>null)}
