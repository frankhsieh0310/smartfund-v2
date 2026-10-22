const { closeSync, openSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const root = resolve(__dirname, "../../..");
const runtime = resolve(root, "runtime/bond/desktop-supervisor");
const stdoutFd = openSync(resolve(runtime, "launcher.stdout.log"), "a");
const stderrFd = openSync(resolve(runtime, "launcher.stderr.log"), "a");
const env = {};
let processPath = "";
for (const [key, value] of Object.entries(process.env)) {
  if (key.toLowerCase() === "path") { processPath ||= value || ""; continue; }
  env[key] = value;
}
env.Path = processPath;
const engine = resolve(root, "runtime/prisma-engines/query_engine-windows-5.22.0.node");
env.PRISMA_QUERY_ENGINE_LIBRARY = process.env.PRISMA_QUERY_ENGINE_LIBRARY || engine;
const powershell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const script = resolve(root, "scripts/data/bond/run-desktop-global-bond-supervisor.ps1");
const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
  cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", stdoutFd, stderrFd],
});
const stop = () => { if (!child.killed) child.kill("SIGTERM"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("error", (error) => {
  require("node:fs").appendFileSync(resolve(runtime, "launcher.stderr.log"), `${new Date().toISOString()} LAUNCH_ERROR ${error.stack || error}\n`);
  closeSync(stdoutFd); closeSync(stderrFd); process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  require("node:fs").appendFileSync(resolve(runtime, "launcher.stderr.log"), `${new Date().toISOString()} PARENT_EXIT code=${code} signal=${signal}\n`);
  closeSync(stdoutFd); closeSync(stderrFd); process.exitCode = code == null ? 1 : code;
});
