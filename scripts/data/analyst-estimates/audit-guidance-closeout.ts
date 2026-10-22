import { PrismaClient } from "@prisma/client";
async function main() {
const p = new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL??process.env.DIRECT_URL}}});
try {
const q=(sql:string)=>p.$queryRawUnsafe(sql);
const results=[];
for(const sql of [
 `SELECT actual_link_state,COUNT(*)::int n FROM company_guidance GROUP BY 1 ORDER BY 1`,
 `SELECT outcome_state,COUNT(*)::int n FROM company_guidance GROUP BY 1 ORDER BY 1`,
 `SELECT freshness_state,COUNT(*)::int n FROM company_guidance GROUP BY 1 ORDER BY 1`,
 `SELECT COUNT(DISTINCT stock_id)::int issuers,COUNT(*)::int records,COUNT(*) FILTER(WHERE fiscal_period_id IS NOT NULL)::int normalized,COUNT(*) FILTER(WHERE actual_link_state='UNKNOWN' OR outcome_state LIKE '%UNKNOWN%' OR freshness_state='UNKNOWN')::int unknown FROM company_guidance`,
 `SELECT COUNT(*)::int rows,COUNT(*) FILTER(WHERE guidance_source_state='UNKNOWN' OR guidance_history_state='UNKNOWN' OR revision_state='UNKNOWN' OR actual_link_status='UNKNOWN' OR outcome_state='UNKNOWN' OR analyst_license_state='UNKNOWN' OR consensus_state='UNKNOWN' OR target_price_state='UNKNOWN' OR rating_state='UNKNOWN' OR provenance_state='UNKNOWN' OR freshness_state='UNKNOWN' OR detail_state='UNKNOWN')::int unknown FROM analyst_estimate_coverage_matrix`,
 `SELECT revision_type,COUNT(*)::int n FROM company_guidance_revisions GROUP BY 1`,
 `SELECT outcome,COUNT(*)::int n FROM company_guidance_outcomes GROUP BY 1`,
 `SELECT (SELECT COUNT(*) FROM analyst_consensus_snapshots)::int consensus,(SELECT COUNT(*) FROM analyst_target_prices)::int targets,(SELECT COUNT(*) FROM analyst_ratings)::int ratings,(SELECT COUNT(*) FROM analyst_estimate_revisions)::int revisions`,
 `SELECT metric,COUNT(*)::int rows,COUNT(DISTINCT stock_id)::int issuers FROM company_guidance GROUP BY 1 ORDER BY 1`,
 `SELECT guidance_history_state,COUNT(*)::int issuers FROM analyst_estimate_coverage_matrix WHERE detail_state='GUIDANCE_PROFESSIONAL_READY' GROUP BY 1 ORDER BY 1`,
 `SELECT license_status,COUNT(*)::int n FROM analyst_estimate_providers GROUP BY 1`,
 `SELECT MIN(announcement_date) earliest,MAX(announcement_date) latest,COUNT(*) FILTER(WHERE point_value IS NOT NULL)::int point_rows,COUNT(*) FILTER(WHERE low_value IS NOT NULL AND high_value IS NOT NULL)::int range_rows,COUNT(*) FILTER(WHERE source_url IS NOT NULL AND source_record_id IS NOT NULL)::int provenance_rows FROM company_guidance`,
 `SELECT source,COUNT(DISTINCT stock_id)::int stocks,COUNT(DISTINCT source_record_id)::int documents,COUNT(*)::int rows,MIN(announcement_date) earliest,MAX(announcement_date) latest FROM company_guidance GROUP BY 1 ORDER BY 1`,
 `SELECT COALESCE(s.exchange,'UNKNOWN') market,COUNT(DISTINCT g.stock_id)::int stocks,COUNT(*)::int rows,MIN(g.announcement_date) earliest,MAX(g.announcement_date) latest FROM company_guidance g JOIN stocks s ON s.id=g.stock_id GROUP BY 1 ORDER BY 1`,
 `SELECT COUNT(*)::int stocks FROM (SELECT stock_id FROM company_guidance GROUP BY stock_id HAVING COUNT(*)>1) x`,
 `SELECT COUNT(*) FILTER(WHERE fiscal_period_id IS NULL)::int invalid_period_links,COUNT(*) FILTER(WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$')::int invalid_currency_units,COUNT(*) FILTER(WHERE effective_as_of<known_at)::int lookahead_conflicts,(COUNT(*)-COUNT(DISTINCT source_key))::int duplicate_guidance_rows FROM company_guidance`,
 `SELECT COUNT(*) FILTER(WHERE known_at IS NOT NULL)::int known_at_rows,COUNT(*) FILTER(WHERE effective_as_of IS NOT NULL)::int effective_as_of_rows,COUNT(*) FILTER(WHERE known_at IS NULL AND effective_as_of IS NULL AND pit_evidence_status='PIT_EVIDENCE_INCOMPLETE')::int pit_evidence_incomplete,COUNT(*) FILTER(WHERE known_at<=NOW() AND effective_as_of<=NOW())::int current_as_of_visible FROM company_guidance`
]) results.push(await q(sql));
const [actual,outcome,freshness,totals,matrix,revision,outcomes,analyst,metrics,history,providers,datesAndTypes,sources,markets,multiple,quality,pit]=results;
console.log(JSON.stringify({actual,outcome,freshness,totals,matrix,revision,outcomes,analyst,metrics,history,providers,datesAndTypes,sources,markets,multiple,quality,pit},null,2));
const productionRows=await q(`SELECT s.ticker,g.metric,g.low_value,g.high_value,g.point_value,g.unit,g.currency,g.guidance_period,g.announcement_date,g.known_at,g.filing_id,g.source_text FROM company_guidance g JOIN stocks s ON s.id=g.stock_id WHERE g.parser_version='GUIDANCE_PRODUCTION_V1' ORDER BY g.known_at,g.metric`);
console.log(JSON.stringify({productionRows},null,2));
} finally {
await p.$disconnect();
}
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
