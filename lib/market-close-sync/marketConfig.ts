// Loads the existing config/production-yahoo-daily-jobs.json (built for the stock daily pipeline)
// and re-maps it onto ETF rows for this shadow-mode feature, per the task's explicit instruction to
// reuse timezone/session/holiday/stabilizationDelay data rather than build a second calendar.
//
// IMPORTANT, project-specific gotcha this file exists to isolate: etfs.exchange uses a DIFFERENT
// naming convention than config/production-yahoo-daily-jobs.json's `exchanges` codes (which were
// written for stocks.exchange). Observed values (2026-10-09, direct Production query) include
// "NYSEArca", "NasdaqGM", "Cboe US", "Cboe UK", "Tokyo", "HKSE", "Milan", "XETRA", "Vienna",
// "Toronto", "Tel Aviv", "Amsterdam", "Taiwan", "Taipei Exchange", "Nasdaq GIDS", "Warsaw",
// "Jakarta", "SES" — none of which are a byte-for-byte match for the stock-side codes like "NASDAQ",
// "NMS", "HKG", "JPX", "MIL", "TOR". ETF_EXCHANGE_TO_JOB_ID below is an explicit, conservative
// mapping built from this session's own live DB sampling — only exchanges with a clearly-correct,
// unambiguous stock-calendar counterpart are mapped. An ETF exchange with no entry here is simply
// never eligible (skipped, not guessed) rather than risk aligning it to the wrong market calendar.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExchangeCalendarRegistry, ExchangeCalendarJob } from "./types";

export const ETF_EXCHANGE_TO_JOB_ID: Record<string, string> = {
  NYSEArca: "nyse-yahoo-daily",
  NasdaqGM: "nasdaq-yahoo-daily",
  "Nasdaq GIDS": "nasdaq-yahoo-daily",
  "Cboe US": "cboe-yahoo-daily",
  Tokyo: "japan-yahoo-daily",
  HKSE: "hong-kong-yahoo-daily",
  Milan: "italy-yahoo-daily",
  XETRA: "germany-yahoo-daily",
  Toronto: "canada-yahoo-daily",
  Amsterdam: "netherlands-yahoo-daily",
  TWSE: "twse-yahoo-daily",
  "Taipei Exchange": "tpex-yahoo-daily",
  TPEx: "tpex-yahoo-daily",
  SES: "singapore-yahoo-daily",

  // Added 2026-10-10 (task H exchange-coverage pass), each with its own match basis — the exact
  // job's timezone/session/holidays/stabilizationDelayMinutes this entry inherits:
  LSE: "united-kingdom-yahoo-daily", // exact string match: job.exchanges includes "LSE" literally
  IOB: "united-kingdom-yahoo-daily", // exact string match: job.exchanges includes "IOB" literally
  // "AQS" is the job's code for the London-listed Aquis Stock Exchange; "Aquis AQSE" is the ETF
  // table's own name for the same venue (AQSE = Aquis Stock Exchange) — same market, same calendar.
  "Aquis AQSE": "united-kingdom-yahoo-daily",
  ASX: "australia-yahoo-daily", // exact string match: job.exchanges includes "ASX" literally
  // "FRA" (job code) is the standard short code for the Frankfurt Stock Exchange; "Frankfurt" /
  // "Dusseldorf" are the ETF table's own city-named venues for FRA and the job's "DUS" code
  // respectively — both already under the same Germany job's exchanges array, same trading calendar.
  Frankfurt: "germany-yahoo-daily",
  Dusseldorf: "germany-yahoo-daily",
  NYSE: "nyse-yahoo-daily", // exact string match: job.exchanges includes "NYSE" literally
  // "NYSE American" is the current official name of the exchange the job still lists under its
  // historical code "ASE" (NYSE American was formerly AMEX) — same venue, same calendar.
  "NYSE American": "amex-yahoo-daily",
  Paris: "france-yahoo-daily", // job.exchanges includes "PAR" (Euronext Paris); same city/venue
  MCE: "spain-yahoo-daily", // exact string match: job.exchanges includes "MCE" literally
  // "Swiss" (ETF table) and the job's "EBS" code both refer to SIX Swiss Exchange (EBS = its
  // electronic-bourse trading code) — single Swiss market, no other Swiss job exists to confuse it with.
  Swiss: "switzerland-yahoo-daily",
  // "Stockholm" (ETF table) and the job's "STO" code are the same venue by name (Stockholmsbörsen).
  Stockholm: "stockholm-yahoo-daily",
  // "KSE" here is Korea's exchange, consistent with this same country already having "KOE"/"KSC" job
  // codes under korea-yahoo-daily — included on country-level confidence (not a byte-identical code
  // match like the others above); if this turns out to be a different Korea-adjacent venue with its
  // own holiday calendar, this is the single line to revisit.
  KSE: "korea-yahoo-daily",

  // Deliberately NOT mapped — no confident match found, left unmapped rather than guessed:
  // "Cboe UK" (ambiguous: job's uk exchanges array has "CXE"/"AQS"/"IOB"/"LSE" but none is
  //   confirmed as literally "Cboe UK" by name or code),
  // "Tel Aviv", "Mexico", "Vienna", "Warsaw", "Jakarta", "Istanbul", "Budapest", "HOSE", "Saudi",
  //   "Oslo", "Qatar" (no job exists for these countries in this config at all),
  // "Taiwan" (too ambiguous between the existing twse/tpex jobs to assign to one without guessing),
  // "OTC Markets OTCPK"/"OTCID"/"OTCQX"/"OTCQB", "Cboe CA" (no corresponding job/code found).
};

let cachedRegistry: ExchangeCalendarRegistry | null = null;

export async function loadExchangeCalendarRegistry(): Promise<ExchangeCalendarRegistry> {
  if (cachedRegistry) return cachedRegistry;
  const raw = await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8");
  cachedRegistry = JSON.parse(raw) as ExchangeCalendarRegistry;
  return cachedRegistry;
}

export function jobForEtfExchange(registry: ExchangeCalendarRegistry, etfExchange: string): ExchangeCalendarJob | null {
  const jobId = ETF_EXCHANGE_TO_JOB_ID[etfExchange];
  if (!jobId) return null;
  const job = registry.jobs.find((j) => j.id === jobId && j.schedulerEnabled);
  return job ?? null;
}
