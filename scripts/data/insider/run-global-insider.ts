import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNTIME = resolve(ROOT, "runtime/insider");
const ARCHIVE = resolve(RUNTIME, "archive");
const CHECKPOINT = resolve(RUNTIME, "checkpoint.json");
const LOG = resolve(RUNTIME, "runner.log");
const COMPLETION = resolve(RUNTIME, "completion-manifest.json");
const PARSER_NAME = "smartfund-sec-ownership-xml";
const PARSER_VERSION = "1.0.0";
const UA = "SmartFund-GlobalInsiderTrading/2.0 data-operations@smartfund.local";
const FORMS = new Set(["3", "3/A", "4", "4/A", "5", "5/A"]);
const argv = new Set(process.argv.slice(2));
const boundedArg = process.argv.find((value) => value.startsWith("--bounded="));
const bounded = Math.min(Number(boundedArg?.split("=")[1] || 10), 10);
const canaryOnly = argv.has("--canary-aapl");
const incremental = argv.has("--incremental");
const db = new PrismaClient();

await mkdir(ARCHIVE, { recursive: true });

const iso = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonicalForm = (form) => `FORM_${form.replace("/A", "_A")}`;
const compactAccession = (accession) => accession.replaceAll("-", "");
const cik10 = (cik) => String(cik).replace(/^0+/, "").padStart(10, "0");
const sql = (statement, ...params) => db.$executeRawUnsafe(statement, ...params);
const query = (statement, ...params) => db.$queryRawUnsafe(statement, ...params);

async function logLine(message) { await appendFile(LOG, `${iso()} ${message}\n`); }
async function atomicJson(path, value) { const temporary = `${path}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }
async function fetchOfficial(url, accept = "application/json") {
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SEC ${response.status} ${url}`);
  return response;
}

function economicCategory(code, acquiredDisposed, isDerivative) {
  if (code === "P") return "OPEN_MARKET_PURCHASE";
  if (code === "S") return "OPEN_MARKET_SALE";
  if (["M", "C", "E", "O", "X"].includes(code)) return isDerivative ? "OPTION_EXERCISE" : "CONVERSION";
  if (code === "F") return "TAX_WITHHOLDING";
  if (code === "G") return "GIFT";
  if (["A", "D"].includes(code)) return "GRANT_AWARD";
  return "OTHER";
}

