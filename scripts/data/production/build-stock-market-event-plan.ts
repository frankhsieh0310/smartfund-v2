import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  currentDstStatus,
  loadExchangeCalendarRegistry,
  nextDispatch,
} from "../daily/exchange-calendar.ts";

type StrategyTuple = [mode: string, source: string, status: string];
type MarketStrategy = {
  market: string;
  calendarJobId: string;
  auctions: string[];
  price: StrategyTuple;
  latest: StrategyTuple;
  corporateActions: StrategyTuple;
  financials: StrategyTuple;
  monthlyRevenue: StrategyTuple;
};
type Strategy = {
  version: number;
  architecture: string;
  assetClass: string;
  fixedPolling: boolean;
  fallbackRule: string;
  markets: MarketStrategy[];
};

const root = process.cwd();
const strategy = JSON.parse(await readFile(join(root, "config", "stock-market-event-strategy.json"), "utf8")) as Strategy;
if (strategy.architecture !== "MARKET_EVENT_ENGINE" || strategy.assetClass !== "STOCK" || strategy.fixedPolling !== false) {
  throw new Error("INVALID_MARKET_EVENT_STRATEGY");
}

const registry = await loadExchangeCalendarRegistry(root);
const jobs = new Map(registry.jobs.map((job) => [job.id, job]));
const now = new Date();
const markets = strategy.markets.map((market) => {
  const calendar = jobs.get(market.calendarJobId);
  if (!calendar) throw new Error(`CALENDAR_JOB_MISSING:${market.calendarJobId}`);
  const nextClose = nextDispatch(calendar, now);
  return {
    market: market.market,
    timezone: calendar.timezone,
    dst: currentDstStatus(calendar.timezone, now),
    session: calendar.regularSession,
    holidays: calendar.holidays,
    halfDays: calendar.specialSessions,
    auctions: market.auctions,
    nextMarketCloseEvent: {
      tradeDate: nextClose.targetTradeDate,
      dispatchAt: nextClose.dispatchAt.toISOString(),
    },
    updateStrategy: {
      price: market.price,
      latest: market.latest,
      corporateActions: market.corporateActions,
      financials: market.financials,
      monthlyRevenue: market.monthlyRevenue,
    },
  };
});

console.log(JSON.stringify({
  generatedAt: now.toISOString(),
  architecture: strategy.architecture,
  assetClass: strategy.assetClass,
  fixedPolling: strategy.fixedPolling,
  fallbackRule: strategy.fallbackRule,
  marketCount: markets.length,
  markets,
}, null, 2));
