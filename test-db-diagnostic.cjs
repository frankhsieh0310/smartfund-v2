const util = require("node:util");
const { PrismaClient } = require("@prisma/client");
const { version: prismaVersion } = require("@prisma/client/package.json");

const TIMEOUT_MS = 15_000;
const sensitiveValues = new Set();

function remember(value) {
  if (typeof value !== "string" || value.length < 4) return;
  sensitiveValues.add(value);
  try {
    sensitiveValues.add(decodeURIComponent(value));
  } catch {
    // A malformed percent-encoding is kept in its original form only.
  }
}

for (const name of [
  "DATABASE_URL",
  "DIRECT_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
]) {
  const value = process.env[name];
  remember(value);
  if (!value) continue;

  try {
    const parsed = new URL(value);
    remember(parsed.hostname);
    remember(parsed.username);
    remember(parsed.password);
    for (const part of parsed.hostname.split(".")) remember(part);
    for (const part of parsed.username.split(/[.:@_-]/)) remember(part);
  } catch {
    // Invalid URLs are still redacted as complete values above.
  }
}

for (const [name, value] of Object.entries(process.env)) {
  if (/(?:KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE|ANON)/i.test(name)) {
    remember(value);
  }
}

function redact(input) {
  let output = String(input ?? "<none>");

  for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }

  return output
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s'"`]+/gi, "[REDACTED_URL]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi, "[REDACTED_HOST]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/gi, "[REDACTED_IP]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_IDENTIFIER]");
}

function errorCause(error) {
  const cause = error?.cause;
  if (cause == null) return "<none>";

  if (cause instanceof Error) {
    return redact(
      util.inspect(
        {
          name: cause.name,
          code: cause.code ?? cause.errorCode ?? "<none>",
          message: cause.message,
        },
        { depth: 2, breakLength: Infinity },
      ),
    );
  }

  return redact(util.inspect(cause, { depth: 2, breakLength: Infinity }));
}

function outputError(error, elapsedMs, timedOut) {
  const stackLines = redact(error?.stack || "<none>")
    .split(/\r?\n/)
    .slice(0, 10);

  console.log("FAIL");
  console.log(`error.name=${redact(error?.name || "Error")}`);
  console.log(`error.code=${redact(error?.code || error?.errorCode || "<none>")}`);
  console.log(`error.message=${redact(error?.message || "<none>")}`);
  console.log(`error.cause=${errorCause(error)}`);
  console.log("error.stack.first_10_lines=");
  for (const line of stackLines) console.log(line);
  console.log(`total_elapsed_ms=${elapsedMs}`);
  console.log(`timeout=${timedOut}`);
  console.log(`node.version=${process.version}`);
  console.log(`prisma.version=${prismaVersion}`);
}

function outputPass(elapsedMs) {
  console.log("PASS");
  console.log("error.name=<none>");
  console.log("error.code=<none>");
  console.log("error.message=<none>");
  console.log("error.cause=<none>");
  console.log("error.stack.first_10_lines=<none>");
  console.log(`total_elapsed_ms=${elapsedMs}`);
  console.log("timeout=false");
  console.log(`node.version=${process.version}`);
  console.log(`prisma.version=${prismaVersion}`);
}

(async () => {
  const startedAt = Date.now();
  const database = new PrismaClient({ log: [] });
  let timeoutHandle;
  let exitCode = 0;

  const timeoutError = new Error("SELECT 1 did not complete within 15000 ms");
  timeoutError.name = "DiagnosticTimeoutError";
  timeoutError.code = "DIAGNOSTIC_TIMEOUT";

  try {
    const deadline = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), TIMEOUT_MS);
    });

    await Promise.race([database.$queryRawUnsafe("SELECT 1"), deadline]);
    clearTimeout(timeoutHandle);
    outputPass(Date.now() - startedAt);
  } catch (error) {
    clearTimeout(timeoutHandle);
    const timedOut = error === timeoutError || error?.code === "DIAGNOSTIC_TIMEOUT";
    outputError(error, Date.now() - startedAt, timedOut);
    exitCode = timedOut ? 2 : 1;
  } finally {
    try {
      await Promise.race([
        database.$disconnect(),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch {
      // Deliberately suppressed to avoid emitting connection metadata.
    }
  }

  setTimeout(() => process.exit(exitCode), 25);
})();
