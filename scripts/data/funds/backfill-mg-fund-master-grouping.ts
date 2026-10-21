// 2026-10-21（14點任務第2項）: M&G基金在「核准銷售」核心母體裡有15檔share class，但只有2檔
// 透過fund_share_classes/fund_master的既有分組機制連結——其餘13檔完全沒有fund_share_classes
// 記錄（不是master_fund_id是NULL，是整筆share-class記錄都不存在），所以列表上顯示成多筆獨立
// 項目，對應盤點報告寫的「M&G基金7個級別未合併顯示」（M&G日本基金正是7個級別：1個已有
// singleton master，另外6個完全沒被連結）。
//
// 這支腳本只做M&G一家基金公司，READ-ONLY（只SELECT，印出計畫，不寫入），依CLAUDE.md規則，
// 任何對Production的批次UPDATE/INSERT都要先經使用者核准才能執行——下面印出的SQL要等使用者
// 核准後，才把本檔的 DRY_RUN 改成真的執行（或由使用者指示後再補上 --apply 流程）。
//
// 分組邏輯：同一 company + 去掉級別代號(A/C/X等)、去掉幣別/避險/配息方式括號後綴後的基金名稱
// 相同，視為同一產品的不同級別。這跟現有 lib/yahoo/fundIngest.ts 的 masterStem() 概念一致，但
// 這裡用更簡單、針對中文基金名稱手動核對的版本，因為只有15筆，可以逐筆人工確認，不需要套用
// 泛用regex（更安全，不會誤判）。
//
// Usage: npx tsx scripts/data/funds/backfill-mg-fund-master-grouping.ts   （只印出計畫，不寫入）
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe<{
    id: string; name: string; currency: string; company: string;
    share_class_id: string | null; master_fund_id: string | null;
  }[]>(`
    SELECT f.id, f.name, f.currency, f.company, fsc.id AS share_class_id, fsc.master_fund_id
    FROM funds f
    LEFT JOIN fund_share_classes fsc ON fsc.fund_id = f.id
    WHERE f.name ILIKE '%M&G%'
    AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')
    ORDER BY f.name
  `);
  console.log(`Total approved-for-sale M&G funds: ${rows.length}`);
  console.log(`Already linked to a fund_share_classes row: ${rows.filter((r) => r.share_class_id).length}`);
  console.log(`Missing a fund_share_classes row entirely: ${rows.filter((r) => !r.share_class_id).length}`);

  // 人工核對過的分組（只對這15筆M&G基金，不是泛用規則）：
  const groups: { product: string; existingMasterId: string | null; fundIds: string[] }[] = [
    {
      product: "M&G日本基金",
      existingMasterId: "2dd2b5a4-81e2-5475-967e-25ad44855730", // 既有singleton master（a765e19b那筆），併入其他6筆
      fundIds: [
        "a765e19b-8ed6-4b67-939a-1a8e07af6db4", // 已在這個master（維持不動）
        "456802f7-0d4a-4ece-abfb-59d5ecfbd4fe", // A(日圓)
        "1db30437-80c6-4664-968f-1738926dad9d", // A(美元)
        "b212cbb8-f6ac-4479-86c7-de5355e29e99", // A(美元避險)
        "84054da3-b55f-48ca-a693-95bf5d7ddb68", // C(日圓)
        "e7543c53-c76c-4065-bd94-6e160414f2c1", // C(美元避險)
      ],
    },
    {
      product: "M&G 智慧收成基金",
      existingMasterId: null, // 需要新建一個master
      fundIds: [
        "fdf638b2-b1a1-4d74-8053-1520b43ed078", // A(南非幣避險月配)F2
        "5d2cab17-46c7-4a61-b528-2947e8214e4d", // A（美元避險）
        "a999cc6f-bba3-4410-b6d5-c45c7e388717", // A(美元避險月配)F2
        "6ea5d514-ef9a-438e-bbd1-67770934c772", // C(美元避險)
        "5df0934d-cced-4e50-bb24-d618ad021f8f", // X(南非幣避險月配後收)F2
        "3ae70e74-77fe-4dd4-bffc-5671cfe5e3fe", // X(美元避險後收)
        "e0c73870-0d6a-4412-a71b-138bd431c78f", // X(美元避險月配後收)F2
      ],
    },
    // "M&G(英國)收益優化基金A（英鎊）"（ee55ab26）在核心母體裡目前只有這1個級別，單獨留著即可，
    // 不需要建立master（跟getNonRepresentativeShareClassFundIds的"沒有分組記錄=照常顯示"規則一致）。
  ];

  for (const group of groups) {
    const rowsInGroup = rows.filter((r) => group.fundIds.includes(r.id));
    console.log(`\n== ${group.product} (${rowsInGroup.length} funds) ==`);
    for (const r of rowsInGroup) console.log(`  ${r.id}  ${r.name}  currency=${r.currency}  existing_share_class_id=${r.share_class_id ?? "(none)"}`);
    console.log(group.existingMasterId
      ? `  PLAN: INSERT missing fund_share_classes rows for the ${rowsInGroup.filter((r) => !r.share_class_id).length} unlinked funds, master_fund_id = ${group.existingMasterId} (existing)`
      : `  PLAN: INSERT a new fund_master row (canonical_name="${group.product}"), then INSERT fund_share_classes rows for all ${rowsInGroup.length} funds pointing at it; representative_fund_id = lowest fund_id (no Yahoo-holdings tiebreak available for this provider)`);
  }

  console.log(`\nNOTE: 這是DRY RUN，只印出計畫，沒有寫入任何資料。依CLAUDE.md規則，批次UPDATE/INSERT要先經使用者明確核准才能執行。`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
