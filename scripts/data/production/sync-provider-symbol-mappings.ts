import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type Mapping = { market: string; canonicalSymbol: string; provider: string; providerSymbol: string; availability?: string; rule: string; reason: string; evidence?: string };
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const mappings = JSON.parse(await readFile(join(process.cwd(), "config", "provider-symbol-mappings.json"), "utf8")) as Mapping[];
  for (const mapping of mappings) {
    await prisma.$executeRawUnsafe(
      "INSERT INTO provider_symbol_mappings (market, canonical_symbol, provider, provider_symbol, availability, rule, reason, evidence, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) ON CONFLICT (market, canonical_symbol, provider) DO UPDATE SET provider_symbol = EXCLUDED.provider_symbol, availability = EXCLUDED.availability, rule = EXCLUDED.rule, reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, updated_at = NOW()",
      mapping.market, mapping.canonicalSymbol, mapping.provider, mapping.providerSymbol, mapping.availability ?? "ACTIVE", mapping.rule, mapping.reason, mapping.evidence ?? null,
    );
  }
  console.log(JSON.stringify({ synced: mappings.length, provider: "YAHOO" }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
