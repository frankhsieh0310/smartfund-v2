import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CurrencyIndex = { id: string; name: string; kind: "OFFICIAL" | "DERIVED_SPOT" | "LICENSED"; source?: string; series?: string; currency?: string; status: string; reason?: string };
export type CurrencyIndexConfig = { version: string; productionService: string; timezone: string; incrementalIntervalMinutes: number; intervals: string[]; capabilities: string[]; universe: CurrencyIndex[]; derivedBasket: string[] };

export async function loadCurrencyIndexConfig(): Promise<CurrencyIndexConfig> {
  return JSON.parse(await readFile(resolve("config", "currency-index-platform.json"), "utf8")) as CurrencyIndexConfig;
}
