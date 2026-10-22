import { createHash } from "node:crypto";

export type OfficialBasketSource = { id: string; market: string; authority: string; baseUrl: string; adapter: string };
export type RawBasketRow = Record<string, unknown>;
export type BasketComponent = { sourceId: string; market: string; basketDate: string; etfIdentity: string; basketType: "CREATION" | "REDEMPTION" | "PUBLISHED_COMPOSITION"; componentIdentity: string; quantity: number | null; weight: number | null; cashAmount: number | null; cashSubstitution: boolean | null; sourceRecordId: string; checksum: string; retrievedAt: string; verificationStatus: "VERIFIED_OFFICIAL" };
const text = (value: unknown) => value == null ? "" : String(value).trim();
const num = (value: unknown) => { const parsed = Number(text(value).replaceAll(",", "").replace("%", "")); return Number.isFinite(parsed) ? parsed : null; };
const pick = (row: RawBasketRow, keys: string[]) => keys.map(key => row[key]).find(value => text(value)) ?? null;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function normalizeOfficialBasketRows(source: OfficialBasketSource, rows: RawBasketRow[], retrievedAt: string): BasketComponent[] {
  if (source.authority !== "OFFICIAL_EXCHANGE" && source.authority !== "OFFICIAL_EXCHANGE_OR_REGULATOR") throw new Error("NON_OFFICIAL_SOURCE_REJECTED");
  return rows.flatMap((row, index) => {
    const basketDate = text(pick(row, ["basket_date", "pcf_date", "date", "as_of"]));
    const isin = text(pick(row, ["isin", "etf_isin"])), ticker = text(pick(row, ["ticker", "etf_code", "fund_code"])), exchange = text(pick(row, ["exchange", "market"])) || source.market;
    const componentIdentity = text(pick(row, ["component_isin", "component_security_id", "component_code", "security_code", "component_name"]));
    if (!basketDate || (!isin && !ticker) || !componentIdentity) return [];
    const etfIdentity = isin ? `ISIN:${isin}` : `LISTING:${exchange}:${ticker}`;
    const type = text(pick(row, ["basket_type", "transaction_type"])).toUpperCase();
    const basketType: BasketComponent["basketType"] = type.includes("REDEMPTION") ? "REDEMPTION" : type.includes("CREATION") ? "CREATION" : "PUBLISHED_COMPOSITION";
    const sourceRecordId = text(pick(row, ["source_record_id", "row_id"])) || `${source.id}:${basketDate}:${etfIdentity}:${componentIdentity}:${index}`;
    return [{ sourceId: source.id, market: source.market, basketDate, etfIdentity, basketType, componentIdentity, quantity: num(pick(row, ["component_quantity", "quantity", "shares"])), weight: num(pick(row, ["component_weight", "weight", "weight_percent"])), cashAmount: num(pick(row, ["cash_component", "cash_amount", "cash_in_lieu"])), cashSubstitution: pick(row, ["cash_substitution", "substitution_allowed"]) == null ? null : ["TRUE", "YES", "Y", "1"].includes(text(pick(row, ["cash_substitution", "substitution_allowed"])).toUpperCase()), sourceRecordId, checksum: hash(row), retrievedAt, verificationStatus: "VERIFIED_OFFICIAL" }];
  });
}

export function deriveBasketChange(previous: BasketComponent[], current: BasketComponent[]) {
  const key = (row: BasketComponent) => row.componentIdentity, prior = new Map(previous.map(row => [key(row), row])), latest = new Map(current.map(row => [key(row), row])), union = new Set([...prior.keys(), ...latest.keys()]);
  let added = 0, exited = 0, changed = 0, cash = 0, total = 0;
  for (const identity of union) { const before = prior.get(identity), after = latest.get(identity); if (!before) added++; else if (!after) exited++; else if (before.quantity !== after.quantity || before.weight !== after.weight || before.cashAmount !== after.cashAmount) changed++; }
  for (const row of current) { if (row.cashAmount != null) cash += row.cashAmount; if (row.quantity != null) total += Math.abs(row.quantity); }
  return { methodologyVersion: "ETF_PUBLISHED_BASKET_CHANGE_V1", semantic: "PUBLISHED_BASKET_NOT_ACTUAL_FLOW", basketChangeRate: union.size ? (added + exited + changed) / union.size : 0, newBasketComponents: added, exitedBasketComponents: exited, changedBasketComponents: changed, cashComponentPercent: total > 0 ? cash / total * 100 : null };
}

export const adapterRegistry = new Set(["TAIWAN_OFFICIAL_ETF_DISCLOSURE_COMMON", "JPX_OFFICIAL_ETF_DISCLOSURE_COMMON", "HKEX_OFFICIAL_ETF_DISCLOSURE_COMMON", "REGISTERED_OFFICIAL_COMMON_ADAPTER_ONLY"]);

