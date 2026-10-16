import assert from "node:assert/strict";
import { parseBondDisclosureName, normalizeIssuer } from "../bondNameParsing.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("standard 'ISSUER X.XXX% DD MMM YYYY' form", () => {
  const r = parseBondDisclosureName("ARGENTINIAN GOVT 4.125% 09 JUL 2035");
  assert.equal(r.issuerRaw, "ARGENTINIAN GOVT");
  assert.equal(r.couponPct, 4.125);
  assert.equal(r.maturityDate, "2035-07-09");
  assert.equal(r.looksLikeBond, true);
});

test("hyphenated date form", () => {
  const r = parseBondDisclosureName("SJM INTERNATIONAL LTD 6.5% 15-JAN-2031");
  assert.equal(r.issuerRaw, "SJM INTERNATIONAL LTD");
  assert.equal(r.couponPct, 6.5);
  assert.equal(r.maturityDate, "2031-01-15");
});

test("no-separator DDMMMYYYY date form + space before %", () => {
  const r = parseBondDisclosureName("GREENTOWN CHINA HLDGS 8.450000 % 24FEB2028");
  assert.equal(r.issuerRaw, "GREENTOWN CHINA HLDGS");
  assert.equal(r.couponPct, 8.45);
  assert.equal(r.maturityDate, "2028-02-24");
});

test("bare decimal coupon (no %) immediately before MM/DD/YY date -- issuer not polluted", () => {
  const r = parseBondDisclosureName("INDON 4.75 07/18/47 REGS");
  assert.equal(r.issuerRaw, "INDON");
  assert.equal(r.couponPct, 4.75);
  assert.equal(r.maturityDate, "2047-07-18"); // 18 can't be a month -> MM/DD/YY
});

test("DD.MM.YYYY dotted date form", () => {
  const r = parseBondDisclosureName("1261229 Bc Ltd 10% 15.04.2032 '144a' 1st");
  assert.equal(r.issuerRaw, "1261229 Bc Ltd");
  assert.equal(r.couponPct, 10);
  assert.equal(r.maturityDate, "2032-04-15");
});

test("DD/MM/YYYY slash date form (day > 12 forces day-first)", () => {
  const r = parseBondDisclosureName("SESI LLC 7.8875 30/09/2030 SERIES 144A");
  assert.equal(r.issuerRaw, "SESI LLC");
  assert.equal(r.couponPct, 7.8875);
  assert.equal(r.maturityDate, "2030-09-30");
});

test("genuinely unparseable date form ('4 Jun 30 31') never guessed", () => {
  const r = parseBondDisclosureName("Samarco Mineracao Sa 4 Jun 30 31");
  assert.equal(r.maturityDate, null);
  assert.equal(r.couponPct, null);
});

test("DD/MM/YYYY with BOTH components <=12 defaults to MM/DD (US convention, disclosed default, real NVIDIA bond)", () => {
  const r = parseBondDisclosureName("NVIDIA CORP 3.5% 04/01/2050");
  assert.equal(r.maturityDate, "2050-04-01"); // Apr 1, not Jan 4
});

test("a plain equity name is never flagged as a bond", () => {
  const r = parseBondDisclosureName("APPLE INC");
  assert.equal(r.looksLikeBond, false);
  assert.equal(r.couponPct, null);
  assert.equal(r.maturityDate, null);
});

test("bond keyword alone (no rate/date) still flags looksLikeBond", () => {
  assert.equal(parseBondDisclosureName("MORGAN STANLEY SR UNSEC").looksLikeBond, true);
  assert.equal(parseBondDisclosureName("Sri Lanka Government International Bond").looksLikeBond, true);
});

test("normalizeIssuer collapses corporate-suffix and boilerplate noise", () => {
  assert.equal(normalizeIssuer("NRG ENERGY INC 144A FIX"), "NRG ENERGY");
  assert.equal(normalizeIssuer("KEYCORP MTN"), "KEYCORP");
  assert.equal(normalizeIssuer("Dow Chemical Co"), "DOW CHEMICAL");
  assert.equal(normalizeIssuer("GREENTOWN CHINA HLDGS"), "GREENTOWN CHINA");
});

test("trailing /THE suffix normalizes to the same key as the plain name (real false-negative found live)", () => {
  assert.equal(normalizeIssuer("GOLDMAN SACHS GROUP INC/THE"), normalizeIssuer("GOLDMAN SACHS GROUP INC"));
});

test("COUPON-YYYY/MM/DD form (real MoneyDJ convention found live)", () => {
  const r = parseBondDisclosureName("GOLDMAN SACHS GROUP INC 6.75-2037/10/01");
  assert.equal(normalizeIssuer(r.issuerRaw), "GOLDMAN SACHS");
  assert.equal(r.couponPct, 6.75);
  assert.equal(r.maturityDate, "2037-10-01");
});

test("same issuer, two different disclosure styles, normalizes to the same key", () => {
  const moneydj = parseBondDisclosureName("NOKIA OF AMERICA CORPORATION 6.45% 15 MAR 2029");
  const etfSide = "NOKIA OF AMERICA CORPORATION"; // ETF-side holding_name convention: issuer only
  assert.equal(normalizeIssuer(moneydj.issuerRaw), normalizeIssuer(etfSide));
});
