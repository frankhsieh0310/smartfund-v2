# 付費機制規劃（2026-10-18，純規劃，沒有寫程式碼）

## 現況盤點（VERIFIED，直接查程式碼）
- `app/pricing/page.tsx` 方案頁**已經做好 UI**：Free／Lite NT$99／Pro NT$299／Advisor NT$599／
  Team NT$1,499 五個方案，功能矩陣都列好了，每個付費按鈕目前是 `alert("付款功能即將推出，我們會
  第一時間通知您。")` 的佔位符，沒有接任何金流。
- `prisma/schema.prisma` 的 `User.plan` 欄位已經存在（`enum Plan { FREE PREMIUM TEAM }`），但**沒有
  任何程式碼會去改這個欄位**——沒有金流、沒有 webhook、沒有訂閱狀態同步。這個 enum 的值
  （`PREMIUM`/`TEAM`）跟方案頁的五個方案名稱（Free/Lite/Pro/Advisor/Team）也不是一一對應，需要先
  決定清楚方案跟 enum 怎麼對應，或是把 enum 改成跟方案頁一致的五檔。
- 另一個工作階段在做的「台股拼圖」App（同一家公司的另一個 App，不是這個財經 App）已經在用
  **RevenueCat** 管理訂閱（`app/twpuzzle/privacy/page.tsx` 裡有寫），代表公司帳號層級可能已經有
  RevenueCat 的組織帳號可以共用，值得先問清楚再決定要不要延用同一套。

## 平台規則上的硬性限制（必須遵守，不是建議）
- **這是行動 App（iOS／Android）**，任何「解鎖 App 內數位內容/服務」的付費**依蘋果規則必須走
  Apple In-App Purchase（StoreKit）**，不能繞過 IAP 直接收信用卡——這正是交付清單裡提到的
  「Apple 4.3」審查重點之一，之前已經被列為上架前必須處理的項目。Google Play 對應規則是
  Google Play Billing，限制比 Apple 稍寬但同樣要求數位內容走平台內購。
- 如果同時想支援「網頁版直接刷卡訂閱」（例如給理專在電腦上簽約），網頁刷卡（如 Stripe／綠界）
  **不能跟 App 內購用同一個方案代碼直接混用**，兩邊的訂閱狀態要各自管理、再同步回同一個
  `User.plan`，否則會出現「App 內購買的订閱，網頁看不到」或反過來的問題。

## 建議架構（規劃，沒有實作）
1. **訂閱管理層選 RevenueCat**（不是 Stripe 直接接）：
   - 原因：RevenueCat 本來就是設計來同時處理 Apple IAP + Google Play Billing + Stripe（網頁）
     三種金流來源，統一成一個「entitlement」狀態，不用自己重新寫三套金流對帳邏輯；而且公司另一
     個 App 已經在用，可能可以共用組織帳號、降低學習成本與串接時間。
   - 不建議直接接 Stripe：Stripe 本身無法滿足 Apple/Google 的 IAP 規則，單獨接 Stripe 只能用在
     網頁端，行動 App 端還是要另外接 StoreKit/Play Billing，等於要維護兩套。
2. **App 端**：用 `react-native-purchases`（RevenueCat 官方 SDK）取代目前的 `alert()` 佔位符，
   呼叫 RevenueCat 的 purchase flow；方案頁五個方案要先在 App Store Connect／Google Play Console
   建好對應的訂閱商品（product id），並在 RevenueCat 後台建對應的 entitlement（例如
   `lite`/`pro`/`advisor`/`team`）。
3. **伺服器端**：新增一個 webhook endpoint（例如 `app/api/webhooks/revenuecat/route.ts`）接收
   RevenueCat 的 entitlement 變更事件（新訂閱／取消／到期／退款），驗證簽章後更新對應
   `User.plan`；同時要決定 `Plan` enum 要不要擴充成跟方案頁一致的 5 檔（目前只有
   FREE/PREMIUM/TEAM 三檔，蓋不住 Lite/Pro/Advisor 的區隔）。
4. **權限檢查**：目前 App 內各功能（客戶管理筆數上限、走勢比較檔數、PDF 匯出次數等）看起來都還
   沒有依 `plan` 做限制——這也要另外盤點，不在這份文件範圍內，先列為後續待辦。

## 時程與依賴關係（規劃順序）
1. **決定方案對應**：先決定 5 個方案名稱跟 `Plan` enum（或擴充後的新 enum）的對應關係，跟使用者
   確認方案頁上的功能矩陣（表格裡的勾選）是最終版本，還是之後會再調整——金流串接的 product id
   命名、entitlement 命名都要等這個先定案，不然串好之後改方案會牽動很多地方。
2. **App Store Connect／Google Play Console 建立訂閱商品**：需要使用者（帳號擁有者）自己在
   兩邊後台建立，我這邊可以先準備好商品命名規則跟說明文件。
3. **RevenueCat 串接**（App SDK + 伺服器 webhook）：這部分我可以在 Preview 開發測試（用
   RevenueCat 的 Sandbox／測試模式，不會動到真實金流），但正式的訂閱商品上架、金流開通仍然要
   使用者本人在對應後台完成。
4. **功能權限限制**：串接完成後，依方案限制 App 內各功能的使用上限。

## 這份規劃**沒有**做的事（刻意不做，等使用者決定後才動手）
- 沒有建立任何 RevenueCat 帳號或商品設定（需要使用者的 App Store Connect／Google Play
  Console／RevenueCat 帳號權限，我沒有也不該有）。
- 沒有修改 `Plan` enum 或任何資料庫結構。
- 沒有移除方案頁現有的 `alert()` 佔位符（移除前要先確定金流串接方向，不要先拆掉再補不上）。
