import assert from "node:assert/strict";
import {
  fullWidthToHalfWidth,
  stripSeparators,
  chineseNumeralsToDigits,
  normalizeText,
} from "../normalize.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("fullWidthToHalfWidth: full-width digits and letters convert to ASCII", () => {
  assert.equal(fullWidthToHalfWidth("０９１２"), "0912");
  assert.equal(fullWidthToHalfWidth("ＬＩＮＥ"), "LINE");
});

test("stripSeparators: dashes, spaces and dots between digits collapse", () => {
  assert.equal(stripSeparators("0912-345-678"), "0912345678");
  assert.equal(stripSeparators("0912 345 678"), "0912345678");
  assert.equal(stripSeparators("0912．345．678"), "0912345678");
});

test("chineseNumeralsToDigits: phone-code words (洞/幺/拐/勾) convert correctly", () => {
  assert.equal(chineseNumeralsToDigits("洞九幺二"), "0912");
  assert.equal(chineseNumeralsToDigits("零九一二"), "0912");
});

test("normalizeText: split-written phone number collapses to a matchable digit run", () => {
  assert.match(normalizeText("0 9 1 2 - 3 4 5 - 6 7 8"), /09\d{8}/);
});

test("normalizeText: Chinese-numeral phone number collapses to a matchable digit run", () => {
  assert.match(normalizeText("洞 九 幺 二 三四五六七八"), /09\d{8}/);
});

test("normalizeText: homophone substitution for WeChat normalizes to 微信", () => {
  assert.match(normalizeText("加V聊"), /微信/);
  assert.match(normalizeText("威信連絡我"), /微信/);
});

test("normalizeText: homophone substitution for private-message variants normalizes to 私訊", () => {
  assert.match(normalizeText("PM我"), /私訊我/);
});

test("normalizeText: simplified characters convert to traditional before matching", () => {
  assert.match(normalizeText("加我买进"), /買進/);
});
