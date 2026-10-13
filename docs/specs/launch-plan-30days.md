# 付費會員討論區 — 30 天上架計畫（草案，2026-10-13）

本文件只做計畫與風險盤點，不含任何部署或資料庫變更動作。所有結論標示 **VERIFIED**（已親自查證）或 **UNKNOWN**（查不到／無法確認），不得推測補空。

---

## 零、現況盤點（唯讀，VERIFIED / UNKNOWN）

| 項目 | 結論 | 說明 |
|---|---|---|
| smartmatch-mobile 是否已上架 App Store | **UNKNOWN** | `app.json`／`eas.json` 存在完整的 `production` build profile 與 `submit.production.ios` 設定，顯示曾規劃上架流程；但透過 iTunes Search / App Store 搜尋 `com.smartmatch.mobile`、「SmartMatch」皆查無對應上架結果（搜尋被導向同名但不相關的「SmartMatchApp」CRM 產品，且 `itunes.apple.com`／`apps.apple.com` 的直接查詢在本次工具環境下遭導航拒絕，無法做最終確認）。**建議你直接在 App Store Connect 後台確認目前狀態**，不要以本文件的查詢結果為準。 |
| smartmatch-mobile 是否已上架 Google Play | **UNKNOWN** | 同上，搜尋無結果，且本次環境無法直接查詢 Google Play Console。 |
| Expo managed 還是 dev build | **VERIFIED：Expo managed workflow（無 bare native 專案）** | repo 根目錄沒有 `ios/`、`android/` 原生專案資料夾；`eas.json` 的 `production`／`internal` build profile 皆未設定 `developmentClient`，只有 `development` profile 設 `developmentClient: true`——這是標準 Expo managed + EAS Build 的設定模式，不是 bare workflow。 |
| 加入 RevenueCat（`react-native-purchases`）需要的改動 | **VERIFIED（現況）＋ 以下為提案）** | `package.json` 目前**沒有**任何 `purchases`／`revenuecat`／`storekit`／`billing` 相關套件（已用關鍵字搜尋確認零筆）。因為 IAP 原生能力無法在 Expo Go 裡測試，加入後必須改用 **EAS Dev Client** 建置（`eas.json` 的 `development` profile 已存在且已設 `developmentClient: true`，可直接沿用，不需新建 profile）。改動範圍：新增 `expo-dev-client`、`react-native-purchases`（可選 `react-native-purchases-ui`）依賴；新增一個「取得目前付費狀態」的 App 端呼叫（打 `GET /api/forum/membership`，已完成，見決定紀錄第 1 項），不在 App 端自行判斷付費與否。 |
| 既有 ToS／隱私權政策頁面 | **VERIFIED：不存在** | 搜尋 smartmatch-mobile 與 smartfund-v2 repo，皆無 `privacy`／`terms` 相關頁面或路由。Apple／Google／RevenueCat 皆要求上架前提供隱私權政策網址，這是阻塞項，見下方風險清單。 |

---

## 一、4 週時程表

### 程式工作（Claude／工程端）

| 週 | 項目 |
|---|---|
| 第 1 週 | 過濾引擎（已完成，見交付清單）；RevenueCat webhook／會員查詢 API 骨架（已完成，待 DDL 核准後補上實際資料庫串接的整合測試）；`forum` schema DDL 草案（已完成，待核准） |
| 第 2 週 | DDL 核准後：套用 migration（由你本人執行，見下方「你要辦的事」）；發文頻率限制、頻道/文章/回覆/檢舉 CRUD API；App 端討論區 UI（列表、發文、回覆、檢舉） |
| 第 3 週 | Telegram 管理機器人（webhook 接收、指令解析、白名單＋密鑰驗證、確認按鈕）；App 端整合 `react-native-purchases`／RevenueCat SDK；隱私權政策／服務條款頁面 |
| 第 4 週 | 上架審查準備（App Store／Google Play 檢查清單逐項確認）；E2E 測試；提交審查；審查期間的緩衝（Apple 審查通常 1–3 天，但新增 IAP／UGC 可能觸發人工審查延長，需預留緩衝） |

### 你要辦的事（非程式，通常是帳務/法務/帳號申請，無法由 Claude 代為執行）

