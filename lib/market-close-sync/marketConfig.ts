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
  // Deliberately NOT mapped (no confident 1:1 stock-calendar counterpart in this config, as of
  // 2026-10-09): "Cboe UK", "Vienna", "Tel Aviv", "Warsaw", "Jakarta", "Taiwan", "Paris", "Frankfurt",
  // "Dusseldorf" — adding any of these requires confirming the right job id first, not guessing.
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
