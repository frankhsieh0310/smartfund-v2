import assert from "node:assert/strict";
import { combineEstimates, confirmedFrequency, dedupeEvents, estimateItem, parseCashflowParams, trailingWindowStart, type ItemInput } from "../lib/cashflow/estimate";

const TODAY = "2026-09-19";
const ev = (exDate: string, amountPerUnit: number, payDate: string | null = null, source = "OFFICIAL") => ({ exDate, payDate, amountPerUnit, currency: "USD", source });
const item = (events: ReturnType<typeof ev>[], over: Partial<ItemInput> = {}): ItemInput => ({
  ref: "ETF:x", kind: "ETF", id: "x", name: "X", ticker: "X", currency: "USD", frequencyRaw: null, price: { value: 100, date: "2026-09-18" }, events, value: 10, ...over,
});

// params / limits
assert.ok("error" in parseCashflowParams("ETF:a:1", "X"));
assert.ok("error" in parseCashflowParams("ETF:a:0", "SHARES"));
assert.ok("error" in parseCashflowParams(Array.from({ length: 11 }, (_, i) => `ETF:a${i}:1`).join(","), "SHARES"));
assert.ok(!("error" in parseCashflowParams(Array.from({ length: 10 }, (_, i) => `ETF:a${i}:1`).join(","), "AMOUNT")));

// frequency only when the product states it
assert.equal(confirmedFrequency("Monthly"), "MONTHLY");
assert.equal(confirmedFrequency("Semi-Annual"), "SEMI_ANNUAL");
assert.equal(confirmedFrequency(null), null);
assert.equal(confirmedFrequency("Varies"), null);
assert.equal(trailingWindowStart(TODAY), "2025-09-19");

// data-sufficiency statuses
assert.equal(estimateItem(item([]), "SHARES", TODAY).status, "NO_DATA");
assert.equal(estimateItem(item([ev("2026-06-01", 1)]), "SHARES", TODAY).status, "ONLY_ONE_RECORD");
assert.equal(estimateItem(item([ev("2024-01-01", 1), ev("2024-06-01", 1)]), "SHARES", TODAY).status, "NO_PAYMENT_IN_12M");
assert.equal(estimateItem(item([ev("2026-01-01", 1), ev("2026-06-01", 1)], { price: null }), "AMOUNT", TODAY).status, "NO_PRICE");
assert.equal(estimateItem(item([ev("2026-01-01", 1), ev("2026-06-01", 1)], { price: null }), "SHARES", TODAY).status, "OK"); // shares mode needs no price

// annual = actual trailing-12M sum x shares (NOT one payment x 12); irregular amounts kept as-is
const irregular = estimateItem(item([ev("2025-08-01", 9), ev("2025-10-01", 1, "2025-10-05"), ev("2026-01-10", 2, "2026-01-15"), ev("2026-04-01", 3)]), "SHARES", TODAY);
assert.equal(irregular.status, "OK");
assert.equal(irregular.basis.paymentCount, 3); // 2025-08-01 is outside the window
assert.equal(irregular.annualEstimate, (1 + 2 + 3) * 10);
assert.equal(irregular.avgMonthly, 5);
assert.equal(irregular.months[9].amount, 10); // Oct from pay date 10-05
assert.equal(irregular.months[0].amount, 20); // Jan from pay date
assert.equal(irregular.months[3].amount, 30); // Apr from ex date (no pay date)
assert.deepEqual(irregular.months[3].dateBasis, ["EX_DATE"]);
assert.equal(irregular.months[5].amount, 0); // nothing invented in empty months
assert.equal(irregular.frequency, null); // never guessed from gaps

// amount mode converts with the real price only: 1000 / 100 = 10 shares
const viaAmount = estimateItem(item([ev("2026-01-01", 1), ev("2026-06-01", 1)], { value: 1000 }), "AMOUNT", TODAY);
assert.equal(viaAmount.shares, 10);
assert.equal(viaAmount.annualEstimate, 20);

// stated frequency + fewer records than expected -> flagged, still not filled in
const gap = estimateItem(item([ev("2026-01-01", 1), ev("2026-02-01", 1), ev("2026-03-01", 1)], { frequencyRaw: "Monthly" }), "SHARES", TODAY);
assert.equal(gap.basis.possiblyIncomplete, true);
assert.equal(gap.annualEstimate, 30);

// Official record beats Yahoo for the same ex-date (no double count)
assert.equal(dedupeEvents([ev("2026-01-01", 1, null, "YAHOO_CHART"), ev("2026-01-01", 1.1, "2026-01-05", "ISHARES")]).length, 1);
assert.equal(dedupeEvents([ev("2026-01-01", 1, null, "YAHOO_CHART"), ev("2026-01-01", 1.1, "2026-01-05", "ISHARES")])[0].amountPerUnit, 1.1);

// currencies are never merged
const usd = estimateItem(item([ev("2026-01-01", 1), ev("2026-06-01", 1)]), "SHARES", TODAY);
const twd = estimateItem(item([{ ...ev("2026-01-01", 2), currency: "TWD" }, { ...ev("2026-06-01", 2), currency: "TWD" }], { ref: "ETF:y", currency: "TWD" }), "SHARES", TODAY);
const totals = combineEstimates([usd, twd]);
assert.equal(totals.length, 2);
assert.equal(totals.find((t) => t.currency === "USD")!.annualEstimate, 20);
assert.equal(totals.find((t) => t.currency === "TWD")!.annualEstimate, 40);
console.log("cashflow tests passed");
