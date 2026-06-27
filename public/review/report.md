# SmartMatch Product Review Report
**Version:** 3.4  
**Date:** 2026-06-27  
**Repo:** frankhsieh0310/smartfund-v2  
**Deploy:** https://smartfund-v2.vercel.app

---

## Phase 1 ✅ Data Foundation

### ETF Data Service
- 94 筆 ETF（台股 + 美股 + 全球）
- Schema: code / name / region / sector / dividendPerUnit / dividendYield / dividendFreq / returnYTD / return1m / return3m / return6m / return1y / return3y / volatility
- 路徑: `lib/data/etfData.ts`

### Fund Data Service
- 138 筆基金（野村/富邦/國泰/元大/安聯/聯博/摩根/貝萊德/霸菱/施羅德）
- Schema: id / company / name / category / region / morningstar / dividendPerUnit / dividendFreq / dividendYieldM / dividendYieldA / return系列 / volatility
- 路徑: `lib/data/fundData.ts`

### Market Data Service
- 5 大市場 × 6 指標
- 路徑: `lib/data/marketData.ts`

---

## Phase 2 ✅ Ranking Engine

### Ranking Service
- `lib/services/rankingService.ts`
- ETF 5種排行: hot30 / hot90 / best1y / yield / lowvol
- 基金 6種排行: hot30 / hot90 / best1y / yieldM / yieldA / lowvol
- Data Provider 可替換架構

### ETF 頁排行榜
- Tab: 近1年績效 / 近30日熱門 / 近3個月熱門 / 殖利率最高 / 低波動
- 改版: Card Layout + 🥇🥈🥉 Badge（不再是 Table）

### 基金頁排行榜
- Tab: 近1年績效 / 近30日熱門 / 近3個月熱門 / 月配息率 / 年化配息率 / 低波動
- 改版: Card Layout + 🥇🥈🥉 Badge

---

## Phase 3 ✅ Engine Layer

### 5 個 Engine（`lib/engines/`）

| Engine | 功能 | 狀態 |
|--------|------|------|
| rankingEngine.ts | 排行榜，支援 source 參數預留 | ✅ |
| filterEngine.ts | AND 多條件搜尋，parseNaturalQuery | ✅ |
| holdingsEngine.ts | 個股反查，findByHolding / findIntersection | ✅ |
| strategyEngine.ts | 策略儲存/執行，免費1組/Premium無限 | ✅ |
| recommendationEngine.ts | Rule-Based 推薦下一個條件 | ✅ |

### QueryBuilder（`lib/query/queryBuilder.ts`）
- 同一分類 OR，跨分類 AND
- CriteriaBuilder → QueryBuilder → filterEngine
- 未來: 自然語言/AI/持股反查全部走這層

---

## Phase 3A ✅ Homepage Experience

### Investment Criteria Builder
- Tag Builder UI（不是 Sidebar Filter）
- 8 類條件: 資產類型/區域/商品類型/配息/殖利率/近1年/近3年/波動度
- Multi-Select: 同類型可多選（OR 邏輯）
- 即時計算: 每次條件變更立即顯示「XX檔ETF + XX檔基金 = XX符合條件」
- 免費限制: 最多 3 個條件，第 4 個顯示 Premium 提示
- 查看結果: 展開 Card Layout，含收藏/觀察/比較按鈕

### 常用條件範例
- 5 組範例（退休現金流/亞洲股票基金/科技成長/低波動收益/高股息ETF）
- 每組顯示 ✓ 條件清單
- 點擊加入 Tag，不是直接搜尋
- 底部免責聲明固定顯示

### Mock Dashboard（登入後預覽）
- 4 組投資條件預覽（退休現金流/亞洲收益/科技成長/美元收益）
- 每組顯示 ETF + 基金符合數量
- 「重新執行」按鈕（示意）

### 對照區塊
- 傳統做法 vs SmartMatch 左右對比
- 5 個步驟對照

### Why SmartMatch
- 4 張價值 Card
- 禁用字: 推薦/建議/最適合/最佳

---

## Phase 3B ✅ UX Refinement

| Task | 項目 | 狀態 | 說明 |
|------|------|------|------|
| T1 | Hero 背景透明度 | ✅ | overlay 50%→20%，背景更清晰 |
| T2 | Multi-Select | ✅ | 同類型可多選，OR 邏輯 |
| T3 | 即時計數大字顯示 | ✅ | 28px 粗體，3 格布局 |
| T4 | ETF 欄位排序 | ✅ | 全部 9 欄可排序 ▲▼↕ |
| T5 | 基金欄位排序 | ✅ | 全部 9 欄可排序 ▲▼↕ |
| T6 | 排行榜重設計 | ✅ | Card Layout + 🥇🥈🥉 Badge |
| T7 | 範例資訊完整 | ✅ | ✓ 條件清單顯示 |
| T8 | Tag Chip 樣式 | ✅ | 統一 Chip，含分類小標籤 |
| T9 | 微動畫 | ✅ | transition-all/colors，React useMemo 即時更新 |

---

## Shared State ✅

### useWatchlist Hook（`lib/hooks/useWatchlist.ts`）
- localStorage keys: `favorites` / `watchlist` / `compareList`
- 首頁 / ETF頁 / 基金頁 全部共用
- storage event listener 跨 tab 同步
- 首頁收藏 0050 → ETF頁立即同步 ✅

---

## 禁用詞清單（全站執行）
❌ 推薦 / 建議 / 最適合 / 最佳 / 永久免費 / 無需信用卡

## 必要免責聲明
✅ 「非投資建議」出現於: Criteria Builder 結果 / 常用條件範例下方 / 排行榜底部

---

## 待開發（下一 Phase）

| 功能 | 優先級 |
|------|--------|
| 持股反查 UI | 高 |
| 自然語言搜尋 | 中 |
| 登入/會員系統 | 高 |
| 我的投資條件（儲存） | 高 |
| Criteria History（演進紀錄） | 中 |
| 通知/推播 | 低 |
| AI 整合 | 低 |

---

## 截圖指引（需真實瀏覽器執行）

以下頁面建議截圖驗收：

1. `smartfund-v2.vercel.app/` — 首頁完整捲動
2. `smartfund-v2.vercel.app/etf` — ETF 頁 + 排行榜 + 表格排序
3. `smartfund-v2.vercel.app/funds` — 基金頁 + 排行榜 + 走勢圖
4. `smartfund-v2.vercel.app/markets` — 市場中心
5. `smartfund-v2.vercel.app/compare` — 比較中心
6. `smartfund-v2.vercel.app/quiz` — 投資人格分析
7. `smartfund-v2.vercel.app/pricing` — 定價方案

截圖工具建議: Chrome → F12 → Cmd+Shift+P → "Capture full size screenshot"