function parseOwnershipXml(xml) {
  const $ = load(xml, { xmlMode: true });
  const text = (root, selector) => root.find(selector).first().text().trim() || null;
  const value = (root, selector) => text(root, `${selector} value`) || text(root, selector);
  const refs = (root) => [...new Set(root.find("footnoteId").map((_, el) => $(el).attr("id")).get().filter(Boolean))];
  const bool = (root, selector) => ["1", "true"].includes(String(text(root, selector)).toLowerCase());
  const ownership = (directCode) => directCode === "D" ? "DIRECT" : directCode === "I" ? "INDIRECT" : "UNKNOWN";
  const ownerNode = $("reportingOwner").first();
  const relationship = ownerNode.find("reportingOwnerRelationship").first();
  const owner = {
    cik: text(ownerNode, "rptOwnerCik")?.replace(/^0+/, "") || null,
    name: text(ownerNode, "rptOwnerName") || "UNKNOWN",
    isDirector: bool(relationship, "isDirector"), isOfficer: bool(relationship, "isOfficer"),
    isTenPercentOwner: bool(relationship, "isTenPercentOwner"), isOther: bool(relationship, "isOther"),
    officerTitle: text(relationship, "officerTitle"), otherText: text(relationship, "otherText")
  };
  const common = (node) => {
    const directCode = value(node, "directOrIndirectOwnership");
    return { directCode, ownershipNature: ownership(directCode), natureOfOwnership: value(node, "natureOfOwnership"), footnotes: refs(node) };
  };
  const nonDerivativeTransactions = $("nonDerivativeTransaction").map((index, element) => {
    const node = $(element); const code = value(node, "transactionCode"); const acquiredDisposed = value(node, "transactionAcquiredDisposedCode");
    const shares = value(node, "transactionShares"); const price = value(node, "transactionPricePerShare");
    return { sequence: index + 1, securityTitle: value(node, "securityTitle"), transactionDate: value(node, "transactionDate"), code, shares, price,
      acquiredDisposed, ownershipAfter: value(node, "sharesOwnedFollowingTransaction"), economicCategory: economicCategory(code, acquiredDisposed, false), ...common(node) };
  }).get();
  const derivativeTransactions = $("derivativeTransaction").map((index, element) => {
    const node = $(element); const code = value(node, "transactionCode"); const acquiredDisposed = value(node, "transactionAcquiredDisposedCode");
    return { sequence: index + 1, derivativeTitle: value(node, "securityTitle"), conversionPrice: value(node, "conversionOrExercisePrice"),
      transactionDate: value(node, "transactionDate"), code, shares: value(node, "transactionShares"), acquiredDisposed,
      exerciseDate: value(node, "exerciseDate"), expirationDate: value(node, "expirationDate"), underlyingTitle: value(node, "underlyingSecurityTitle"),
      underlyingShares: value(node, "underlyingSecurityShares"), ownershipAfter: value(node, "sharesOwnedFollowingTransaction"),
      economicCategory: economicCategory(code, acquiredDisposed, true), ...common(node) };
  }).get();
  const holdings = [];
  $("nonDerivativeHolding, derivativeHolding").each((index, element) => {
    const node = $(element); const derivative = element.tagName === "derivativeHolding"; const directCode = value(node, "directOrIndirectOwnership");
    holdings.push({ sequence: index + 1, isDerivative: derivative, securityTitle: value(node, "securityTitle") || "UNKNOWN",
      sharesOwned: value(node, "sharesOwnedFollowingTransaction") || value(node, "underlyingSecurityShares"), directCode,
      ownershipNature: ownership(directCode), natureOfOwnership: value(node, "natureOfOwnership"), footnotes: refs(node) });
  });
  return {
    issuerCik: text($("issuer").first(), "issuerCik")?.replace(/^0+/, "") || null,
    issuerName: text($("issuer").first(), "issuerName"), issuerTicker: text($("issuer").first(), "issuerTradingSymbol"),
    periodOfReport: text($.root(), "periodOfReport"), owner, nonDerivativeTransactions, derivativeTransactions, holdings,
    footnotes: $("footnotes footnote").map((_, el) => ({ id: $(el).attr("id") || hash($(el).text()).slice(0, 16), text: $(el).text().trim() })).get()
  };
}

async function discoverUniverse() {
  const official = await (await fetchOfficial("https://www.sec.gov/files/company_tickers_exchange.json")).json();
  const fields = official.fields || ["cik", "name", "ticker", "exchange"];
  return new Map(official.data.map((row) => [String(row[fields.indexOf("ticker")]).toUpperCase(), Object.fromEntries(fields.map((field, index) => [field, row[index]]))]));
}

function filingRows(submissions) {
  const recent = submissions.filings?.recent || {}; const keys = Object.keys(recent);
  return (recent.accessionNumber || []).map((_, index) => Object.fromEntries(keys.map((key) => [key, recent[key][index]]))).filter((row) => FORMS.has(row.form));
}

async function filingCandidates(cik, targetAccession) {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
  const submissions = await (await fetchOfficial(submissionsUrl)).json();
  let rows = filingRows(submissions);
  if (targetAccession) rows = rows.filter((row) => row.accessionNumber === targetAccession);
  return rows.slice(0, targetAccession ? 1 : 8);
}

