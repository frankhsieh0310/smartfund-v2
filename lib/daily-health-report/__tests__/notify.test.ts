import assert from "node:assert/strict";

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await test("notifyAnomaly: no TELEGRAM_BOT_TOKEN/CHAT_ID -> NONE, never calls fetch", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as any;
    const { notifyAnomaly } = await import(`../notify.ts?t=${Date.now()}`);
    const r = await notifyAnomaly("test summary");
    globalThis.fetch = originalFetch;
    assert.equal(r.channel, "NONE");
    assert.equal(r.attempted, false);
    assert.equal(called, false);
  });

  await test("notifyAnomaly: with token+chatId -> calls Telegram sendMessage", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "12345";
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = init?.body ?? "";
      return new Response("{}", { status: 200 });
    }) as any;
    const { notifyAnomaly } = await import(`../notify.ts?t=${Date.now()}`);
    const r = await notifyAnomaly("anomaly summary text");
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    assert.equal(r.channel, "TELEGRAM");
    assert.equal(r.attempted, true);
    assert.equal(r.ok, true);
    assert.ok(capturedUrl.includes("api.telegram.org/bottest-token/sendMessage"));
    assert.ok(capturedBody.includes("12345"));
    assert.ok(capturedBody.includes("anomaly summary text"));
  });
})();
