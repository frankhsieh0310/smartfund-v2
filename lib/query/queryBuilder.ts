// ============================================================
// lib/query/queryBuilder.ts
// SmartMatch Query Builder
//
// 職責：把 UI 多選條件整理成 filterEngine 可以理解的格式
// 規則：同一分類 OR，不同分類 AND
// 上游：CriteriaBuilder UI
// 下游：filterEngine.searchAll()
// 未來：自然語言搜尋 / AI / 持股反查 / 策略儲存 全部走這裡
// ============================================================

import { searchAll, type FilterCondition, type SearchResultItem, type SearchRequest } from "@/lib/engines/filterEngine";

// ── UI 多選條件格式（從 CriteriaBuilder 傳入）────────────────
export interface UIConditionGroup {
  type: FilterCondition["type"];           // 分類
  conditions: FilterCondition[];           // 同一分類的多個條件（OR 關係）
}

// ── Query 結果 ────────────────────────────────────────────────
export interface QueryResult {
  items:      SearchResultItem[];
  etfCount:   number;
  fundCount:  number;
  total:      number;
}

// ── 核心：把 UIConditionGroup[] 轉換成搜尋 ───────────────────
//
// 邏輯：
//   同一分類多個條件 → OR（分別搜尋後取聯集）
//   不同分類 → AND（依序過濾）
//
// 實作方式（不修改 filterEngine）：
//   1. 把每個分類的 OR 條件分開執行 searchAll
//   2. 取聯集（同分類）
//   3. 跨分類做交集（AND）
// ─────────────────────────────────────────────────────────────
export function buildAndSearch(
  groups: UIConditionGroup[],
  topN = 200
): QueryResult {
  if (groups.length === 0 || groups.every(g => g.conditions.length === 0)) {
    return { items: [], etfCount: 0, fundCount: 0, total: 0 };
  }

  // 過濾空 group
  const activeGroups = groups.filter(g => g.conditions.length > 0);
  if (activeGroups.length === 0) return { items: [], etfCount: 0, fundCount: 0, total: 0 };

  // Step 1: 每個分類內部做 OR（分別 search，取 id 聯集）
  // Step 2: 跨分類做 AND（取 id 交集）

  // 先針對每個 group 取出所有符合 item 的 id set
  const groupIdSets: Set<string>[] = activeGroups.map(group => {
    // 每個條件單獨搜尋，取聯集
    const ids = new Set<string>();
    for (const cond of group.conditions) {
      const req: SearchRequest = { conditions: [cond], topN };
      const results = searchAll(req);
      results.forEach(r => ids.add(r.id));
    }
    return ids;
  });

  // 跨分類 AND = 交集
  let intersectionIds: Set<string> = groupIdSets[0];
  for (let i = 1; i < groupIdSets.length; i++) {
    intersectionIds = new Set([...intersectionIds].filter(id => groupIdSets[i].has(id)));
  }

  // 取得最終結果（以第一個 group 的全量結果為 pool，篩選 id）
  const allConditions: FilterCondition[] = activeGroups[0].conditions;
  const poolReq: SearchRequest = { conditions: allConditions, topN };
  // 重新跑一次完整搜尋取得完整 item 資料
  // 由於 OR 邏輯：用無條件搜尋所有商品，然後過濾 id
  const allReq: SearchRequest = { conditions: [], topN };

  // 用空條件取所有商品（topN 足夠大）
  // filterEngine.searchAll 遇到空條件會返回所有 → 再手動過濾 id
  // 實際做法：從各 group 的第一個 condition 搜到的 pool 裡過濾
  // 更直接的做法：直接把每個 OR 結果收集起來，再做交集

  // 重新收集完整 item 物件
  const allItems = new Map<string, SearchResultItem>();
  for (const group of activeGroups) {
    for (const cond of group.conditions) {
      const req: SearchRequest = { conditions: [cond], topN };
      searchAll(req).forEach(r => allItems.set(r.id, r));
    }
  }

  const finalItems = [...allItems.values()].filter(r => intersectionIds.has(r.id));

  // 排序：近1年績效降序
  finalItems.sort((a, b) => b.return1y - a.return1y);
  const sliced = finalItems.slice(0, topN);

  return {
    items:     sliced,
    etfCount:  sliced.filter(r => r.type === "ETF").length,
    fundCount: sliced.filter(r => r.type === "基金").length,
    total:     sliced.length,
  };
}

// ── UI Tag → UIConditionGroup 轉換工具 ───────────────────────
// CriteriaBuilder 的 selected tags 格式 → QueryBuilder 格式
export function tagsToGroups(tags: FilterCondition[]): UIConditionGroup[] {
  const map = new Map<FilterCondition["type"], FilterCondition[]>();
  for (const tag of tags) {
    if (!map.has(tag.type)) map.set(tag.type, []);
    map.get(tag.type)!.push(tag);
  }
  return Array.from(map.entries()).map(([type, conditions]) => ({ type, conditions }));
}

// ── 快捷方法（給 CriteriaBuilder 直接使用）──────────────────
export function searchFromTags(tags: FilterCondition[], topN = 200): QueryResult {
  return buildAndSearch(tagsToGroups(tags), topN);
}