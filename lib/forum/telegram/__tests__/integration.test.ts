// Integration tests against the REAL forum tables, run inside one BEGIN...ROLLBACK (same technique as
// lib/forum/data/__tests__/integration.test.ts — see that file's header comment for how the pgPool
// override + per-test SAVEPOINTs work). Covers: confirmed delete/suspend/ban write forum.moderation_log,
// hide executes immediately, and approve/reject only affect PENDING posts.
//
// Run with: node --experimental-strip-types --env-file=.env lib/forum/telegram/__tests__/integration.test.ts

import assert from "node:assert/strict";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { __setForumPoolOverrideForTests, __clearForumPoolOverrideForTests } from "../../pgPool.ts";
import { hideContent, approvePost, rejectPost, executeConfirmedAction } from "../handlers.ts";

const results: { name: string; pass: boolean; error?: string }[] = [];
let savepointCounter = 0;

function makeTest(client: Client) {
  return async function test(name: string, fn: () => Promise<void>) {
    const savepoint = `sp_tg_${savepointCounter++}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    let threw = false;
    try {
      await fn();
      results.push({ name, pass: true });
      console.log(`PASS: ${name}`);
    } catch (e) {
      threw = true;
      results.push({ name, pass: false, error: (e as Error).message });
      console.log(`FAIL: ${name} — ${(e as Error).message}`);
    }
    let aborted = threw;
    if (!aborted) {
      try {
        await client.query("SELECT 1");
      } catch {
        aborted = true;
      }
    }
    if (aborted) await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  };
}

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  await client.query("BEGIN");
  const test = makeTest(client);

  __setForumPoolOverrideForTests({
    query: ((text: string, params?: unknown[]) => client.query(text, params as never)) as never,
    connect: (async () => ({
      query: (text: string, params?: unknown[]) => client.query(text, params as never),
      release: () => {},
    })) as never,
  });

  try {
    const testUserId = randomUUID();
    await client.query(
      `INSERT INTO public.users (id, supabase_id, email, plan, updated_at) VALUES ($1, $2, $3, 'PREMIUM', now())`,
      [testUserId, `test-${testUserId}`, `${testUserId}@integration-test.invalid`],
    );
    const profileResult = await client.query<{ id: string }>(
      `INSERT INTO forum.profiles (user_id, nickname) VALUES ($1, '待審員') RETURNING id`,
      [testUserId],
    );
    const profileId = profileResult.rows[0]!.id;
    const channelResult = await client.query<{ id: string }>(
      `INSERT INTO forum.channels (slug, name, description) VALUES ($1, '整合測試頻道', '僅供測試') RETURNING id`,
      [`tg-integration-test-${randomUUID()}`],
    );
    const channelId = channelResult.rows[0]!.id;

    let pendingPostId = "";
    await test("setup: a PENDING post to approve/reject against", async () => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO forum.posts (channel_id, author_id, title, body, status) VALUES ($1, $2, '待審文章', '內容', 'PENDING') RETURNING id`,
        [channelId, profileId],
      );
      pendingPostId = r.rows[0]!.id;
    });

    await test("approvePost: PENDING -> PUBLISHED", async () => {
      await approvePost(pendingPostId);
      const check = await client.query<{ status: string }>(`SELECT status FROM forum.posts WHERE id = $1`, [pendingPostId]);
      assert.equal(check.rows[0]!.status, "PUBLISHED");
    });

    await test("approvePost: re-approving an already-published post is a no-op (not found)", async () => {
      const reply = await approvePost(pendingPostId);
      assert.match(reply.text, /找不到|已經處理過/);
    });

    let anotherPendingId = "";
    await test("rejectPost: PENDING -> DELETED, content cleared", async () => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO forum.posts (channel_id, author_id, title, body, status) VALUES ($1, $2, '待退回', '內容', 'PENDING') RETURNING id`,
        [channelId, profileId],
      );
      anotherPendingId = r.rows[0]!.id;
      await rejectPost(anotherPendingId);
      const check = await client.query<{ status: string; title: string | null }>(
        `SELECT status, title FROM forum.posts WHERE id = $1`,
        [anotherPendingId],
      );
      assert.equal(check.rows[0]!.status, "DELETED");
      assert.equal(check.rows[0]!.title, null);
    });

    await test("hideContent: executes immediately (no confirmation step) and logs the action", async () => {
      await hideContent("POST", pendingPostId);
      const check = await client.query<{ status: string }>(`SELECT status FROM forum.posts WHERE id = $1`, [pendingPostId]);
      assert.equal(check.rows[0]!.status, "HIDDEN");

      const log = await client.query(`SELECT action_type, actor_ref FROM forum.moderation_log WHERE target_ref = $1`, [
        pendingPostId,
      ]);
      assert.equal(log.rows[0]?.action_type, "HIDE");
      assert.equal(log.rows[0]?.actor_ref, "TELEGRAM_ADMIN");
    });

    await test("executeConfirmedAction (delete): clears content and logs DELETE", async () => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO forum.posts (channel_id, author_id, title, body, status) VALUES ($1, $2, '待刪除', '內容', 'PUBLISHED') RETURNING id`,
        [channelId, profileId],
      );
      const postId = r.rows[0]!.id;
      await executeConfirmedAction({ kind: "delete", targetType: "POST", targetId: postId });

      const check = await client.query<{ status: string; body: string | null }>(
        `SELECT status, body FROM forum.posts WHERE id = $1`,
        [postId],
      );
      assert.equal(check.rows[0]!.status, "DELETED");
      assert.equal(check.rows[0]!.body, null);

      const log = await client.query(`SELECT action_type FROM forum.moderation_log WHERE target_ref = $1`, [postId]);
      assert.equal(log.rows[0]?.action_type, "DELETE");
    });

    await test("executeConfirmedAction (suspend): writes forum.suspensions, marks profile SUSPENDED, logs SUSPEND_7D", async () => {
      await executeConfirmedAction({ kind: "suspend", profileId, duration: "7D" });

      const profileCheck = await client.query<{ status: string }>(`SELECT status FROM forum.profiles WHERE id = $1`, [
        profileId,
      ]);
      assert.equal(profileCheck.rows[0]!.status, "SUSPENDED");

      const suspensionCheck = await client.query(`SELECT type FROM forum.suspensions WHERE profile_id = $1`, [profileId]);
      assert.equal(suspensionCheck.rows[0]?.type, "TEMP_7D");

      const log = await client.query(`SELECT action_type FROM forum.moderation_log WHERE target_ref = $1 AND target_type = 'PROFILE'`, [
        profileId,
      ]);
      assert.equal(log.rows[0]?.action_type, "SUSPEND_7D");
    });

    await test("executeConfirmedAction (ban): marks profile BANNED and logs BAN", async () => {
      const uid = randomUUID();
      await client.query(
        `INSERT INTO public.users (id, supabase_id, email, plan, updated_at) VALUES ($1, $2, $3, 'PREMIUM', now())`,
        [uid, `test-${uid}`, `${uid}@integration-test.invalid`],
      );
      const p = await client.query<{ id: string }>(
        `INSERT INTO forum.profiles (user_id, nickname) VALUES ($1, '待封鎖員') RETURNING id`,
        [uid],
      );
      const banProfileId = p.rows[0]!.id;

      await executeConfirmedAction({ kind: "ban", profileId: banProfileId });

      const check = await client.query<{ status: string }>(`SELECT status FROM forum.profiles WHERE id = $1`, [banProfileId]);
      assert.equal(check.rows[0]!.status, "BANNED");

      const log = await client.query(`SELECT action_type FROM forum.moderation_log WHERE target_ref = $1`, [banProfileId]);
      assert.equal(log.rows[0]?.action_type, "BAN");
    });
  } finally {
    __clearForumPoolOverrideForTests();
    await client.query("ROLLBACK");
    await client.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} Telegram integration tests passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
