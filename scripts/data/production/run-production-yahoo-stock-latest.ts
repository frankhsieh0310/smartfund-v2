import { spawn } from "node:child_process";

// Dedicated single-purpose Railway entrypoint for Global Stock latest auto-sync only.
// Deliberately does not import or duplicate the dispatcher/calendar/checkpoint/writer logic —
// it only starts the existing engine and exits, so Railway's cronSchedule (not an internal
// loop) is what makes this recurring. See railway.toml for the invocation cadence.
function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`))));
  });
}

run("scripts/data/daily/run-production-yahoo-daily.ts", []).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
