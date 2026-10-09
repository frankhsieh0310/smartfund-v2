// Loads the existing config/production-yahoo-daily-jobs.json (built for the stock daily pipeline)
// and resolves ETF rows onto it for this shadow-mode feature, per the task's explicit instruction to
// reuse timezone/session/holiday/stabilizationDelay data rather than build a second calendar.
//
// Task I change: resolution is now PRIMARILY by the Yahoo symbol's own suffix (etfs.data_source),
// not by etfs.exchange — a suffix like ".TW"/".HK"/".L" is an unambiguous, Yahoo-defined market
// marker that doesn't depend on this project's own (inconsistent) exchange-naming conventions
// (task H's ETF_EXCHANGE_TO_JOB_ID approach needed 13 ad-hoc string matches and still left "Taiwan"
// genuinely ambiguous between TWSE/TPEx — suffix resolves that cleanly via ".TW" vs ".TWO").
// etfs.exchange is now used only as a fallback to disambiguate suffix-less US tickers among the US
// jobs (nyse/nasdaq/amex/cboe), which otherwise look identical by symbol alone (e.g. "SPY").
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExchangeCalendarRegistry, ExchangeCalendarJob } from "./types";
import { SUPPLEMENTAL_MARKETS } from "./supplementalMarkets";

/** Yahoo suffix -> job id. The config-covered entries are cross-checked against that file's own
 * `yahooSuffixes` field where present (e.g. twse-yahoo-daily.yahooSuffixes === [".TW"]). The
 * "supplemental-*" entries point at SUPPLEMENTAL_MARKETS (added this round for countries the stock
 * config never covered at all). */
export const SUFFIX_TO_JOB_ID: Record<string, string> = {
  ".TW": "twse-yahoo-daily",
  ".TWO": "tpex-yahoo-daily",
  ".T": "japan-yahoo-daily",
  ".HK": "hong-kong-yahoo-daily",
  ".L": "united-kingdom-yahoo-daily",
  ".KS": "korea-yahoo-daily",
  ".KQ": "korea-yahoo-daily",
  ".TO": "canada-yahoo-daily",
  ".V": "canada-yahoo-daily",
  ".NE": "canada-yahoo-daily",
  ".AX": "australia-yahoo-daily",
  ".DE": "germany-yahoo-daily",
  ".F": "germany-yahoo-daily",
  ".PA": "france-yahoo-daily",
  ".MI": "italy-yahoo-daily",
  ".AS": "netherlands-yahoo-daily",
  ".SW": "switzerland-yahoo-daily",
  ".ST": "stockholm-yahoo-daily",
  ".SI": "singapore-yahoo-daily",
  ".SS": "shanghai-yahoo-daily",
  ".SZ": "shenzhen-yahoo-daily",
  ".MC": "spain-yahoo-daily",
  // Added from this round's live UNMAPPED breakdown — both carry forward a venue identification
  // Task H already made by name, just expressed as the actual Yahoo suffix instead of an exchange
  // string: ".DU" is Dusseldorf (job's "DUS" code, same Germany calendar); ".AQ" is Aquis Stock
  // Exchange (job's "AQS" code, same UK calendar) — not new guesses, bug fixes for the switch to
  // suffix-based lookup.
  ".DU": "germany-yahoo-daily",
  ".AQ": "united-kingdom-yahoo-daily",
  // Supplemental (no stock-config counterpart at all; see supplementalMarkets.ts):
  ".TA": "supplemental-tel-aviv",
  ".MX": "supplemental-mexico",
  ".VI": "supplemental-vienna",
  ".WA": "supplemental-warsaw",
  ".IS": "supplemental-istanbul",
  ".OL": "supplemental-oslo",
};

/** Suffix-less symbols fall back to etfs.exchange — covers both the US venues (none of which add a
 * Yahoo suffix at all) and a real, observed Production anomaly: 57 TWSE-exchange ETFs carry no
 * ".TW" suffix on their data_source despite being genuine TWSE listings (found via this round's live
 * UNMAPPED breakdown, "no-suffix:TWSE": 57) — exchange is the only signal available for those rows. */
export const NO_SUFFIX_EXCHANGE_FALLBACK: Record<string, string> = {
  TWSE: "twse-yahoo-daily",
  NYSEArca: "nyse-yahoo-daily",
  NYSE: "nyse-yahoo-daily",
  "NYSE American": "amex-yahoo-daily",
  NasdaqGM: "nasdaq-yahoo-daily",
  "Nasdaq GIDS": "nasdaq-yahoo-daily",
  "Cboe US": "cboe-yahoo-daily",
};

let cachedRegistry: ExchangeCalendarRegistry | null = null;

export async function loadExchangeCalendarRegistry(): Promise<ExchangeCalendarRegistry> {
  if (cachedRegistry) return cachedRegistry;
  const raw = await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8");
  const base = JSON.parse(raw) as ExchangeCalendarRegistry;
  cachedRegistry = { jobs: [...base.jobs, ...SUPPLEMENTAL_MARKETS] };
  return cachedRegistry;
}

function suffixOf(dataSource: string): string | null {
  const i = dataSource.lastIndexOf(".");
  return i === -1 ? null : dataSource.slice(i);
}

export type MarketResolution = { job: ExchangeCalendarJob; basis: "suffix" | "no-suffix-exchange-fallback" };

/** Resolves one ETF's Yahoo symbol (and, only for suffix-less tickers, its exchange) to the job
 * whose calendar governs it. Returns null — UNMAPPED, never guessed — if neither resolves. */
export function resolveJobForEtf(registry: ExchangeCalendarRegistry, dataSource: string, exchange: string | null): MarketResolution | null {
  const suf = suffixOf(dataSource);
  if (suf) {
    const jobId = SUFFIX_TO_JOB_ID[suf];
    if (!jobId) return null;
    const job = registry.jobs.find((j) => j.id === jobId && j.schedulerEnabled);
    return job ? { job, basis: "suffix" } : null;
  }
  if (exchange) {
    const jobId = NO_SUFFIX_EXCHANGE_FALLBACK[exchange];
    if (jobId) {
      const job = registry.jobs.find((j) => j.id === jobId && j.schedulerEnabled);
      if (job) return { job, basis: "no-suffix-exchange-fallback" };
    }
  }
  return null;
}

export function jobById(registry: ExchangeCalendarRegistry, jobId: string): ExchangeCalendarJob | null {
  return registry.jobs.find((j) => j.id === jobId && j.schedulerEnabled) ?? null;
}
