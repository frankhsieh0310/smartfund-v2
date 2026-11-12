// 一次性腳本：新增3個官方RSS來源到consensus_sources（大佬雷達內容量太少的補強，使用者核准）。
// 全部VERIFIED可用的官方RSS（WebFetch確認過格式與近期文章日期）：
//   - SEC — Press Releases（sec.gov，約1-2則/週）
//   - 歐洲央行 ECB — Press Releases（約每天有）
//   - 中央銀行（台灣）— 新聞發布（約每天1-3則）
// 萃取用的AI模型不動——這支腳本只新增來源，consensus_sources本身的輪詢/萃取邏輯是既有的通用
// 邏輯（lib/consensus/sourceFetch.ts），新增is_active=true的RSS列就會自動開始被抓，不需要改
// 任何程式碼。單一交易，先查有沒有重複slug再插入。

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SOURCES = [
  { slug: "sec-press-releases", type: "WIRE", name: "SEC — Press Releases", grade: "A", url: "https://www.sec.gov/news/pressreleases.rss", interval: 360 },
  { slug: "ecb-press", type: "GOV_TRANSCRIPT", name: "European Central Bank — Press Releases", grade: "A", url: "https://www.ecb.europa.eu/rss/press.html", interval: 360 },
  { slug: "tw-cbc-press", type: "GOV_TRANSCRIPT", name: "中央銀行（台灣）— 新聞發布", grade: "A", url: "https://www.cbc.gov.tw/tw/rss-302-1.xml", interval: 240 },
];

async function main() {
  await prisma.$transaction(async (tx) => {
    for (const s of SOURCES) {
      const existing = await tx.$queryRawUnsafe(`SELECT id FROM consensus_sources WHERE slug = $1`, s.slug);
      if (existing.length > 0) {
        console.log(`已存在，跳過: ${s.slug}`);
        continue;
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO consensus_sources (id, slug, source_type, source_name, source_grade, canonical_url, person_id, is_official, fetch_method, refresh_interval_minutes, is_active, created_at, status, consecutive_failures)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NULL, true, 'RSS', $6, true, NOW(), 'ACTIVE', 0)`,
        s.slug, s.type, s.name, s.grade, s.url, s.interval,
      );
      console.log(`新增: ${s.slug} (${s.name})`);
    }
  });
  const after = await prisma.$queryRawUnsafe(`SELECT slug, source_name, canonical_url, is_active FROM consensus_sources WHERE slug = ANY($1)`, SOURCES.map((s) => s.slug));
  console.log("目前狀態：", JSON.stringify(after, null, 2));
}

main()
  .catch((error) => { console.error("新增失敗，交易已自動回復：", error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
