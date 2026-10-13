// Integration tests against the REAL applied forum/billing tables (docs/specs/forum-billing-schema-applied.sql).
// Everything here runs inside one BEGIN...ROLLBACK on a single client, per the user's instruction —
// the whole module's pool is pointed at this one transactional client for the duration of the test
// (see __setForumPoolOverrideForTests in lib/forum/pgPool.ts), and BEGIN/COMMIT/ROLLBACK issued by
// code under test (reports.ts, profiles.ts) are swallowed so only the outer ROLLBACK ever takes
// effect. Nothing written here is ever committed.
//
// Run with: node --experimental-strip-types --env-file=.env lib/forum/data/__tests__/integration.test.ts
// Requires DIRECT_URL / DATABASE_URL to be configured (same database as production — this is why the
// no-commit guarantee matters).

import assert from "node:assert/strict";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { __setForumPoolOverrideForTests, __clearForumPoolOverrideForTests } from "../../pgPool.ts";
import { createProfile, updateNickname, isCurrentlySuspended, NicknameTakenError } from "../profiles.ts";
import { createPost, editPost, ContentBlockedError } from "../posts.ts";
import { createReply } from "../replies.ts";
import { reportContent } from "../reports.ts";
import { acceptRuleVersion, hasAcceptedRuleVersion } from "../ruleAcceptance.ts";
import { RateLimitedError, DuplicateContentError } from "../rateLimits.ts";
import type { FilterConfig, StockDirectory } from "../../filter/types.ts";

const results: { name: string; pass: boolean; error?: string }[] = [];
let savepointCounter = 0;

/**
 * Wraps each test in its own SAVEPOINT: a Postgres transaction is poisoned ("current transaction is
 * aborted") after ANY statement error, even one the test expects and catches in JS (e.g. a unique-
 * constraint violation surfaced as NicknameTakenError) — a SAVEPOINT lets us recover from that and
 * keep running the next test inside the same outer transaction.
 */