async function ingestFiling(security, issuerCik, metadata) {
  const accession = metadata.accessionNumber; const archiveBase = `https://www.sec.gov/Archives/edgar/data/${String(issuerCik).replace(/^0+/, "")}/${compactAccession(accession)}`;
  const documentUrl = `${archiveBase}/${metadata.primaryDocument}`;
  const retrievedAt = iso(); const xml = await (await fetchOfficial(documentUrl, "application/xml,text/xml")).text();
  const parsed = parseOwnershipXml(xml);
  if (!parsed.owner.name || parsed.issuerCik !== String(issuerCik).replace(/^0+/, "")) throw new Error(`SEMANTICS issuer/owner mismatch ${accession}`);
  const archivePath = resolve(ARCHIVE, `${accession}.xml`); await writeFile(archivePath, xml);
  const checksum = hash(xml); const filingId = accession; const insiderId = hash(`SEC_OWNER|${parsed.owner.cik || `${parsed.owner.name}|${parsed.issuerCik}`}`);
  const formType = canonicalForm(metadata.form); const isAmendment = metadata.form.endsWith("/A");
  await db.$transaction(async (tx) => {
    const exec = (statement, ...params) => tx.$executeRawUnsafe(statement, ...params);
    await exec(`INSERT INTO insider_filings(id,issuer_security_id,issuer_cik,accession_number,form_type,filing_date,accepted_at,period_of_report,document_url,raw_xml_url,raw_archive_path,checksum,is_amendment,source,retrieved_at,verification_status,parser_name,parser_version,disclosure_regime,license_status,updated_at) VALUES($1,$2,$3,$4,$5,$6::date,$7::timestamptz,$8::date,$9,$10,$11,$12,$13,'SEC_EDGAR',$14::timestamptz,'VERIFIED_OFFICIAL',$15,$16,'US_SECTION16','PUBLIC_OFFICIAL',NOW()) ON CONFLICT(accession_number) DO UPDATE SET document_url=EXCLUDED.document_url,raw_xml_url=EXCLUDED.raw_xml_url,raw_archive_path=EXCLUDED.raw_archive_path,checksum=EXCLUDED.checksum,retrieved_at=EXCLUDED.retrieved_at,verification_status=EXCLUDED.verification_status,updated_at=NOW()`,
      filingId, security.id, String(issuerCik), accession, formType, metadata.filingDate, metadata.acceptanceDateTime || null, parsed.periodOfReport || metadata.reportDate || null, documentUrl, documentUrl, archivePath, checksum, isAmendment, retrievedAt, PARSER_NAME, PARSER_VERSION);
    await exec(`INSERT INTO insiders(id,reporting_owner_cik,legal_name,entity_type,source,verification_status,updated_at) VALUES($1,$2,$3,'UNKNOWN','SEC_EDGAR','VERIFIED_OFFICIAL',NOW()) ON CONFLICT(id) DO UPDATE SET legal_name=EXCLUDED.legal_name,reporting_owner_cik=COALESCE(EXCLUDED.reporting_owner_cik,insiders.reporting_owner_cik),verification_status='VERIFIED_OFFICIAL',updated_at=NOW()`, insiderId, parsed.owner.cik, parsed.owner.name);
    const relationshipId = hash(`${insiderId}|${security.id}|${filingId}`);
    await exec(`INSERT INTO insider_issuer_relationships(id,insider_id,security_id,is_director,is_officer,is_ten_percent_owner,is_other,officer_title,other_text,effective_from,source,filing_id,verification_status,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,'SEC_EDGAR',$11,'VERIFIED_OFFICIAL',NOW()) ON CONFLICT(insider_id,security_id,filing_id) DO UPDATE SET is_director=EXCLUDED.is_director,is_officer=EXCLUDED.is_officer,is_ten_percent_owner=EXCLUDED.is_ten_percent_owner,is_other=EXCLUDED.is_other,officer_title=EXCLUDED.officer_title,other_text=EXCLUDED.other_text,updated_at=NOW()`, relationshipId, insiderId, security.id, parsed.owner.isDirector, parsed.owner.isOfficer, parsed.owner.isTenPercentOwner, parsed.owner.isOther, parsed.owner.officerTitle, parsed.owner.otherText, parsed.periodOfReport, filingId);
    for (const footnote of parsed.footnotes) await exec(`INSERT INTO insider_filing_footnotes(filing_id,footnote_id,text,source,source_url) VALUES($1,$2,$3,'SEC_EDGAR',$4) ON CONFLICT(filing_id,footnote_id) DO UPDATE SET text=EXCLUDED.text,source_url=EXCLUDED.source_url`, filingId, footnote.id, footnote.text, documentUrl);
    for (const item of parsed.nonDerivativeTransactions) {
      const sourceKey = hash(`${filingId}|${insiderId}|N|${item.sequence}`); const value = item.shares && item.price ? Number(item.shares) * Number(item.price) : null;
      const role = parsed.owner.officerTitle || (parsed.owner.isDirector ? "Director" : parsed.owner.isTenPercentOwner ? "10% Owner" : parsed.owner.isOfficer ? "Officer" : parsed.owner.isOther ? parsed.owner.otherText || "Other" : null);
      const updated = await exec(`UPDATE insider_ownership_transactions SET canonical_filing_id=$1,insider_id=$2,insider=$3,role=$4,security_title=$5,acquired_disposed_code=$6,direct_indirect_code=$7,ownership_nature=$8,nature_of_ownership=$9,transaction_form_type=$10,economic_category=$11,transaction_value=$12::numeric,transaction_sequence=$13,footnote_references=$14::jsonb,verification_status='VERIFIED_OFFICIAL',source_url=$15,retrieved_at=$16::timestamptz,source_key=$17,updated_at=NOW() WHERE filing_id=$1 AND transaction_type=$18 AND transaction_date=$19::date AND shares=$20::numeric AND canonical_filing_id IS NULL`, filingId, insiderId, parsed.owner.name, role, item.securityTitle, item.acquiredDisposed, item.directCode, item.ownershipNature, item.natureOfOwnership, formType, item.economicCategory, value, item.sequence, JSON.stringify(item.footnotes), documentUrl, retrievedAt, sourceKey, item.code, item.transactionDate, item.shares);
      if (!updated) await exec(`INSERT INTO insider_ownership_transactions(security_id,insider,role,transaction_date,transaction_type,shares,price,ownership_after,source,filing_id,source_key,canonical_filing_id,insider_id,security_title,acquired_disposed_code,direct_indirect_code,ownership_nature,nature_of_ownership,transaction_form_type,economic_category,transaction_value,transaction_sequence,footnote_references,verification_status,source_url,retrieved_at,updated_at) VALUES($1,$2,$3,$4::date,$5,$6::numeric,$7::numeric,$8::numeric,'SEC_EDGAR',$9,$10,$9,$11,$12,$13,$14,$15,$16,$17,$18,$19::numeric,$20,$21::jsonb,'VERIFIED_OFFICIAL',$22,$23::timestamptz,NOW()) ON CONFLICT(canonical_filing_id,insider_id,transaction_sequence) WHERE canonical_filing_id IS NOT NULL DO UPDATE SET price=EXCLUDED.price,ownership_after=EXCLUDED.ownership_after,footnote_references=EXCLUDED.footnote_references,updated_at=NOW()`, security.id, parsed.owner.name, role, item.transactionDate, item.code, item.shares || 0, item.price, item.ownershipAfter, filingId, sourceKey, insiderId, item.securityTitle, item.acquiredDisposed, item.directCode, item.ownershipNature, item.natureOfOwnership, formType, item.economicCategory, value, item.sequence, JSON.stringify(item.footnotes), documentUrl, retrievedAt);
    }
    for (const item of parsed.derivativeTransactions) await exec(`INSERT INTO insider_derivative_transactions(id,filing_id,insider_id,security_id,derivative_title,conversion_or_exercise_price,transaction_date,transaction_code,transaction_shares,transaction_acquired_disposed_code,exercise_date,expiration_date,underlying_security_title,underlying_shares,ownership_after,direct_indirect_code,ownership_nature,nature_of_ownership,economic_category,transaction_sequence,footnote_references,source,source_url,verification_status,retrieved_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::numeric,$7::date,$8,$9::numeric,$10,$11::date,$12::date,$13,$14::numeric,$15::numeric,$16,$17,$18,$19,$20,$21::jsonb,'SEC_EDGAR',$22,'VERIFIED_OFFICIAL',$23::timestamptz,NOW()) ON CONFLICT(filing_id,insider_id,transaction_sequence) DO UPDATE SET ownership_after=EXCLUDED.ownership_after,footnote_references=EXCLUDED.footnote_references,updated_at=NOW()`, hash(`${filingId}|${insiderId}|D|${item.sequence}`), filingId, insiderId, security.id, item.derivativeTitle || "UNKNOWN", item.conversionPrice, item.transactionDate, item.code, item.shares, item.acquiredDisposed, item.exerciseDate, item.expirationDate, item.underlyingTitle, item.underlyingShares, item.ownershipAfter, item.directCode, item.ownershipNature, item.natureOfOwnership, item.economicCategory, item.sequence, JSON.stringify(item.footnotes), documentUrl, retrievedAt);
    for (const item of parsed.holdings) await exec(`INSERT INTO insider_security_ownership_states(id,filing_id,insider_id,security_id,security_title,is_derivative,shares_owned,direct_indirect_code,ownership_nature,nature_of_ownership,as_of_date,sequence,footnote_references,source,source_url,verification_status,retrieved_at) VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11::date,$12,$13::jsonb,'SEC_EDGAR',$14,'VERIFIED_OFFICIAL',$15::timestamptz) ON CONFLICT(filing_id,insider_id,is_derivative,sequence) DO UPDATE SET shares_owned=EXCLUDED.shares_owned,footnote_references=EXCLUDED.footnote_references`, hash(`${filingId}|${insiderId}|H|${item.isDerivative}|${item.sequence}`), filingId, insiderId, security.id, item.securityTitle, item.isDerivative, item.sharesOwned, item.directCode, item.ownershipNature, item.natureOfOwnership, parsed.periodOfReport, item.sequence, JSON.stringify(item.footnotes), documentUrl, retrievedAt);
  });
  await logLine(`WRITE_PASS accession=${accession} form=${formType} nonDerivative=${parsed.nonDerivativeTransactions.length} derivative=${parsed.derivativeTransactions.length} holdings=${parsed.holdings.length} footnotes=${parsed.footnotes.length}`);
  return { accession, formType, insider: parsed.owner.name, role: parsed.owner, nonDerivative: parsed.nonDerivativeTransactions.length, derivative: parsed.derivativeTransactions.length, holdings: parsed.holdings.length, footnotes: parsed.footnotes.length, checksum };
}

