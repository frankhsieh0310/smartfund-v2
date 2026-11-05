import assert from "node:assert/strict";
import { baseFundStem, isFundclearManagerSyncWriteEnabled, resolveCompanyShortName } from "../managerSync.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("baseFundStem: 去掉結尾的級別英文字母，同一檔基金的各級別收斂成同一個stem", () => {
  assert.equal(baseFundStem("19330754A"), "19330754");
  assert.equal(baseFundStem("19330754B"), "19330754");
  assert.equal(baseFundStem("19330754D"), "19330754");
  assert.equal(baseFundStem("00570188K"), "00570188");
});

test("baseFundStem: 沒有結尾英文字母的代碼（例如單一級別ETF）維持原樣", () => {
  assert.equal(baseFundStem("98764389"), "98764389");
  assert.equal(baseFundStem("00663088"), "00663088");
});

test("isFundclearManagerSyncWriteEnabled: 預設關閉（環境變數未設定）", () => {
  delete process.env.FUNDCLEAR_MANAGER_SYNC_WRITE;
  assert.equal(isFundclearManagerSyncWriteEnabled(), false);
});

test("resolveCompanyShortName: 用organizName的A000X代碼對照出既有company欄位用的簡稱", () => {
  assert.equal(resolveCompanyShortName("A0005-元大證券投資信託股份有限公司"), "元大投信");
  assert.equal(resolveCompanyShortName("A0001-兆豐國際證券投資信託股份有限公司"), "兆豐投信", "兆豐是唯一跳過「國際」兩字的例外");
  assert.equal(resolveCompanyShortName("A0004-匯豐證券投資信託股份有限公司"), "滙豐投信", "既有DB用滙不用匯");
  assert.equal(resolveCompanyShortName("A0045-富蘭克林華美證券投資信託股份有限公司"), "富蘭克林華美投信");
});

test("resolveCompanyShortName: 對照表沒有的代碼或空值回傳null，不猜測", () => {
  assert.equal(resolveCompanyShortName("A9999-未知投信股份有限公司"), null);
  assert.equal(resolveCompanyShortName(null), null);
});

test("isFundclearManagerSyncWriteEnabled: 只有精確等於\"on\"（trim後）才算開啟，避免PowerShell管線髒值問題", () => {
  process.env.FUNDCLEAR_MANAGER_SYNC_WRITE = " on\r";
  assert.equal(isFundclearManagerSyncWriteEnabled(), true);
  process.env.FUNDCLEAR_MANAGER_SYNC_WRITE = "On";
  assert.equal(isFundclearManagerSyncWriteEnabled(), false);
  delete process.env.FUNDCLEAR_MANAGER_SYNC_WRITE;
});