function makeTest(client: import("pg").Client) {
  return async function test(name: string, fn: () => Promise<void>) {
    const savepoint = `sp_${savepointCounter++}`;
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

    // A test that resolved without throwing may still have left the connection in Postgres's
    // "aborted transaction" state, if it internally caught an expected DB-level error (e.g.
    // assert.rejects around a unique-constraint violation). Probe for that before deciding whether
    // to keep this test's writes (RELEASE) or discard them to recover the connection (ROLLBACK TO).
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

const TEST_FILTER_CONFIG: FilterConfig = {
  version: "test",
  categories: {
    fraud_redirect: {
      action: "BLOCK",
      description: "",
      patterns: {
        phone_like: [],
        email_like: [],
        messaging_apps: ["LINE"],
        solicitation_terms: ["保證獲利"],
        private_contact_terms_blocked_outright: ["私訊"],
        notify_only_standalone_terms: ["老師"],
      },
      whitelisted_domains: [],
    },
    stock_trading_advice: {
      action: "CONDITIONAL_BLOCK",
      description: "",
      window_chars: 30,
      trading_verbs_blocked: ["買進"],
      data_terms_not_blocked: ["配息"],
      notify_only_combo: ["代號+長期持有"],
    },
    profanity: {
      action: "MIXED",
      description: "",
      block_outright: { personal_attack_examples: ["白痴"], discrimination_examples: [] },
      notify_only_examples: ["屌"],
    },
  },
};
const TEST_STOCK_DIRECTORY: StockDirectory = { codes: ["2330"], names: [] };

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  await client.query("BEGIN");
  const test = makeTest(client);

  // Swallow nested BEGIN/COMMIT/ROLLBACK from code under test (reports.ts / profiles.ts manage their
  // own transactions when run normally) so only this outer transaction's final ROLLBACK ever commits
  // or discards anything.
  const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);
  const passthroughClient = {
    query: (text: string, params?: unknown[]) => client.query(text as string, params as never),
    release: () => {},
  };
  const guardedClient = {
    query: (text: string, params?: unknown[]) => {
      const trimmed = typeof text === "string" ? text.trim().toUpperCase() : "";
      if (TRANSACTION_CONTROL.has(trimmed)) return Promise.resolve({ rows: [], rowCount: 0 });
      return client.query(text, params as never);
    },
    release: () => {},
  };
  __setForumPoolOverrideForTests({
    query: ((text: string, params?: unknown[]) => client.query(text, params as never)) as never,
    connect: (async () => guardedClient) as never,
  });
  void passthroughClient;

  try {
    // ---- fixtures: a throwaway user + channel, created inside this same (rolled-back) transaction ----
    const testUserId = randomUUID();
    await client.query(
      `INSERT INTO public.users (id, supabase_id, email, plan, updated_at) VALUES ($1, $2, $3, 'PREMIUM', now())`,
      [testUserId, `test-${testUserId}`, `${testUserId}@integration-test.invalid`],
    );
    const testUser2Id = randomUUID();
    await client.query(
      `INSERT INTO public.users (id, supabase_id, email, plan, updated_at) VALUES ($1, $2, $3, 'PREMIUM', now())`,
      [testUser2Id, `test-${testUser2Id}`, `${testUser2Id}@integration-test.invalid`],
    );
    const channelResult = await client.query<{ id: string }>(
      `INSERT INTO forum.channels (slug, name, description) VALUES ($1, '整合測試頻道', '僅供測試') RETURNING id`,
      [`integration-test-${randomUUID()}`],
    );
    const channelId = channelResult.rows[0]!.id;

    // ---- profiles ----
    let profileId = "";
    await test("createProfile: creates a profile with the given nickname", async () => {
      const profile = await createProfile(testUserId, "整合測試員");
      profileId = profile.id;
      assert.equal(profile.nickname, "整合測試員");
      assert.equal(profile.status, "ACTIVE");
    });

    await test("createProfile: case-insensitive nickname collision is rejected", async () => {
      await assert.rejects(() => createProfile(testUser2Id, "整合測試員"), NicknameTakenError);
    });

    await test("updateNickname: can change to a new unique nickname", async () => {
      await updateNickname(profileId, "測試員改名後");
    });

    await test("isCurrentlySuspended: a profile with no suspension rows is not suspended", async () => {
      assert.equal(await isCurrentlySuspended(profileId), false);
    });

    // ---- rule acceptance ----
    await test("acceptRuleVersion + hasAcceptedRuleVersion round-trip", async () => {
      assert.equal(await hasAcceptedRuleVersion(profileId, "v1"), false);
      await acceptRuleVersion(profileId, "v1");
      assert.equal(await hasAcceptedRuleVersion(profileId, "v1"), true);
    });

    // ---- posts: first post goes to PENDING regardless of filter verdict ----
    let firstPostId = "";
    await test("createPost: the author's first-ever post is PENDING (pre-moderation)", async () => {
      const post = await createPost({
        profileId,
        channelId,
        title: "我的第一篇文章",
        body: "大家好，這是測試內容，討論一下市場狀況。",
        filterConfig: TEST_FILTER_CONFIG,
        stockDirectory: TEST_STOCK_DIRECTORY,
      });
      firstPostId = post.id;
      assert.equal(post.status, "PENDING");
    });

    await test("createPost: minimum 60s interval rejects an immediate second post", async () => {
      await assert.rejects(
        () =>
          createPost({
            profileId,
            channelId,
            title: "馬上又發一篇",
            body: "測試間隔限制。",
            filterConfig: TEST_FILTER_CONFIG,
            stockDirectory: TEST_STOCK_DIRECTORY,
          }),
        RateLimitedError,
      );
    });

    // Back-date the first post so the interval/duplicate-window checks below don't trip on it.
    await client.query(`UPDATE forum.posts SET created_at = now() - interval '2 hours' WHERE id = $1`, [firstPostId]);
    // Publish it directly (simulating admin approval) so the reply tests below can target it.
    await client.query(`UPDATE forum.posts SET status = 'PUBLISHED' WHERE id = $1`, [firstPostId]);

    await test("createPost: duplicate content within 24h from the same author is rejected", async () => {
      await assert.rejects(
        () =>
          createPost({
            profileId,
            channelId,
            title: "不同標題",
            body: "大家好，這是測試內容，討論一下市場狀況。",
            filterConfig: TEST_FILTER_CONFIG,
            stockDirectory: TEST_STOCK_DIRECTORY,
          }),
        DuplicateContentError,
      );
    });

    await test("createPost: a BLOCK-level filter hit rejects the post", async () => {
      await assert.rejects(
        () =>
          createPost({
            profileId,
            channelId,
            title: "加我私訊",
            body: "保證獲利，歡迎私訊詳談。",
            filterConfig: TEST_FILTER_CONFIG,
            stockDirectory: TEST_STOCK_DIRECTORY,
          }),
        ContentBlockedError,
      );
    });

    await test("editPost: re-runs the filter and rejects a BLOCK-level edit", async () => {
      await assert.rejects(
        () => editPost(firstPostId, profileId, "保證獲利，加我LINE", TEST_FILTER_CONFIG, TEST_STOCK_DIRECTORY),
        ContentBlockedError,
      );
    });

    // ---- replies ----
    let secondProfileId = "";
    await test("setup: second profile for reply/report cross-user tests", async () => {
      const profile = await createProfile(testUser2Id, "第二位測試員");
      secondProfileId = profile.id;
      await acceptRuleVersion(secondProfileId, "v1");
    });

    let replyId = "";
    await test("createReply: a reply from a different author succeeds", async () => {
      const reply = await createReply({
        profileId: secondProfileId,
        postId: firstPostId,
        body: "謝謝分享！",
        filterConfig: TEST_FILTER_CONFIG,
        stockDirectory: TEST_STOCK_DIRECTORY,
      });
      replyId = reply.id;
      assert.equal(reply.status, "PUBLISHED");
    });

    // ---- reports: 3rd report auto-hides ----
    await test("reportContent: auto-hides a reply after the 3rd distinct reporter", async () => {
      const reporterIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const uid = randomUUID();
        await client.query(
          `INSERT INTO public.users (id, supabase_id, email, plan, updated_at) VALUES ($1, $2, $3, 'PREMIUM', now())`,
          [uid, `test-${uid}`, `${uid}@integration-test.invalid`],
        );
        const profile = await createProfile(uid, `檢舉者${i}`);
        reporterIds.push(profile.id);
      }

      const r1 = await reportContent({ targetType: "REPLY", targetId: replyId, reporterId: reporterIds[0]!, reason: "測試1" });
      assert.equal(r1.autoHidden, false);
      const r2 = await reportContent({ targetType: "REPLY", targetId: replyId, reporterId: reporterIds[1]!, reason: "測試2" });
      assert.equal(r2.autoHidden, false);
      const r3 = await reportContent({ targetType: "REPLY", targetId: replyId, reporterId: reporterIds[2]!, reason: "測試3" });
      assert.equal(r3.autoHidden, true);

      const check = await client.query<{ status: string }>(`SELECT status FROM forum.replies WHERE id = $1`, [replyId]);
      assert.equal(check.rows[0]!.status, "HIDDEN");

      const logCheck = await client.query(
        `SELECT action_type, actor_ref FROM forum.moderation_log WHERE target_ref = $1`,
        [replyId],
      );
      assert.equal(logCheck.rows[0]?.action_type, "HIDE");
      assert.equal(logCheck.rows[0]?.actor_ref, "SYSTEM");
    });

    await test("reportContent: the same reporter cannot report the same target twice", async () => {
      const dup = await client.query<{ id: string }>(
        `SELECT reporter_id AS id FROM forum.reports WHERE target_id = $1 LIMIT 1`,
        [replyId],
      );
      const existingReporterId = dup.rows[0]!.id;
      await assert.rejects(() =>
        reportContent({ targetType: "REPLY", targetId: replyId, reporterId: existingReporterId, reason: "重複檢舉" }),
      );
    });

    // ---- account deletion ----
    await test("deleteForumAccount: clears content and marks the profile DELETED", async () => {
      const { deleteForumAccount } = await import("../profiles.ts");
      await deleteForumAccount(profileId);

      const postCheck = await client.query<{ title: string | null; body: string | null; status: string }>(
        `SELECT title, body, status FROM forum.posts WHERE id = $1`,
        [firstPostId],
      );
      assert.equal(postCheck.rows[0]!.title, null);
      assert.equal(postCheck.rows[0]!.body, null);
      assert.equal(postCheck.rows[0]!.status, "DELETED");

      const profileCheck = await client.query<{ status: string }>(`SELECT status FROM forum.profiles WHERE id = $1`, [
        profileId,
      ]);
      assert.equal(profileCheck.rows[0]!.status, "DELETED");
    });
  } finally {
    __clearForumPoolOverrideForTests();
    await client.query("ROLLBACK");
    await client.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} integration tests passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
