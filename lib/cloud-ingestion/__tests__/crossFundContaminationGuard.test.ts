import assert from "node:assert/strict";
import {
  holdingsSignature, findCrossFundContamination, isContaminatedAgainstExisting,
  type FundBatch,
} from "../crossFundContaminationGuard.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

(() => {
  test("holdingsSignature: order-independent", () => {
    const a = holdingsSignature([{ name: "廣達", weight: 7.71 }, { name: "鴻海", weight: 2.86 }]);
    const b = holdingsSignature([{ name: "鴻海", weight: 2.86 }, { name: "廣達", weight: 7.71 }]);
    assert.equal(a, b);
  });

  test("holdingsSignature: different weight changes the signature", () => {
    const a = holdingsSignature([{ name: "廣達", weight: 7.71 }]);
    const b = holdingsSignature([{ name: "廣達", weight: 7.72 }]);
    assert.notEqual(a, b);
  });

  // 2026-11-10事故重現：同一個source同一天，10多檔完全不相關的基金（巴西基金/ESG全球基金/
  // 貨幣市場基金）持股清單跟weight逐筆一樣——應該被標記出來。
  test("findCrossFundContamination: catches the 2026-11-09 incident shape (unrelated funds, identical list)", () => {
    const quanta: FundBatch["holdings"] = [{ name: "廣達", weight: 7.71 }, { name: "鴻海", weight: 2.86 }];
    const batches: FundBatch[] = [
      { fundId: "fund-a", portfolioKey: "fund-a", holdings: quanta },
      { fundId: "fund-b-brazil", portfolioKey: "fund-b-brazil", holdings: quanta },
      { fundId: "fund-c-money-market", portfolioKey: "fund-c-money-market", holdings: quanta },
    ];
    const findings = findCrossFundContamination(batches);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fundIds.length, 3);
  });

  test("findCrossFundContamination: SAME portfolio (share classes of one fund) sharing identical holdings is NOT flagged", () => {
    const esg: FundBatch["holdings"] = [{ name: "台積電", weight: 50 }, { name: "聯發科", weight: 10 }];
    const batches: FundBatch[] = [
      { fundId: "taishin-esg-twd", portfolioKey: "taishin-esg", holdings: esg },
      { fundId: "taishin-esg-usd", portfolioKey: "taishin-esg", holdings: esg },
      { fundId: "taishin-esg-cny", portfolioKey: "taishin-esg", holdings: esg },
    ];
    const findings = findCrossFundContamination(batches);
    assert.equal(findings.length, 0);
  });

  test("findCrossFundContamination: different holdings across different funds is NOT flagged", () => {
    const batches: FundBatch[] = [
      { fundId: "fund-a", portfolioKey: "fund-a", holdings: [{ name: "廣達", weight: 7.71 }] },
      { fundId: "fund-b", portfolioKey: "fund-b", holdings: [{ name: "台積電", weight: 50 }] },
    ];
    assert.equal(findCrossFundContamination(batches).length, 0);
  });

  test("findCrossFundContamination: empty-holdings batches never match each other", () => {
    const batches: FundBatch[] = [
      { fundId: "fund-a", portfolioKey: "fund-a", holdings: [] },
      { fundId: "fund-b", portfolioKey: "fund-b", holdings: [] },
    ];
    assert.equal(findCrossFundContamination(batches).length, 0);
  });

  test("findCrossFundContamination: a mix of one contaminated group and one clean fund only flags the contaminated group", () => {
    const shared: FundBatch["holdings"] = [{ name: "廣達", weight: 7.71 }];
    const batches: FundBatch[] = [
      { fundId: "fund-a", portfolioKey: "fund-a", holdings: shared },
      { fundId: "fund-b", portfolioKey: "fund-b", holdings: shared },
      { fundId: "fund-c-clean", portfolioKey: "fund-c-clean", holdings: [{ name: "台積電", weight: 50 }] },
    ];
    const findings = findCrossFundContamination(batches);
    assert.equal(findings.length, 1);
    assert.deepEqual(new Set(findings[0].fundIds), new Set(["fund-a", "fund-b"]));
  });

  test("isContaminatedAgainstExisting: flags a new batch matching an already-written unrelated fund's batch", () => {
    const existing: FundBatch[] = [
      { fundId: "fund-brazil", portfolioKey: "fund-brazil", holdings: [{ name: "廣達", weight: 7.71 }] },
    ];
    const incoming: FundBatch = { fundId: "fund-money-market", portfolioKey: "fund-money-market", holdings: [{ name: "廣達", weight: 7.71 }] };
    assert.equal(isContaminatedAgainstExisting(incoming, existing), true);
  });

  test("isContaminatedAgainstExisting: does NOT flag against the same portfolio's own other share classes", () => {
    const existing: FundBatch[] = [
      { fundId: "taishin-esg-twd", portfolioKey: "taishin-esg", holdings: [{ name: "台積電", weight: 50 }] },
    ];
    const incoming: FundBatch = { fundId: "taishin-esg-usd", portfolioKey: "taishin-esg", holdings: [{ name: "台積電", weight: 50 }] };
    assert.equal(isContaminatedAgainstExisting(incoming, existing), false);
  });

  test("isContaminatedAgainstExisting: an empty incoming batch is never flagged", () => {
    const existing: FundBatch[] = [{ fundId: "fund-a", portfolioKey: "fund-a", holdings: [{ name: "廣達", weight: 7.71 }] }];
    const incoming: FundBatch = { fundId: "fund-b", portfolioKey: "fund-b", holdings: [] };
    assert.equal(isContaminatedAgainstExisting(incoming, existing), false);
  });
})();
