// Supplemental market calendars for Yahoo-symbol suffixes with NO counterpart anywhere in
// config/production-yahoo-daily-jobs.json (that file is not modified by this feature — these are
// new, additive entries living only here). Per task scope: timezone + regular session + weekday
// trading days are enough; no holiday table is required — a real holiday simply produces no new
// Spark candle for that date, which pickClosedCandle already reports as SOURCE_MISSING (not a wrong
// write), so an incomplete calendar is safe by construction, just less efficient.
//
// Each entry's timezone/session is general public knowledge about that exchange's own trading
// hours, NOT independently re-verified against a live source this session (unlike the config file's
// own entries, which cite a holidayCalendarSource) — flagged ESTIMATED confidence per entry below.
// If one of these turns out wrong, the damage is bounded to SOURCE_MISSING/false-intraday-rejection
// for that one market, never a wrong price write (shadow mode doesn't write prices at all).

import type { ExchangeCalendarJob } from "./types";

const MON_FRI = [1, 2, 3, 4, 5];

export const SUPPLEMENTAL_MARKETS: ExchangeCalendarJob[] = [
  {
    // ESTIMATED basis: Tel Aviv Stock Exchange trades Sunday-Thursday (Israeli work week), not
    // Mon-Fri — this is the one entry here with a non-standard weekday set.
    id: "supplemental-tel-aviv", market: "Tel Aviv", exchange: "Tel Aviv", exchanges: [], country: "IL",
    timezone: "Asia/Jerusalem", regularSession: { open: "09:59", close: "17:30" }, stabilizationDelayMinutes: 30,
    weekdays: [0, 1, 2, 3, 4], holidays: [], schedulerEnabled: true,
  },
  {
    // ESTIMATED basis: Bolsa Mexicana de Valores regular session, local time.
    id: "supplemental-mexico", market: "Mexico", exchange: "Mexico", exchanges: [], country: "MX",
    timezone: "America/Mexico_City", regularSession: { open: "08:30", close: "15:00" }, stabilizationDelayMinutes: 30,
    weekdays: MON_FRI, holidays: [], schedulerEnabled: true,
  },
  {
    // ESTIMATED basis: Wiener Börse (Vienna Stock Exchange) regular session, local time.
    id: "supplemental-vienna", market: "Vienna", exchange: "Vienna", exchanges: [], country: "AT",
    timezone: "Europe/Vienna", regularSession: { open: "09:00", close: "17:30" }, stabilizationDelayMinutes: 30,
    weekdays: MON_FRI, holidays: [], schedulerEnabled: true,
  },
  {
    // ESTIMATED basis: Warsaw Stock Exchange (GPW) regular session, local time.
    id: "supplemental-warsaw", market: "Warsaw", exchange: "Warsaw", exchanges: [], country: "PL",
    timezone: "Europe/Warsaw", regularSession: { open: "09:00", close: "17:00" }, stabilizationDelayMinutes: 30,
    weekdays: MON_FRI, holidays: [], schedulerEnabled: true,
  },
  {
    // ESTIMATED basis: Borsa Istanbul regular session, local time.
    id: "supplemental-istanbul", market: "Istanbul", exchange: "Istanbul", exchanges: [], country: "TR",
    timezone: "Europe/Istanbul", regularSession: { open: "10:00", close: "18:00" }, stabilizationDelayMinutes: 30,
    weekdays: MON_FRI, holidays: [], schedulerEnabled: true,
  },
  {
    // ESTIMATED basis: Oslo Børs regular session, local time.
    id: "supplemental-oslo", market: "Oslo", exchange: "Oslo", exchanges: [], country: "NO",
    timezone: "Europe/Oslo", regularSession: { open: "09:00", close: "16:30" }, stabilizationDelayMinutes: 30,
    weekdays: MON_FRI, holidays: [], schedulerEnabled: true,
  },
];