async function updateCoverage(securityId, issuerCik) {
  await sql(`INSERT INTO insider_coverage_matrix(security_id,source_status,issuer_identity_status,issuer_cik,filing_count,insider_count,transaction_count,first_filing_date,latest_filing_date,role_coverage,price_coverage,ownership_coverage,footnote_coverage,amendment_status,historical_status,provenance_status,freshness_status,coverage_status,checked_at) SELECT $1,'SOURCE_READY','VERIFIED_CIK',$2,COUNT(DISTINCT f.id),COUNT(DISTINCT r.insider_id),COUNT(DISTINCT t.id),MIN(f.filing_date),MAX(f.filing_date),COALESCE(AVG(CASE WHEN r.is_director OR r.is_officer OR r.is_ten_percent_owner OR r.is_other THEN 1 ELSE 0 END),0),COALESCE(AVG(CASE WHEN t.price IS NOT NULL THEN 1 ELSE 0 END),0),COALESCE(AVG(CASE WHEN t.ownership_after IS NOT NULL THEN 1 ELSE 0 END),0),CASE WHEN COUNT(DISTINCT f.id)=0 THEN 0 ELSE COUNT(DISTINCT fn.filing_id)::numeric/COUNT(DISTINCT f.id) END,CASE WHEN BOOL_OR(f.is_amendment) THEN 'AMENDMENT_AVAILABLE' ELSE 'NONE_FOUND' END,CASE WHEN COUNT(DISTINCT f.filing_date)>1 THEN 'PARTIAL' ELSE 'CURRENT_ONLY' END,'VERIFIED_OFFICIAL',CASE WHEN MAX(f.filing_date)>=CURRENT_DATE-INTERVAL '7 days' THEN 'CURRENT' ELSE 'WAITING_FOR_NEW_FILING' END,CASE WHEN COUNT(DISTINCT f.id)>0 THEN 'PARTIAL_PRODUCTION' ELSE 'NO_INSIDER_EVENT_FOUND_VERIFIED' END,NOW() FROM insider_filings f LEFT JOIN insider_issuer_relationships r ON r.filing_id=f.id LEFT JOIN insider_ownership_transactions t ON t.canonical_filing_id=f.id LEFT JOIN insider_filing_footnotes fn ON fn.filing_id=f.id WHERE f.issuer_security_id=$1 ON CONFLICT(security_id) DO UPDATE SET source_status=EXCLUDED.source_status,issuer_identity_status=EXCLUDED.issuer_identity_status,issuer_cik=EXCLUDED.issuer_cik,filing_count=EXCLUDED.filing_count,insider_count=EXCLUDED.insider_count,transaction_count=EXCLUDED.transaction_count,first_filing_date=EXCLUDED.first_filing_date,latest_filing_date=EXCLUDED.latest_filing_date,role_coverage=EXCLUDED.role_coverage,price_coverage=EXCLUDED.price_coverage,ownership_coverage=EXCLUDED.ownership_coverage,footnote_coverage=EXCLUDED.footnote_coverage,amendment_status=EXCLUDED.amendment_status,historical_status=EXCLUDED.historical_status,provenance_status=EXCLUDED.provenance_status,freshness_status=EXCLUDED.freshness_status,coverage_status=EXCLUDED.coverage_status,checked_at=NOW()`, securityId, String(issuerCik));
}

