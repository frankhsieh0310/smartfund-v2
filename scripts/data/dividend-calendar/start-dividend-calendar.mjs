import { openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(scriptDir, "../../..");
const runtime = join(projectRoot, "runtime", "dividend-calendar");
const out = openSync(join(runtime, "runner.stdout.log"), "a");
const err = openSync(join(runtime, "runner.stderr.log"), "a");
const child = spawn(process.execPath, ["--experimental-strip-types", "--env-file=.env", join(scriptDir, "run-global-dividend-calendar.ts")], {
  cwd: projectRoot,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, err]
});
child.unref();
writeFileSync(join(runtime, "runner.pid"), String(child.pid));
process.stdout.write(String(child.pid));
