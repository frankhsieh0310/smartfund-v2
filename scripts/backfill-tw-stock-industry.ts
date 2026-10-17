// 2026-10-18 修正一 (TW side): populate stocks.industry from TWSE/TPEx's own official ISIN registry
// pages (isin.twse.com.tw/isin/C_public.jsp?strMode=2 for 上市/listed, strMode=4 for 上櫃/OTC), which
// carry the official 產業別 (industry category) TEXT directly per security row -- no numeric-code
// translation table needed/guessed (a real numeric code->name mapping could not be verified from an
// authoritative source, so this avoids that risk entirely by using the page that already gives the
// name as text). Pages are served with a UTF-8 Content-Type header but are actually Big5-encoded
// (verified: UTF-8 decoding produces garbage, Big5 decoding produces readable Chinese) -- decoded with
// `iconv -c` to skip the registry's own occasional invalid byte sequences (e.g. in some TDR/warrant
// rows) rather than aborting the whole parse.
// Dry run by default; --write actually updates stocks.industry (no DDL -- the column already exists).
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { prisma } from "@/lib/prisma";

type Row = { code: string; name: string; market: string; industry: string };

async function fetchAndParse(strMode: number): Promise<Row[]> {
  const res = await fetch(`https://isin.twse.com.tw/isin/C_public.jsp?strMode=${strMode}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rawPath = `${process.cwd()}/tw-industry-${strMode}.raw`;
  const utf8Path = `${process.cwd()}/tw-industry-${strMode}.utf8`;
  writeFileSync(rawPath, buf);
  // iconv -c exits 1 whenever it SKIPPED any invalid byte sequence (expected/routine for this
  // registry -- a few TDR/warrant rows have malformed bytes) even though it still wrote the rest of
  // the file correctly, so a nonzero exit here is not itself a failure.
  try {
    execSync(`iconv -f big5 -t utf-8 -c "${rawPath}" > "${utf8Path}"`);
  } catch {
    /* see comment above */
  }
  const html = readFileSync(utf8Path, "utf8");
  unlinkSync(rawPath);
  unlinkSync(utf8Path);

  const rows: Row[] = [];
  const re = /<tr><td bgcolor=#FAFAD2>([0-9A-Za-z]{2,6})　([^<]+)<\/td><td bgcolor=#FAFAD2>([A-Z0-9]*)<\/td><td bgcolor=#FAFAD2>([0-9/]*)<\/td><td bgcolor=#FAFAD2>([^<]*)<\/td><td bgcolor=#FAFAD2>([^<]*)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const code = m[1];
    const industry = m[6];
    // Scope to ordinary 4-digit equity tickers only -- this registry also lists ETFs, warrants,
    // TDRs, bonds, REITs etc. under the same table, most with no industry value anyway, but a
    // 4-digit numeric code is the one reliable signal that this row is an ordinary listed stock.
    if (!/^\d{4}$/.test(code) || !industry) continue;
    rows.push({ code, name: m[2], market: m[5], industry });
  }
  return rows;
}

async function main() {
  const writeEnabled = process.argv.includes("--write");
  const [listed, otc] = await Promise.all([fetchAndParse(2), fetchAndParse(4)]);
  const all = [...listed, ...otc];
  console.log(`Parsed: ${listed.length} TWSE-listed, ${otc.length} TPEx rows with industry, ${all.length} total`);

  const before = await prisma.$queryRawUnsafe<Array<{ c: number; has: number }>>(
    `SELECT count(*)::int AS c, count(industry)::int AS has FROM stocks WHERE country = 'TW'`,
  );
  console.log("BEFORE:", before[0]);

  if (!writeEnabled) {
    console.log("DRY RUN sample (first 5):", all.slice(0, 5));
    return;
  }

  let updated = 0;
  for (const r of all) {
    const res = await prisma.$executeRawUnsafe(
      `UPDATE stocks SET industry = $1, updated_at = NOW() WHERE country = 'TW' AND ticker = $2`,
      r.industry,
      r.code,
    );
    updated += res;
  }
  console.log(`Updated ${updated} stock rows.`);

  const after = await prisma.$queryRawUnsafe<Array<{ c: number; has: number }>>(
    `SELECT count(*)::int AS c, count(industry)::int AS has FROM stocks WHERE country = 'TW'`,
  );
  console.log("AFTER:", after[0]);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
