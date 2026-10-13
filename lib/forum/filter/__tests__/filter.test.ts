import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runForumFilter } from "../index.ts";
import type { FilterConfig, StockDirectory } from "../types.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const config: FilterConfig = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "filter-config.test.json"), "utf-8"),
);
const directory: StockDirectory = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "stock-directory.test.json"), "utf-8"),
);

function run(text: string) {
  return runForumFilter(text, config, directory);
}

// ---- 防詐騙導流：電話/LINE 各種拆寫 ----

test("BLOCK: plain Taiwan mobile number", () => {
  assert.equal(run("歡迎加入 0912345678 聯絡").action, "BLOCK");
});

test("BLOCK: dash-separated phone number", () => {
  assert.equal(run("加line 0912-345-678").action, "BLOCK");
});

test("BLOCK: space-split phone number", () => {
  assert.equal(run("電話 0 9 1 2 3 4 5 6 7 8").action, "BLOCK");
});

test("BLOCK: Chinese-numeral-written phone number", () => {
  assert.equal(run("電話洞玖幺貳參四五六七八").action, "BLOCK");
});

test("BLOCK: LINE spelled with inserted spaces/case variants", () => {
  assert.equal(run("加 L I N E 聊天").action, "BLOCK");
  assert.equal(run("加Line好友").action, "BLOCK");
});

test("BLOCK: WeChat homophone evasion (威信/加V)", () => {
  assert.equal(run("加威信聊").action, "BLOCK");
  assert.equal(run("加V聊天").action, "BLOCK");
});

// ---- 短網址 ----

test("BLOCK: known shortlink host even if not otherwise suspicious", () => {
  const result = run("詳情看 reurl.cc/abc123");
  assert.equal(result.action, "BLOCK");
  assert.ok(result.reasons.some((r) => r.matched.includes("reurl.cc")));
});

test("ALLOW: whitelisted official domain is not treated as a redirect link", () => {
  const result = run("詳見官方公告 smartmatch.tw/help");
  assert.equal(result.action, "ALLOW");
});

// ---- 私訊及其變形直接擋 ----

test("BLOCK: literal 私訊", () => {
  assert.equal(run("可以私訊我嗎").action, "BLOCK");
});

test("BLOCK: private-message variants (私我/PM我/站內信/DM我)", () => {
  assert.equal(run("私我拿資料").action, "BLOCK");
  assert.equal(run("PM我好嗎").action, "BLOCK");
  assert.equal(run("寄站內信給我").action, "BLOCK");
  assert.equal(run("DM我即可").action, "BLOCK");
});

test("NOTIFY only: standalone 老師/群組 without other red flags", () => {
  const result = run("這位老師分析得很好，大家可以多交流");
  assert.equal(result.action, "NOTIFY");
  assert.ok(result.reasons.some((r) => r.matched === "老師"));
});

// ---- 個股交易建議：30 字內 vs 30 字外 ----

test("BLOCK: stock code + trading verb within 30 characters", () => {
  const text = "2330 現在是不是該買進了";
  const result = run(text);
  assert.equal(result.action, "BLOCK");
  assert.ok(result.reasons.some((r) => r.category === "stock_trading_advice"));
});

test("ALLOW: stock name + trading verb far beyond 30 characters apart", () => {
  const padding = "這是一段很長的填充文字用來確保交易用語距離個股名稱超過三十個字的範圍才會被視為安全不觸發規則喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔喔";
  const text = `台積電${padding}買進`;
  const result = run(text);
  assert.equal(result.action, "ALLOW");
});

test("ALLOW: fund/ETF data-terms (配息/殖利率/持股) next to a stock code are not blocked", () => {
  const result = run("0050 這次配息殖利率跟持股變化整理一下給大家參考");
  assert.equal(result.action, "ALLOW");
});

test("NOTIFY only: stock code + 長期持有/基本面 combo", () => {
  const result = run("2330 長期持有基本面不錯");
  assert.equal(result.action, "NOTIFY");
  assert.ok(result.reasons.some((r) => r.category === "stock_trading_advice" && r.action === "NOTIFY"));
});

// ---- 不雅字詞：直接擋 vs 只通知 ----

test("BLOCK: personal-attack profanity", () => {
  assert.equal(run("你是白痴嗎").action, "BLOCK");
});

test("NOTIFY only: mild slang praise (屌/猛/狂/神)", () => {
  const result = run("這篇分析寫得真屌");
  assert.equal(result.action, "NOTIFY");
  assert.ok(result.reasons.some((r) => r.category === "profanity" && r.action === "NOTIFY"));
});

// ---- 誤判案例 False positives ----

test("ALLOW: ordinary discussion mentioning a messaging app by name only in a neutral context should still BLOCK per rule (no neutral exemption) — documents current behavior, not a bug", () => {
  // Messaging-app names are blocked outright regardless of sentence context per the user's decision;
  // this test documents that "LINE 真好用" is still BLOCKed, so a future relaxation is a deliberate change, not a regression.
  assert.equal(run("LINE真好用").action, "BLOCK");
});

test("ALLOW: ordinary fund discussion with numbers that are not a phone number", () => {
  const result = run("0050 這支ETF規模目前排名第幾");
  assert.equal(result.action, "ALLOW");
});

test("ALLOW: ordinary sentence with no flagged content at all", () => {
  const result = run("今天大盤表現如何，大家怎麼看");
  assert.equal(result.action, "ALLOW");
});

test("ALLOW: discriminatory-term placeholder entry in config is never matched literally", () => {
  // The config's discrimination_examples list contains an explanatory placeholder string, not a real
  // term; the filter must not try to match it against user text.
  const result = run("這只是一句很普通的留言，不含任何不當用詞");
  assert.equal(result.action, "ALLOW");
});