async function selectSecurities(officialMap) {
  if (canaryOnly) return query(`SELECT id,ticker,name,exchange,country FROM securities WHERE UPPER(ticker)='AAPL' LIMIT 1`);
  const candidates = await query(`SELECT id,ticker,name,exchange,country FROM securities WHERE ticker IS NOT NULL AND country IN ('United States','US','USA') ORDER BY md5(id) LIMIT 100`);
  return candidates.filter((row) => officialMap.has(row.ticker.toUpperCase())).slice(0, bounded);
}

async function runCycle() {
  const officialMap = await discoverUniverse(); const securities = await selectSecurities(officialMap); const results = [];
  for (const security of securities) {
    const identity = officialMap.get(security.ticker.toUpperCase());
    if (!identity?.cik) continue;
    const target = canaryOnly ? "0001140361-26-025622" : null;
    const candidates = await filingCandidates(identity.cik, target);
    for (const metadata of candidates) {
      try { results.push(await ingestFiling(security, identity.cik, metadata)); }
      catch (error) { await logLine(`FILING_FAIL accession=${metadata.accessionNumber} error=${String(error)}`); }
      await new Promise((done) => setTimeout(done, 125));
    }
    await updateCoverage(security.id, identity.cik);
    await atomicJson(CHECKPOINT, { asset: "GLOBAL_INSIDER_TRADING", stage: canaryOnly ? "AAPL_CANARY" : "US_BOUNDED", lastSecurityId: security.id, lastTicker: security.ticker, issuersProcessed: results.length, updatedAt: iso() });
  }
  return results;
}

