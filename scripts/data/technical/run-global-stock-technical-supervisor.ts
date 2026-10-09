import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("runtime", "global-stock-technical-quant");
const paths = { lock: resolve(root, "single-writer.lock"), pid: resolve(root, "supervisor.pid"), heartbeat: resolve(root, "heartbeat.json"), checkpoint: resolve(root, "checkpoint.json"), log: resolve(root, "supervisor.log") };
const markets = ["NASDAQ", "NYSE", "AMEX", "TWSE", "TPEX", "JPX", "KSC", "KOE", "HKG", "SHH", "SHZ", "SES", "TOR", "NEO", "VAN"];
const intervalMs = 15 * 60_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString();
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rename(temp, file); return; }
    catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!(["EPERM", "EACCES", "EBUSY"] as Array<string | undefined>).includes(code)) throw error;
      await sleep(Math.min(400, 25 * 2 ** attempt));
    }
  }
  const backup = `${file}.${process.pid}.backup`;
  try {
    await copyFile(file, backup).catch(() => undefined);
    await rm(file, { force: true });
    await rename(temp, file);
    await rm(backup, { force: true });
  } catch (error) {
    await copyFile(backup, file).catch(() => undefined);
    throw last ?? error;
  }
}
async function read<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; } }
async function append(value: unknown) { const old = await readFile(paths.log, "utf8").catch(() => ""); await writeFile(paths.log, `${old}${JSON.stringify(value)}\n`); }
async function child(market: string): Promise<number> {
  const out = await open(resolve(root, "child.log"), "a");
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--env-file=.env", "scripts/data/technical/run-production-stock-technical.ts", `--market=${market}`, "--max-symbols=2"], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", out.fd, out.fd], env: { ...process.env, LIVE_WRITE_AUTHORIZED: "true", SMARTFUND_NODE_ID: `GLOBAL_STOCK_TECHNICAL_QUANT:${process.pid}` },
  });
  const code = await new Promise<number>((done) => { proc.once("exit", (value) => done(value ?? 1)); proc.once("error", () => done(1)); });
  await out.close(); return code;
}
async function main() {
  await mkdir(root, { recursive: true });
  let lease;
  try { lease = await open(paths.lock, "wx"); }
  catch {
    const stale = await read<{ pid?: number }>(paths.lock, {});
    let running = false;
    if (stale.pid) { try { process.kill(stale.pid, 0); running = true; } catch { running = false; } }
    if (running) throw new Error(`STOCK_TECHNICAL_ALREADY_RUNNING:${stale.pid}`);
    await rm(paths.lock, { force: true });
    lease = await open(paths.lock, "wx");
  }
  await lease.writeFile(JSON.stringify({ owner: "GLOBAL_STOCK_TECHNICAL_QUANT", pid: process.pid, startedAt: now() }));
  await atomic(paths.pid, { owner: "GLOBAL_STOCK_TECHNICAL_QUANT", pid: process.pid, startedAt: now() });
  let state = await read(paths.checkpoint, { marketCursor: 0, cycles: 0, success: 0, failed: 0 });
  try {
    for (;;) {
      const market = markets[state.marketCursor % markets.length]!;
      const attempt = now();
      await atomic(paths.heartbeat, { owner: "GLOBAL_STOCK_TECHNICAL_QUANT", pid: process.pid, state: "RUNNING", currentMarket: market, heartbeat: attempt, lastAttempt: attempt, autoContinuing: true });
      const code = await child(market);
      state = { ...state, marketCursor: (state.marketCursor + 1) % markets.length, cycles: state.cycles + 1, success: state.success + (code === 0 ? 1 : 0), failed: state.failed + (code === 0 ? 0 : 1), lastMarket: market, lastExitCode: code, lastSuccess: code === 0 ? now() : state.lastSuccess ?? null, updatedAt: now() };
      await atomic(paths.checkpoint, state);
      const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      await atomic(paths.heartbeat, { owner: "GLOBAL_STOCK_TECHNICAL_QUANT", pid: process.pid, state: code === 0 ? "INCREMENTAL_WAIT" : "RETRY_WAIT", currentMarket: null, heartbeat: now(), lastAttempt: attempt, lastSuccess: state.lastSuccess ?? null, nextRunAt, checkpoint: paths.checkpoint, autoContinuing: true });
      await append({ at: now(), market, code, nextRunAt });
      await sleep(intervalMs);
    }
  } finally { await lease.close(); await rm(paths.lock, { force: true }); await rm(paths.pid, { force: true }); }
}
main().catch(async (error) => { await mkdir(root, { recursive: true }); await atomic(paths.heartbeat, { owner: "GLOBAL_STOCK_TECHNICAL_QUANT", pid: process.pid, state: "UNEXPECTED_STOP", heartbeat: now(), error: error instanceof Error ? error.message : String(error), autoContinuing: false }); process.exitCode = 1; });
