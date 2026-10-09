import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type FxConfig = {
  version: string;
  productionService: string;
  builderState: string;
  sources: Array<{ id: string; name: string; kind: string; official: boolean; baseUrl: string; capabilities: string[] }>;
  currencies: Array<[string, string, string | null, number | null, string | null]>;
  intervals: string[];
  minimumIntervals: string[];
  capabilities: string[];
  majorCurrencies: string[];
  basePriority: string[];
};

export async function loadFxConfig(): Promise<FxConfig> {
  return JSON.parse(await readFile(resolve("config", "fx-platform.json"), "utf8")) as FxConfig;
}

export function buildFxPairs(config: FxConfig) {
  const major = new Set(config.majorCurrencies);
  const currencies = new Set(config.currencies.map(([code]) => code));
  const pairs: Array<{ symbol: string; baseCurrency: string; quoteCurrency: string; classification: string; providerSymbol: string }> = [];
  for (let left = 0; left < config.basePriority.length; left += 1) {
    for (let right = left + 1; right < config.basePriority.length; right += 1) {
      const baseCurrency = config.basePriority[left];
      const quoteCurrency = config.basePriority[right];
      if (!currencies.has(baseCurrency) || !currencies.has(quoteCurrency)) continue;
      const majorCount = Number(major.has(baseCurrency)) + Number(major.has(quoteCurrency));
      const classification = majorCount === 2 && (baseCurrency === "USD" || quoteCurrency === "USD")
        ? "MAJOR"
        : majorCount === 2 ? "MINOR" : majorCount === 1 ? "CROSS" : "EXOTIC";
      pairs.push({ baseCurrency, quoteCurrency, symbol: `${baseCurrency}${quoteCurrency}`, classification, providerSymbol: `${baseCurrency}${quoteCurrency}=X` });
    }
  }
  return pairs;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function option(name: string, fallback: string): string {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
