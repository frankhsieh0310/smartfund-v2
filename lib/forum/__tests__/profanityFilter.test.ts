import assert from "node:assert/strict";
import { containsProfanity } from "../profanityFilter.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("normal finance discussion text is never flagged", () => {
  assert.equal(containsProfanity("這檔ETF的配息率看起來不錯，但費用率有點高"), false);
  assert.equal(containsProfanity("大家覺得這次聯準會降息會怎麼影響台股？"), false);
  assert.equal(containsProfanity("This fund has a high expense ratio, worth comparing with 0050."), false);
});

test("blocked Chinese words are flagged", () => {
  assert.equal(containsProfanity("你這白痴懂什麼"), true);
  assert.equal(containsProfanity("智障言論"), true);
});

test("blocked English words are flagged (word-boundary, not substring)", () => {
  assert.equal(containsProfanity("this is fucking great"), true);
  assert.equal(containsProfanity("classic assessment"), false); // "ass" substring must not false-positive
});

test("scam/solicitation patterns are flagged", () => {
  assert.equal(containsProfanity("加LINE給你內線保證獲利"), true);
});