| 項目 | 說明 | 官方說明網址（查詢日期 2026-10-13） |
|---|---|---|
| Apple Developer Program 組織帳號（D-U-N-S） | 若尚未以組織身分加入 Apple Developer Program，需先取得/確認 D-U-N-S 號碼，申請後最快約 5 個工作日取得號碼，Apple 再花約 2 個工作日核對 | [Apple Account Help — D-U-N-S Number](https://developer.apple.com/support/D-U-N-S/) |
| App Store Connect 付費協議與銀行稅務 | 需簽署 Paid Apps Agreement，並在 App Store Connect 的 Business（原 Agreements, Tax, and Banking）頁面填寫銀行帳戶與稅務資料，才能收款／設定付費訂閱項目 | **UNKNOWN（官方頁面未能直接確認）**：搜尋只找到 `developer-mdn.apple.com` 的鏡像頁面（Tax forms overview / Overview of receiving payments），無法確認是否為 Apple 官方正式網域；請你在 App Store Connect 登入後由「Business」頁面直接操作，不要依賴本文件提供的連結 |
| 訂閱商品建立 | 在 App Store Connect 與 Google Play Console 分別建立訂閱項目，需在完成上述付費協議後才能建立 | 無單一官方「建立訂閱」頁面可引用，操作入口在 App Store Connect 的「App 內購買項目」與 Play Console 的「訂閱」頁面，建議直接在後台操作 |
| Google Play Console 收款設定 | 建立 Payments Profile（Play Console → Settings → Payments profile），填寫法人名稱、地址、銀行帳戶、聯絡人、公開商家資訊 | [Google Play Console Help — Create a payments profile](https://support.google.com/googleplay/android-developer/answer/7161426)、[Link a developer account to a payments profile](https://support.google.com/googleplay/android-developer/answer/3092739) |
| RevenueCat 帳號 | 建立 RevenueCat 專案，設定 iOS／Android 兩個 app，取得 Public SDK Key（給 App 端）與建立 Webhook（設定 Authorization 標頭密鑰，給 `REVENUECAT_WEBHOOK_SECRET`） | [RevenueCat Docs — Webhooks](https://www.revenuecat.com/docs/integrations/webhooks)、[RevenueCat Docs — Expo installation](https://www.revenuecat.com/docs/getting-started/installation/expo) |
| 服務條款與隱私權政策頁面 | Apple／Google／RevenueCat 皆要求上架前提供可公開存取的隱私權政策網址；本專案目前沒有這類頁面（見上方現況盤點），需先寫好並發布到一個穩定網址 | 無單一官方範本連結；Apple 的要求寫在 App Store Review Guideline 1.2（使用者生成內容）與帳號資料章節，Google 的要求寫在 Play Console 的 App content 區塊 |

---

## 二、關鍵路徑（卡住就會延期）

1. **隱私權政策／服務條款頁面不存在** → 阻塞 App Store Connect 與 Google Play Console 的 App 基本資料填寫、也阻塞 RevenueCat 專案設定的部分欄位。**必須在第 1 週內完成**，否則後面所有店家端設定都無法往前推進。
2. **App Store Connect 付費協議與銀行稅務尚未確認狀態** → 阻塞訂閱商品建立，進而阻塞整個付費會員機制上線。這是你本人要辦的事，Claude 無法代辦，且官方流程本身可能耗時數個工作日至數週（視是否需要新辦 D-U-N-S 而定）。
3. **smartmatch-mobile 是否已有上架紀錄為 UNKNOWN** → 若實際上從未上架過，這次等於是「新 App 首次上架」而非「既有 App 更新」，審查時間與流程（尤其 Apple 的首次上架審查）通常比既有 App 更新慢，需要你先確認後才能準確估算第 4 週的緩衝天數。
4. **`forum` schema DDL 尚未核准** → 阻塞所有需要讀寫討論區資料的程式（發文頻率限制、頻道/文章/回覆/檢舉 CRUD、Telegram 管理機器人的刪文/停權動作）。本次任務的過濾引擎與 RevenueCat webhook 骨架刻意設計成不依賴 DDL 即可先完成並測試，但第 2 週以後的工作都卡在這裡。
5. **RevenueCat／IAP 原生改動需要 EAS Dev Client 重新建置** → 既有的 Expo managed 流程可以沿用，但第一次加入 `react-native-purchases` 後必須重新產生一個 Dev Client build 才能在實機測試金流，这不是「改程式碼就好」，需要排入 EAS Build 的佔用時間（通常數分鐘到數十分鐘的佇列＋建置時間，視 EAS 方案而定，不確定你目前的 EAS 方案等級，標 UNKNOWN）。
6. **一個月上架目標與 Apple/Google 審查時間的不確定性**：Apple 審查多數在 1–3 天內，但新增付費訂閱＋使用者生成內容（討論區）兩者同時出現，較可能被導向人工詳細審查，實際天數 **UNKNOWN**，建議至少預留 1 週緩衝而非假設最快速度過關。

---

## 三、風險清單

| 風險 | 影響 | 建議 |
|---|---|---|
| App Store Connect 付費協議/銀行稅務狀態未知，且此流程不受 Claude 控制 | 可能直接讓「一個月上架」目標無法達成 | 請你最優先確認此狀態並回報，若尚未開始建議立即啟動 |
| 討論區為使用者生成內容（UGC），疊加付費訂閱，審查風險較高 | 可能被要求補充檢舉/封鎖/內容管理機制說明，甚至被要求調整年齡分級 | 第 9 節（既有規格文件）已列出 App Store Guideline 1.2／5.1.1(v) 與 Google Play UGC 政策檢查清單，建議提交前逐項自我核對 |
| 台灣法規（證券投資信託及顧問法、個人資料保護法等）未經法務確認 | 若討論區內容被認定構成未經核准之投資建議，有法律風險 | 既有規格文件已標示「需法務確認」，**在法務確認前不建議正式對外開放討論區**，即使程式已完成 |
| `forum.moderation_log` 設計為 append-only，但帳號刪除需要刪除內容 | 若實作疏漏，可能造成「刪除帳號後紀錄表仍間接保留個資」的合規問題 | 決定紀錄第 8 項已確認紀錄表不存內容/個資，`forum-schema-draft.sql` 的欄位設計已排除此風險，但正式實作 API 時仍需確保刪除邏輯不寫入任何內容到 `moderation_log` |
| EAS Dev Client 重新建置可能耗費非預期時間 | 延誤第 3 週的 App 端整合排程 | 建議在第 2 週末就先跑一次空的 `react-native-purchases` 安裝＋Dev Client build，提早暴露建置問題，不要留到第 3 週才第一次嘗試 |
| RevenueCat webhook 的 `TRANSFER` 事件類型目前未處理 | 使用者換裝置/換帳號時可能出現會員身分未正確轉移的邊界情況 | 已列入決定紀錄第 1 項與待決定清單，建議在正式開賣前決定處理方式 |

---

## 四、本文件與既有文件的關係

本文件聚焦於「30 天上架」這個目標本身的時程與風險；功能規格的細節（權限、頻道、過濾規則、資料表設計、系統文字等）請參考 [`docs/specs/paid-member-forum-spec.md`](./paid-member-forum-spec.md)，尤其是其中新增的「決定紀錄」章節（本次已定案的 10 項決定）。
