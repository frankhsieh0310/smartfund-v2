import assert from "node:assert/strict";
import { baseFundStem, isFundclearManagerSyncWriteEnabled } from "../managerSync.ts";

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

test("isFundclearManagerSyncWriteEnabled: 只有精確等於\"on\"（trim後）才算開啟，避免PowerShell管線髒值問題", () => {
  process.env.FUNDCLEAR_MANAGER_SYNC_WRITE = " on\r";
  assert.equal(isFundclearManagerSyncWriteEnabled(), true);
  process.env.FUNDCLEAR_MANAGER_SYNC_WRITE = "On";
  assert.equal(isFundclearManagerSyncWriteEnabled(), false);
  delete process.env.FUNDCLEAR_MANAGER_SYNC_WRITE;
});
