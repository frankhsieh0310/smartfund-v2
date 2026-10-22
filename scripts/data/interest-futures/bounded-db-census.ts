import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const rawUrl = process.env.DATABASE_URL;
const diagnostics = { databaseUrlAvailable: Boolean(rawUrl), urlValid: false, protocol: null, host: null, port: null, dns: null, tcp: null, sslMode: null, prismaClientVersion: Prisma.prismaVersion.client };

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port), timeout: 5000 });
    socket.once("connect", () => { socket.destroy(); resolve("CONNECTED"); });
    socket.once("timeout", () => { socket.destroy(); resolve("TIMEOUT"); });
    socket.once("error", (error) => resolve(`FAILED_${error.code || "UNKNOWN"}`));
  });
}
function classify(error) {
  const message = String(error?.message || "");
  if (/authentication failed|password authentication failed|P1000/i.test(message)) return "AUTH_FAILURE";
  if (/TLS|SSL|certificate/i.test(message)) return "TLS_FAILURE";
  if (/too many connections|connection limit/i.test(message)) return "CONNECTION_LIMIT";
  if (/P1001|can't reach database|timed out|connect.*failed/i.test(message)) return diagnostics.dns !== "RESOLVED" ? "DNS_FAILURE" : diagnostics.tcp === "CONNECTED" ? "DATABASE_UNREACHABLE" : "NETWORK_EDGE_BLOCK";
  if (/pgbouncer|pooler/i.test(message)) return "POOLER_FAILURE";
  if (/invalid.*database|database.*does not exist|P1003/i.test(message)) return "ENV_CONFIGURATION_ERROR";
  return "PRISMA_CLIENT_ERROR";
}

try {
  if (!rawUrl) throw Object.assign(new Error("DATABASE_URL_MISSING"), { code: "DATABASE_URL_MISSING" });
  const parsed = new URL(rawUrl);
  diagnostics.urlValid = ["postgres:", "postgresql:"].includes(parsed.protocol);
  diagnostics.protocol = parsed.protocol.replace(":", "");
  diagnostics.host = parsed.hostname;
  diagnostics.port = parsed.port || "5432";
  diagnostics.sslMode = parsed.searchParams.get("sslmode") || "UNSPECIFIED";
  if (!diagnostics.urlValid) throw Object.assign(new Error("DATABASE_URL_PROTOCOL_INVALID"), { code: "DATABASE_URL_PROTOCOL_INVALID" });
  try { diagnostics.dns = (await lookup(parsed.hostname)).address ? "RESOLVED" : "FAILED"; } catch { diagnostics.dns = "BLOCKED_OR_UNRESOLVED"; }
  diagnostics.tcp = await tcpCheck(diagnostics.host, diagnostics.port);
  await prisma.$queryRawUnsafe("SELECT 1 AS connection_check");
  const relations = await prisma.$queryRawUnsafe(
    "SELECT to_regclass('public.futures_contracts')::text AS contracts, to_regclass('public.futures_observations')::text AS observations",
  );
  if (!relations[0]?.contracts || !relations[0]?.observations) {
    console.log(JSON.stringify({ status: "VERIFIED_RELATION_MISSING", diagnostics, relations: relations[0] }));
  } else {
    const universe = JSON.parse(await readFile(join(process.cwd(), "config", "interest-futures-universe.json"), "utf8"));
    const roots = universe.instruments.map((instrument) => instrument.rootSymbol);
    const contractColumns = await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='futures_contracts' ORDER BY ordinal_position");
    const observationColumns = await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='futures_observations' ORDER BY ordinal_position");
    const contracts = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS records, COUNT(DISTINCT root_symbol)::int AS entities
      FROM futures_contracts WHERE root_symbol IN (${Prisma.join(roots)})
    `;
    const observations = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS records, COUNT(DISTINCT o.contract_id)::int AS contracts_covered,
             MIN(o.observed_at) AS earliest_date, MAX(o.observed_at) AS latest_date,
             COUNT(DISTINCT o.source)::int AS source_count
      FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id
      WHERE c.root_symbol IN (${Prisma.join(roots)})
    `;
    const duplicateKeys = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS duplicate_key_groups FROM (
        SELECT o.source_key FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id
        WHERE c.root_symbol IN (${Prisma.join(roots)}) GROUP BY o.source_key HAVING COUNT(*) > 1
      ) duplicate_groups
    `;
    const contractRequired = ["id", "underlying", "exchange", "root_symbol", "contract_symbol", "contract_month", "expiration", "currency", "source", "status"];
    const observationRequired = ["id", "contract_id", "observed_at", "settlement", "source", "source_key", "source_record_id", "source_url", "verification_status", "quality_status", "retrieved_at"];
    const contractNames = contractColumns.map((row) => row.column_name);
    const observationNames = observationColumns.map((row) => row.column_name);
    const missingContractColumns = contractRequired.filter((name) => !contractNames.includes(name));
    const missingObservationColumns = observationRequired.filter((name) => !observationNames.includes(name));
    const schemaCompatibility = missingContractColumns.length || missingObservationColumns.length ? "SCHEMA_EXTENSION_REQUIRED" : "SCHEMA_REUSED_SEMANTIC_MAPPING";
    console.log(JSON.stringify({ status: "VERIFIED_AVAILABLE", diagnostics, scope: { asset: "INTEREST_RATE_FUTURES", roots }, relations: { futuresContracts: "EXISTS", futuresObservations: "EXISTS" }, contracts: contracts[0], observations: observations[0], duplicateKeys: duplicateKeys[0], schema: { status: schemaCompatibility, contractColumns: contractNames, observationColumns: observationNames, missingContractColumns, missingObservationColumns } }));
  }
} catch (error) {
  console.log(JSON.stringify({ status: "ACCESS_BLOCKED_CONFIRMED", rootCause: classify(error), diagnostics, errorClass: error?.code || error?.name || "UNKNOWN" }));
} finally {
  await prisma.$disconnect();
}
