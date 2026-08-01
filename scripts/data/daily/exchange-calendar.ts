import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SpecialSession = {
  date: string;
  close: string;
  type: "HALF_DAY" | "SPECIAL_CLOSE";
};

export type ExchangeCalendarJob = {
  id: string;
  market: string;
  exchange: string;
  exchanges: string[];
  country: string;
  timezone: string;
  regularSession: { open: string; close: string };
  stabilizationDelayMinutes: number;
  weekdays: number[];
  holidays: string[];
  specialSessions: SpecialSession[];
  holidayCalendarSource: string;
  yahooSuffixes: string[];
  providerProbeSymbols: string[];
  schedulerEnabled: boolean;
};

export type ExchangeCalendarRegistry = {
  version: number;
  lastCalendarSync: string;
  calendarValidThrough: string;
  pollIntervalMinutes: number;
  maxConcurrentMarketJobs?: number;
  maxNewMarketJobsPerDispatch?: number;
  jobs: ExchangeCalendarJob[];
};

export type MarketClock = {
  date: string;
  time: string;
  minutes: number;
  weekday: number;
};

const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function loadExchangeCalendarRegistry(root = process.cwd()): Promise<ExchangeCalendarRegistry> {
  const value = JSON.parse(await readFile(join(root, "config", "production-yahoo-daily-jobs.json"), "utf8")) as ExchangeCalendarRegistry;
  if (!value.version || !value.lastCalendarSync || !value.calendarValidThrough || !Array.isArray(value.jobs)) {
    throw new Error("INVALID_EXCHANGE_CALENDAR_REGISTRY");
  }
  return value;
}

export function marketClock(timezone: string, now = new Date()): MarketClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
    weekday: weekdayIndex.indexOf(get("weekday")),
  };
}

export function dateKey(date: Date, timezone: string): string {
  return marketClock(timezone, date).date;
}

export function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function addCalendarDays(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekdayForDate(value: string): number {
  return utcDate(value).getUTCDay();
}

export function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`INVALID_MARKET_TIME:${time}`);
  }
  return hour * 60 + minute;
}

export function closeTime(job: ExchangeCalendarJob, tradingDate: string): string {
  return job.specialSessions.find((session) => session.date === tradingDate)?.close ?? job.regularSession.close;
}

export function isTradingDate(job: ExchangeCalendarJob, value: string): boolean {
  return job.weekdays.includes(weekdayForDate(value)) && !job.holidays.includes(value);
}

export function previousTradingDate(job: ExchangeCalendarJob, fromDate: string): string {
  let candidate = addCalendarDays(fromDate, -1);
  for (let attempts = 0; attempts < 14; attempts += 1) {
    if (isTradingDate(job, candidate)) return candidate;
    candidate = addCalendarDays(candidate, -1);
  }
  throw new Error(`NO_PREVIOUS_TRADING_DATE:${job.id}:${fromDate}`);
}

export function latestClosedTradingDate(job: ExchangeCalendarJob, now = new Date()): string {
  const clock = marketClock(job.timezone, now);
  const readyMinutes = minutesOf(closeTime(job, clock.date)) + job.stabilizationDelayMinutes;
  if (isTradingDate(job, clock.date) && clock.minutes >= readyMinutes) return clock.date;
  return previousTradingDate(job, clock.date);
}

function zonedPartsAsUtcMillis(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

export function timezoneOffsetMinutes(date: Date, timezone: string): number {
  return Math.round((zonedPartsAsUtcMillis(date, timezone) - date.getTime()) / 60_000);
}

export function zonedDateTimeToUtc(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(desired);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedPartsAsUtcMillis(guess, timezone);
    guess = new Date(guess.getTime() + desired - actual);
  }
  return guess;
}

export function dispatchAt(job: ExchangeCalendarJob, tradingDate: string): Date {
  const close = minutesOf(closeTime(job, tradingDate)) + job.stabilizationDelayMinutes;
  const dispatchDate = addCalendarDays(tradingDate, Math.floor(close / 1440));
  const normalized = close % 1440;
  const time = `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  return zonedDateTimeToUtc(dispatchDate, time, job.timezone);
}

export function nextDispatch(job: ExchangeCalendarJob, now = new Date()): { targetTradeDate: string; dispatchAt: Date } {
  let candidate = marketClock(job.timezone, now).date;
  for (let attempts = 0; attempts < 14; attempts += 1) {
    if (isTradingDate(job, candidate)) {
      const dispatch = dispatchAt(job, candidate);
      if (dispatch > now) return { targetTradeDate: candidate, dispatchAt: dispatch };
    }
    candidate = addCalendarDays(candidate, 1);
  }
  throw new Error(`NO_NEXT_DISPATCH:${job.id}`);
}

export function currentDstStatus(timezone: string, now = new Date()): "DST" | "STANDARD" | "NO_DST" {
  const year = Number(dateKey(now, timezone).slice(0, 4));
  const january = timezoneOffsetMinutes(new Date(Date.UTC(year, 0, 15, 12)), timezone);
  const july = timezoneOffsetMinutes(new Date(Date.UTC(year, 6, 15, 12)), timezone);
  if (january === july) return "NO_DST";
  const standard = Math.min(january, july);
  return timezoneOffsetMinutes(now, timezone) === standard ? "STANDARD" : "DST";
}