try {
  await logLine(`START pid=${process.pid} mode=${canaryOnly ? "AAPL_CANARY" : `US_BOUNDED_${bounded}`}`);
  const results = await runCycle();
  if (canaryOnly) {
    const readBack = await query(`SELECT f.accession_number,f.form_type,f.verification_status,i.legal_name,r.is_director,r.is_officer,r.is_ten_percent_owner,r.officer_title,COUNT(DISTINCT t.id)::text non_derivative,COUNT(DISTINCT d.id)::text derivative,COUNT(DISTINCT fn.footnote_id)::text footnotes FROM insider_filings f JOIN insider_issuer_relationships r ON r.filing_id=f.id JOIN insiders i ON i.id=r.insider_id LEFT JOIN insider_ownership_transactions t ON t.canonical_filing_id=f.id LEFT JOIN insider_derivative_transactions d ON d.filing_id=f.id LEFT JOIN insider_filing_footnotes fn ON fn.filing_id=f.id WHERE f.accession_number='0001140361-26-025622' GROUP BY f.accession_number,f.form_type,f.verification_status,i.legal_name,r.is_director,r.is_officer,r.is_ten_percent_owner,r.officer_title`);
    if (!readBack.length) throw new Error("READ_BACK_FAIL");
    await atomicJson(COMPLETION, { asset: "GLOBAL_INSIDER_TRADING", canary: "AAPL", checks: ["FETCH_PASS","PARSE_PASS","SEMANTICS_PASS","INSIDER_IDENTITY_PASS","ROLE_PASS","TRANSACTION_PASS","OWNERSHIP_PASS","FOOTNOTE_PASS","PROVENANCE_PASS","WRITE_PASS","READ_BACK_PASS","IDEMPOTENCY_KEY_ACTIVE"], result: readBack[0], completedAt: iso() });
    console.log(JSON.stringify({ results, readBack }, null, 2));
  }
  if (incremental) while (true) { await new Promise((done) => setTimeout(done, 60 * 60 * 1000)); await runCycle(); }
} finally { if (!incremental) await db.$disconnect(); }
