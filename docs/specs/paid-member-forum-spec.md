# 付費會員討論區 — 規格文件（v0.1 草案）

本文件只做規格與估算，不包含任何程式碼、資料庫 migration、設定變更或部署。所有「待你決定」項目在對應段落標明，未經核准前視為未定案。

定位：由付費會員彼此交流，平台不提供任何投資建議。

---

## 零、現況盤點（唯讀查證，2026-10-13）

### 0-1 會員、登入、付費機制

**VERIFIED**：`smartfund-v2` 已有登入機制——`lib/auth/supabaseAuth.ts` 用 Supabase Auth（cookie + Bearer token 兩種驗證路徑），`lib/auth/userService.ts` 的 `resolveSmartMatchUser()` 會把 Supabase 身分對應到自家 `User` 資料表（`prisma/schema.prisma`，`supabaseId` 唯一鍵）。

**VERIFIED**：`User` 資料表已有 `plan` 欄位（enum `Plan { FREE PREMIUM TEAM }`，預設 `FREE`），但 `toAccountResponse()` 函式裡的程式碼註解明確寫著：

> `// TODO: Replace this temporary account-plan boundary with Entitlement Service output.`

也就是說**目前「付費」只是一個可以被手動設定的欄位，沒有任何對應的購買/訂閱驗證機制**。

**VERIFIED（全專案搜尋，`smartfund-v2` 與 `smartmatch-mobile` 兩個 repo）**：完全查無 `RevenueCat`、`StoreKit`、`react-native-iap`、`expo-in-app-purchases`、收據驗證（receipt/purchaseToken）、訂閱到期日欄位等任何關鍵字或套件依賴。**結論：目前沒有 Apple／Google App 內購買機制，也沒有任何付費驗證後端。**

**前置依賴（列入討論區的硬性前提）**：討論區的「只有付費會員能看/能發言」這條規則，必須有一個**可信、可被伺服器驗證**的付費狀態來源，否則整個權限設計無從談起。這代表在討論區開發之前（或至少平行進行但討論區功能不得先上線），需要先完成：
1. Apple In-App Purchase（StoreKit 2 或 `react-native-iap`）+ App Store Server Notifications V2 webhook（接收續訂/取消/退款事件）。
2. Google Play Billing + Real-time Developer Notifications（RTDN）webhook。
3. 後端「Entitlement」服務：一張記錄訂閱狀態、到期日、平台來源、原始收據/token 參照的資料表，取代目前的 `plan` 手動欄位（或讓 `plan` 由這個服務自動寫入，不再手動改）。
4. 兩平台的 sandbox 測試、退款/試用期/寬限期（grace period）邊界案例處理。

估算工時見第 12 節；此項目也在第 12 節的待決定清單排第一順位，因為它會卡住本規格其餘所有「付費判斷」相關的開發排程。

### 0-2 推播基礎

**VERIFIED**：`smartmatch-mobile` 已有完整的 Expo 推播實作（`src/push/service.ts` 使用 `expo-notifications`、`expo-device`、`expo-secure-store`，呼叫 `/api/push/devices` 註冊裝置 token）；`smartfund-v2` 對應有 `app/api/push/devices/route.ts`。

**VERIFIED**：`prisma/schema.prisma` 已有 `WatchlistNotificationProfile` 模型（`channel_type` + `destination_reference` 的通用設計，不是只綁死「股價警示」這一種用途）。

**結論：可以重用。** 討論區的「回覆通知」（若核准開啟，見第 2 節）不需要新的推播基礎設施，只需要新增一個 `channelType` 值（例如 `FORUM_REPLY`）並在既有推播發送邏輯裡加一個觸發點即可，不需要新建 Expo/推播相關的底層程式碼。

### 0-3 Telegram 機器人架構

**VERIFIED**：現有的 `@smartmatch_monitor_bot`（`lib/daily-health-report/notify.ts`）**只有單向發送**——`notifyAnomaly(summary)` 呼叫 Telegram Bot API 的 `sendMessage`，用 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` 兩個環境變數。**沒有 webhook 接收端、沒有指令解析、沒有任何「接收使用者輸入」的程式碼。**

本規格第 6 節要求的「用 Telegram 指令管理討論區」（`/hide`、`/delete`、`/suspend` 等）需要**全新建置**一個 webhook 接收端（Telegram 的 `setWebhook` + `secret_token` 標頭驗證）、指令解析器、inline keyboard 確認按鈕邏輯——現有的 `notifyAnomaly` 完全沒有涵蓋這塊。

**沿用同一個機器人 vs. 另開一個**（說明利弊，不代為決定）：

| | 沿用 `@smartmatch_monitor_bot` | 另開新機器人 |
|---|---|---|
| 優點 | 不用新註冊 BotFather、少一組密鑰要管理 | 關注點分離：營運告警（daily-health-report）跟內容審核（有法遵/隱私權重，需要你本人及時處理）完全獨立；討論區 webhook 的任何 bug 不會波及既有告警管道；可以設定不同的聊天室/權限範圍 |
| 缺點 | 告警訊息跟審核指令混在同一個聊天室，容易漏看或誤觸；討論區 webhook 若出錯可能干擾 daily-health-report 的既有邏輯（共用同一組 token） | 多一組 BotFather 設定與密鑰、多一個 webhook 端點要維護 |

**建議**：另開新機器人。討論區審核牽涉使用者申訴、停權等需要你本人即時處理的事項，混在既有的系統告警聊天室裡風險較高；多一組密鑰的維運成本相對小。但最終選擇留給你決定（見第 12 節待決定清單）。

### 0-4 資料庫隔離

**VERIFIED**：`smartfund-v2` 的 Postgres 資料庫目前**只有一個 `public` schema**，`prisma/schema.prisma` 沒有使用 Prisma 的 `multiSchema` 預覽功能（搜尋 `@@schema`、`schemas = ` 皆無結果）。這個資料庫同時被台股 App（`tw-data-updater` 相關的 `stocks`、`stock_history`、`production_scheduler_runs` 等表）共用。

**提案**：討論區專用 Postgres schema 命名為 **`forum`**，並啟用 Prisma 的 `multiSchema` 預覽功能（`datasource` 區塊加 `schemas = ["public", "forum"]`），討論區每一張新表都加 `@@schema("forum")`。即使在 `forum` schema 內，資料表名稱仍加 `forum_` 前綴（例如 `forum_posts`）作為第二層防呆，避免未來人工下 SQL 時誤連到錯的 schema 還能從表名立刻看出歸屬。這個隔離方式目前整個程式碼庫沒有先例，是一個新的架構決定，需要你核准（第 12 節待決定清單）。

---

## 一、權限

- 只有付費會員能**看**討論區內容，也只有付費會員能**發言**。免費用戶只能看到「討論區介紹」與「升級」導引頁，**完全看不到任何文章標題、摘要或文章數量**（連「目前有 123 篇文章」這種聚合數字都不顯示，避免引誘免費用戶猜測內容）。
- 發言者的付費身分**必須在伺服器端驗證**（查詢 Entitlement 服務的即時狀態，不得只信任 App 端傳來的旗標，也不得用太久的快取——提案：每次發文/編輯都即時查詢，瀏覽列表可以快取數分鐘）。
- 暱稱（討論區專用，與帳號 `displayName` 分開）規則：
  - 長度 2–20 字（以字元數計，中英文皆同）
  - 全站唯一（比對時忽略大小寫與全半形差異）
  - 不得包含：電話/Email 格式、LINE/IG/FB/微信等通訊軟體名稱、本規格第 5 節的過濾字詞
  - 首次發言前必須設定暱稱，之後**提案**每 14 天才能更改一次（防止用改名規避檢舉歷史或防止人格混淆）——此頻率限制**待你核准**。
- **付費到期後的處理方案（提案）**：
  - 文章與回覆**保留**，不隱藏、不刪除（維持其他使用者回覆串的完整性與社群真實性）。
  - 到期使用者**無法瀏覽討論區列表/他人文章，也無法發言或回覆**，App 顯示「訂閱已到期」導引至升級頁。
  - 到期使用者**仍可看到自己過去發表過的文章清單**（唯讀），讓他知道自己寫過什麼，但不能瀏覽其他人內容、不能互動。
  - 以上方案為提案，**待你核准**。

---

## 二、硬性規定

- **完全不提供**任何使用者對使用者的私訊、私人聊天室、加好友、追蹤使用者、或「@提及」觸發的私人通知功能。這些功能**不存在於本規格的任何一個版本**，不是「v1 先不做」，是整個產品方向的紅線。
- 個人頁只顯示：暱稱、加入時間。**不開放填寫簡介、連結，資料庫層級就不給這些欄位**（見第 10 節草案），從根本上免除「要不要過濾個人頁內容」的問題。
- 所有發言只存在於公開頻道，沒有任何「悄悄話」「限定可見」的文章類型。
- **工程政策**：日後任何可能讓使用者私下聯絡的功能（含看起來無害的「分享給朋友」「標記好友」之類），上線前都要先取得你的核准。建議把這條政策也寫進 `smartfund-v2` 的 `CLAUDE.md`（本次不執行，列入第 12 節待核准事項）。
- **「別人回覆我的文章時是否通知我」——待你決定，不得預設開啟**，兩種做法利弊：

  **方案 A：推播通知**（重用第 0-2 節的 Expo 推播基礎）
  - 優點：使用者比較不會錯過回覆，提升互動率，屬於標準論壇體驗。
  - 缺點：若審核（檢舉/自動隱藏）有延遲，可能先推播了之後才發現內容有問題；需要額外設計「只在回覆*首次送出*時推播一次，編輯不重複推播、違規內容被隱藏後是否要收回已送出的推播通知（Expo 推播無法收回，只能定義好規則讓系統知道不要對已被自動過濾擋下的內容發送）」。

  **方案 B：僅 App 內靜態提示**（沒有推播，只在討論區本身的介面顯示「有新回覆」的小紅點/未讀計數）
  - 優點：完全不會有通知內容本身的審核時機問題，實作最簡單，也不會有任何類似「單向私訊」的疑慮空間。
  - 缺點：使用者得自己打開 App 檢查，engagement 較低。

---

## 三、頻道

依本 App 現有功能範圍（`/markets`、`/etf`、`/funds`、`/compare`、`/quiz`、`/portfolio`、`/pricing`、`/rankings` 等既有頁面）提案以下頻道，**不設個股買賣頻道**：

| 頻道 | 用途說明 | 適用規範重點 |
|---|---|---|
| 📢 公告 | **只有官方帳號能發文**，App 更新、活動、規則修訂公告 | 其他使用者只能瀏覽，無法回覆或發文 |
| 總體經濟與市場 | 總經數據、國際市場走勢、指數討論 | 禁止個股進出建議；資料來源討論可以 |
| 基金與 ETF 討論 | ETF/基金的比較方法、資料面討論（配息、持股、追蹤誤差等） | 禁止「買這檔」「現在進場」等交易建議用語；資料面討論不受限 |
| 投資心得與工具分享 | 分享篩選邏輯、資產配置方法論、個人紀律與心態，不針對特定標的喊買賣 | 嚴格禁止個股代號+交易動詞的組合（見第 5 節） |
| App 使用心得與建議 | 功能建議、使用問題、介面回饋 | 一般社群規範 |
| 資料問題回報 | 回報資料不正確、更新延遲等問題 | 一般社群規範；可附帶截圖（但第一版不開放上傳圖片，見第 5 節，暫以文字描述） |

每個頻道清單**待你核准**。

---

## 四、規範與聲明

- 使用者**第一次發言前**必須閱讀並勾選同意「討論區規範」；規範改版後，所有人下次發言前必須重新同意。記錄：`userId` + 同意的規範版本號 + 同意時間（見第 10 節 `forum_rule_acceptance`）。
- 每個頻道置頂一篇規範文（官方帳號發布），並在每個頻道頁面固定顯示（非彈窗、常駐）：

  > **本區為用戶交流，不構成投資建議。**

### 第一版討論區規範全文（草稿）

> **SmartMatch 討論區使用規範（v1）**
>
> 歡迎來到 SmartMatch 付費會員討論區。在發言前，請詳細閱讀以下規範。
>
> **1. 本區定位**
> 本區僅供付費會員交流投資心得與使用心得，所有內容均為會員個人意見，**不構成投資建議**，SmartMatch 對任何內容之正確性、完整性不負保證責任。投資請自行判斷風險，並審慎評估。
>
> **2. 禁止事項**
> - 不得張貼任何個股買進、賣出、進出場時機、目標價、明牌等交易建議。
> - 不得使用本區私訊導流至其他聯絡方式（電話、Email、LINE、微信等通訊軟體），不得張貼外部連結或短網址招攬。
> - 不得從事「加我」「帶單」「保證獲利」等疑似投資詐騙之招攬行為。
> - 不得發表人身攻擊、歧視、騷擾或其他不雅言論。
> - 不得重複張貼相同或高度相似內容（灌水）。
>
> **3. 身分與暱稱**
> 發言需使用討論區專屬暱稱，暱稱不得包含聯絡方式或不當字詞，且全站需唯一。
>
> **4. 違規處理**
> 違反本規範的內容可能被系統自動擋下、經檢舉後隱藏，或由管理員直接下架；情節嚴重或多次違規者，帳號將被暫停（1 天／7 天／30 天）或永久停權。
>
> **5. 檢舉與申訴**
> 任何內容若您認為不適當，請使用「檢舉」功能通知管理員。若您的帳號或內容被處分且有異議，請透過官方 Email 申訴，**本區不開放透過私訊方式申訴**。
>
> **6. 隱私與帳號**
> 您可以在 App 內隨時刪除您的討論區帳號；刪除後您的文章與回覆內容將被移除，但既有的審核紀錄（不含個人資料與文章內容）可能基於防弊目的保留。
>
> **7. 規範修訂**
> 本規範可能不定期修訂，修訂後需重新同意才能繼續發言。

（以上為草稿，待你審閱與核准後定案為 v1。）

---

## 五、自動過濾

伺服器端執行，**發文與編輯時都檢查**；被擋下時回應使用者具體原因分類（不需逐字告知命中哪個詞，避免被用來反測試過濾規則）。

### 比對前的正規化（pipeline）

1. 全形/半形統一（數字、英文字母、標點）
2. 移除/壓縮空白與分隔符號（含中間插入符號規避，例如「0912-xxx-xxx」「0 9 1 2」）
3. 簡繁轉換後再比對一次（避免簡體字規避）
4. 常見諧音/替代字比對（例如注音文、同音異字的已知清單，隨過濾字詞設定檔一起維護）
5. 數字的中文大寫／全形／拆字寫法展開比對（例如電話拆成「零九一二」或「０９１２」）

### 分類規則

**防詐騙導流（直接擋）**：電話號碼格式、Email 格式、LINE/微信/Telegram 等通訊軟體名稱、外部連結與短網址（官方網域白名單除外）、「加我」「帶單」「保證獲利」等招攬用語、「私訊」及其變形（私我、PM、站內信）。
**特殊處理**：「老師」「群組」單獨出現時**不擋，只通知管理員**（這兩個詞本身不必然違規，但常是詐騙前兆用語）。

**個股交易建議（條件式擋）**：個股代號或名稱，與交易用語（買進、賣出、目標價、進出場、明牌、飆股等）**同時出現在 30 字範圍內**才擋；純基金/ETF 資料面用語（配息、持股、追蹤誤差等）不擋；「代號＋長期持有／基本面」這類組合**不擋，只通知管理員**參考。

**不雅字詞（分級處理）**：人身攻擊與歧視詞彙**直接擋**；口語讚美類（例如「屌」）**不擋，只通知管理員**。

### 設定與紀錄

- 過濾字詞清單存成**獨立設定檔**（JSON，含版本號與修改紀錄 `changelog`），**調整內容不需要更新 App**（後端讀設定檔，不是寫死在程式碼或 App 裡）。
- 被擋下的發文嘗試留存紀錄（原始內容、命中分類、時間、使用者）供調整字詞參考；**同一人短時間內多次被擋，通知管理員**（提案門檻：10 分鐘內 3 次，待核准）。此紀錄含個人撰寫內容，第 10 節建議訂保存期限（提案 90 天），**待你決定**。
- **第一版不開放上傳圖片。**

過濾字詞草稿清單另存 `docs/specs/forum-filter-terms.draft.json`（內容見該檔案），**刻意不放在應用程式會讀取的設定路徑**，純供你審閱；正式上線前需要你逐條覆核並搬到正式設定位置。

---

## 六、管理（Telegram 機器人）

- 指令（草案）：
  - `/reports` — 列出待處理檢舉
  - `/hide <id>` — 隱藏文章/回覆
  - `/delete <id>` — 刪除（需按確認按鈕才真正執行）
  - `/suspend <id> 1|7|30` — 暫停發言 1/7/30 天（需確認按鈕）
  - `/ban <id>` — 永久停權（需確認按鈕）
  - `/approve <id>` — 核准新會員第一篇待審文章
- 只接受**你本人**的聊天室指令：以 Telegram 聊天室 ID 白名單驗證；webhook 端點需驗證 Telegram 的 `X-Telegram-Bot-Api-Secret-Token` 標頭（`setWebhook` 時設定的 `secret_token`）。
- 刪文與停權類指令**需要按 inline keyboard 的確認按鈕才會真正執行**，避免誤觸指令造成無法復原的動作。
- **同一則內容被 3 人檢舉就自動隱藏**（進入待你審核狀態，不是直接刪除）。
- 檢舉**由你本人處理**，目標 24 小時內；**超過 20 小時未處理，系統再提醒一次**（需要一個排程工作掃描待處理超過 20 小時的檢舉）。
- 所有管理動作寫入**只能新增**的紀錄表（`forum_moderation_log`，見第 10 節；此表不存文章內容與個人資料，見第 8 節的衝突解法）。

**被停權使用者在 App 上看到的訊息（草稿）**：
> 您的討論區發言權限已被暫停至 {日期}（或：已被永久停權）。如有疑義，請透過官方 Email（contact@smartmatch.tw）申訴，我們將盡快處理。本功能不開放透過私訊申訴。

---

## 七、防灌水

- **發文頻率限制（提案數字，待核准）**：
  - 主文：每人每 30 分鐘最多 1 篇，每日最多 5 篇。
  - 回覆：每人每 5 分鐘最多 3 則，每日最多 50 則。
- **新會員第一篇主文先審後發**（進入 `PENDING` 狀態，管理員 `/approve` 後才公開可見；核准過一次之後，後續文章恢復一般流程，只受過濾引擎與檢舉機制管控）。
- **24 小時內重複內容擋下**：以正規化後內容的指紋（例如正規化文字的雜湊值）比對使用者自己過去 24 小時內的發文，命中則擋下並說明「內容與您近期發文重複」。

---

## 八、刪除帳號

- App 內可刪除討論區帳號，**文章與回覆一併從其他使用者視角移除**。
- **衝突**：第 6 節要求管理紀錄表只能新增（審計用途），但帳號刪除要求移除內容。
- **提案解法（待你決定）**：`forum_moderation_log` 設計上**本來就不存文章內容或個人資料**，只存：動作類型、目標內容的「不透明參照編號」（content id，而非內容本身）、操作者（管理員 Telegram ID 或 `SYSTEM`）、時間、當下檢舉人數。如此一來：
  - 帳號刪除時，`forum_posts`/`forum_replies` 的內容欄位被清空（寫入佔位文字或直接清為 NULL，狀態改為 `DELETED`，**不刪除資料列本身**，以維持其他人回覆串的關聯完整性）。
  - `forum_moderation_log` 的歷史紀錄列繼續存在（參照一個現在已經「內容已清空」的 content id），但因為該表從未儲存過文章內容或個人資料，不會有被刪除者的個資殘留，滿足「被遺忘權」的精神。
  - 這個設計是否恰當（是否仍有法遵疑慮、是否需要在隱私權政策中說明），**待你決定**，建議同時交由法務確認（見第 9 節）。
- **別人回覆中引用（quote）已刪除內容的處理**：quote 內容**不是**在寫入時複製一份存起來，而是在「顯示」當下即時參照原文章/回覆的目前狀態；原文被刪除後，quote 區塊自動顯示「（原始內容已刪除）」佔位文字。**不會、也不需要**去修改其他人當初寫的回覆本文（那是他們自己的言論，不應該被系統事後竄改）。

---

## 九、上架審查與法規

### Apple App Store Review Guidelines

**Guideline 1.2（User-Generated Content）** — VERIFIED，查詢日期 2026-10-13：含 UGC 或社群功能的 App 必須具備：(a) 發文前過濾不當內容的機制、(b) 檢舉機制且能及時回應、(c) 封鎖濫用使用者的能力、(d) 公開的開發者聯絡資訊。本規格第 5、6 節的設計對應 (a)(b)(c)；聯絡資訊需確認 App Store 上架頁面有列出官方 Email（對應 (d)）。
來源：[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Guideline 1.2 討論串](https://developer.apple.com/forums/thread/807358)

**Guideline 5.1.1(v)（帳號內刪除）** — VERIFIED（來自開發者論壇與第三方彙整，**非 Apple 官方頁面原文**，查詢日期 2026-10-13）：支援帳號註冊的 App 必須在 App 內提供「刪除帳號」（不是只能停用），且刪除需包含個人資料、不得只能透過客服管道完成（高度監管產業除外）。本規格第 8 節已設計對應流程。
來源：[開發者論壇討論串](https://developer.apple.com/forums/thread/693997)——**建議上線前直接以 developer.apple.com 當下公告的正式文字為準再次核對**，本條目標示 UNKNOWN 最新官方原文措辭是否有變動。

**Guideline 3.1.1（App 內購買）** — VERIFIED（第三方彙整，查詢日期 2026-10-13）：App 內解鎖功能/訂閱必須使用 Apple In-App Purchase，不得自建解鎖機制，App 內也不得放置導向其他付款方式的按鈕/連結。本規格第 0-1 節的付費前置依賴即對應此規則。
來源：[in-app purchase compliance 文章](https://appmaster.io/blog/in-app-purchase-compliance-and-app-store-guidelines)——同樣建議以官方頁面正式文字為準。

### Google Play 政策

**用戶原創內容（UGC）政策** — VERIFIED，查詢日期 2026-10-13：要求持續且有效的內容審核機制、發文前需使用者同意服務條款、App 需定義「不當內容」範圍、需提供檢舉與封鎖使用者的機制。
來源：[Google Play Console 說明](https://support.google.com/googleplay/android-developer/answer/9876937)

**Google Play Billing（付費/訂閱）政策** — VERIFIED，查詢日期 2026-10-13：App 內收費的訂閱服務必須使用 Google Play 帳務系統，不得在 App 內放置導向其他付款方式的按鈕/連結/呼籲。
來源：[Google Play 帳務政策](https://support.google.com/googleplay/android-developer/answer/9858738)

**年齡分級可能的變化**：UNKNOWN——新增使用者對使用者的公開發言功能，兩個平台的分級問卷都可能因「使用者原創內容」「使用者互動」選項而調高分級（例如 Apple 的 17+ 門檻常與 UGC/聊天功能相關），實際結果需要在雙方開發者後台重新填寫分級問卷才能確定，本規格不predict結果。

### 台灣法規（僅列條文名稱與重點，標示「需法務確認」，不自行下結論）

查詢日期 2026-10-13，以下內容來自搜尋引擎彙整之二手資料，**非直接讀取全國法規資料庫（law.moj.gov.tw）原文**，條文現況與是否已修正生效均標示 UNKNOWN，上線前**需法務確認**：

1. **證券投資信託及顧問法**（投信投顧法）——涉及「不得非法招攬投資」相關規定（例如涉及廣告責任的條文討論）。**需法務確認**：討論區若被使用者濫用於招攬投資（即便本規格已設計過濾機制擋下交易建議與招攬用語），平台是否仍有相應義務或風險。
2. **詐欺犯罪危害防制條例**（打詐條例）——涉及網路平台業者對已知詐欺廣告/內容的處置義務。**需法務確認**：本討論區的檢舉與下架機制（第 6 節）是否足以符合相關義務。
3. **個人資料保護法**（個資法）——涉及蒐集個資之特定目的與利用範圍限制、刪除/停用請求的處理。**需法務確認**：第 8 節「帳號刪除但審核紀錄保留」的設計是否符合個資法對「利用目的」與「保存期限」的要求。

來源（二手彙整，非法規原文）：搜尋引擎查得之條文討論（hackmd 台灣網路法規彙整、公視新聞網、台北市法規資料庫函釋頁）。**建議直接以 [全國法規資料庫](https://law.moj.gov.tw) 查詢三部法規最新條文與修正沿革為準**，本規格不引用、不轉載法條原文，也不做任何法律結論。

---

## 十、資料表設計草案（僅草案，不執行任何 DDL）

所有表格：
- 所屬 Postgres schema：**`forum`**（Prisma `multiSchema` 預覽功能，見第 0-4 節）。
- 每張表 **ENABLE ROW LEVEL SECURITY**，並 **REVOKE ALL FROM anon, authenticated**（沿用 `CLAUDE.md` 既有的全域規則）——所有存取一律經由伺服器端（Prisma 直連或 service role），不開放 Supabase 用戶端直接讀寫任何討論區資料表。

```
forum_profiles
  id              uuid PK
  user_id         text  FK -> public.users(id)  UNIQUE
  nickname        text  UNIQUE (比對時 citext 或 lower(nickname) 唯一索引)
  nickname_changed_at timestamptz NULL
  status          text  (ACTIVE / SUSPENDED / BANNED / DELETED)
  created_at      timestamptz
  updated_at      timestamptz

forum_channels
  id              uuid PK
  slug            text  UNIQUE
  name            text
  description     text
  official_only   boolean DEFAULT false
  sort_order      int

forum_posts
  id              uuid PK
  channel_id      uuid  FK -> forum_channels(id)
  author_id       uuid  FK -> forum_profiles(id)
  title           text  NULL（刪除後清空）
  body            text  NULL（刪除後清空）
  status          text  (PENDING / PUBLISHED / HIDDEN / DELETED)
  report_count    int   DEFAULT 0
  created_at      timestamptz
  updated_at      timestamptz
  deleted_at      timestamptz NULL
  INDEX (channel_id, status, created_at)
  INDEX (author_id)

forum_replies
  id              uuid PK
  post_id         uuid  FK -> forum_posts(id)
  author_id       uuid  FK -> forum_profiles(id)
  body            text  NULL（刪除後清空）
  status          text  (PUBLISHED / HIDDEN / DELETED)
  report_count    int   DEFAULT 0
  created_at      timestamptz
  updated_at      timestamptz
  deleted_at      timestamptz NULL
  INDEX (post_id, status, created_at)
  INDEX (author_id)

forum_reports
  id              uuid PK
  target_type     text  (POST / REPLY)
  target_id       uuid
  reporter_id     uuid  FK -> forum_profiles(id)
  reason          text
  created_at      timestamptz
  resolved_at     timestamptz NULL
  resolved_by     text  NULL（Telegram 操作者 ID）
  UNIQUE (target_type, target_id, reporter_id)  -- 同一人對同一內容只能檢舉一次

forum_moderation_log   -- 只能 INSERT，不存文章內容與個資
  id              uuid PK
  action_type     text  (HIDE / DELETE / SUSPEND_1D / SUSPEND_7D / SUSPEND_30D / BAN / APPROVE)
  target_type     text  (POST / REPLY / PROFILE)
  target_ref      uuid  -- 不透明參照，刪除後可能指向已清空內容的列
  actor_ref       text  (Telegram 操作者 ID 或 'SYSTEM')
  report_count_at_action int NULL
  created_at      timestamptz
  -- 應用程式角色對此表只授予 INSERT/SELECT，不授予 UPDATE/DELETE

forum_rule_acceptance
  id              uuid PK
  profile_id      uuid  FK -> forum_profiles(id)
  rule_version    text
  accepted_at     timestamptz
  UNIQUE (profile_id, rule_version)

forum_blocked_attempts   -- 含使用者原始輸入內容，僅供調整過濾字詞用途
  id              uuid PK
  profile_id      uuid  FK -> forum_profiles(id)
  channel_id      uuid  NULL
  matched_category text (FRAUD_REDIRECT / STOCK_ADVICE / PROFANITY)
  matched_term_ref  text NULL
  raw_content     text
  attempted_at    timestamptz
  -- 提案保存期限 90 天後自動清除（排程工作），待你決定

forum_suspensions
  id              uuid PK
  profile_id      uuid  FK -> forum_profiles(id)
  type            text  (TEMP_1D / TEMP_7D / TEMP_30D / PERMANENT)
  reason          text
  starts_at       timestamptz
  ends_at         timestamptz NULL  -- PERMANENT 時為 NULL
  created_by      text  (Telegram 操作者 ID)
```

**刪除連帶規則**：`forum_profiles` 刪除（帳號刪除）時，不做資料庫層級的 `ON DELETE CASCADE` 真刪除 `forum_posts`/`forum_replies`，而是由應用程式邏輯將這兩表對應列的 `title`/`body` 清空、`status` 改為 `DELETED`（理由見第 8 節）。`forum_reports`/`forum_moderation_log` 的外鍵參照在作者帳號刪除後維持不變（歷史動作紀錄不因來源帳號刪除而消失，但本來就不含個資）。

**保存期限**：
- `forum_posts`/`forum_replies`：帳號存續期間保留；帳號刪除後內容清空但資料列保留（結構性原因見上）。
- `forum_blocked_attempts`：提案 90 天後清除，**待你決定**。
- `forum_moderation_log`：不含個資，提案不設清除期限（審計用途）。

---

## 十一、系統文字草稿

以下草稿已自行檢查過，**未出現「推薦」「最佳」「買進」「賣出」**等字樣。

**按鈕**：發表文章、送出回覆、同意並繼續、檢舉此內容、取消、確定刪除、確定暫停、恢復訂閱

**提示文字**：
- 「發言前請先閱讀並同意討論區規範。」
- 「請設定您的討論區暱稱（2–20 字，需全站唯一）。」
- 「本區僅供付費會員交流，升級後即可瀏覽與發言。」

**錯誤訊息**：
- 「您的發言內容可能包含不適當資訊，請修改後再試一次。」
- 「這個暱稱已經有人使用了，請換一個。」
- 「您的暱稱包含不允許的內容，請重新輸入。」
- 「您目前無法在本區發言，請查看您的帳號狀態。」
- 「您的訂閱已到期，恢復訂閱即可繼續瀏覽與發言。」

**通知文字（若核准開啟回覆通知）**：
- 「您的文章有新回覆，點此查看。」

**管理相關**（App 內顯示給被處分者）：
- 「您的討論區發言權限已被暫停至 {日期}。」
- 「您的帳號已被停權。如有疑義，請來信 contact@smartmatch.tw 申訴，本功能不開放私訊申訴。」
- 「您的文章已達檢舉次數門檻，目前暫時隱藏並待審核。」

---

## 十二、工時估算與待決定清單

### 工時估算（人天，單一開發者概估，實際依人力配置可平行縮短）

| 模組 | 估算 | 備註 |
|---|---|---|
| 前置付費機制（IAP + 後端驗證 + webhook） | 10–15 | 不確定性最高：雙平台 sandbox 測試、續訂/退款/寬限期邊界案例 |
| 後端 API（頻道/文章/回覆/檢舉/個人頁） | 8–10 | |
| 過濾引擎（正規化 + 比對 + 設定檔 + 紀錄） | 5–7 | |
| App 介面（列表/詳情/發文/個人頁/升級導引） | 10–12 | |
| Telegram 管理（webhook + 指令 + 確認按鈕 + 提醒排程） | 5–6 | 若沿用現有機器人可略省設定時間，邏輯工時不變 |
| 審查準備（素材、隱私權政策更新、年齡分級、測試帳號） | 3–4 | |
| 測試（防詐騙/過濾案例、濫用情境、上架審查模擬） | 5–7 | |
| **合計** | **約 46–61 人天** | 單人全職約 9–12 週；付費機制可與其他模組部分平行 |

### 待你決定/核准的項目清單（依優先順序）

1. **付費機制選型與時程**（第 0-1 節）——最高優先，會卡住其餘所有「付費判斷」相關開發。
2. **Telegram 機器人**：沿用 `@smartmatch_monitor_bot` 或另開新機器人（第 0-3 節，本文件建議另開）。
3. **回覆通知**：是否開啟、開啟的話選哪一種做法（第 2 節方案 A/B）。
4. **帳號刪除 vs. 管理紀錄表只能新增**的衝突解法（第 8 節提案）是否核准。
5. **暱稱變更頻率**：提案 14 天一次（第 1 節）。
6. **`forum_blocked_attempts` 保存期限**：提案 90 天（第 10 節）。
7. **頻道清單與命名**（第 3 節）是否核准。
8. **過濾字詞清單**（`docs/specs/forum-filter-terms.draft.json`）逐條審閱。
9. **防灌水頻率數字**（第 7 節提案）是否核准。
10. **系統文字草稿**（第 11 節）是否核准。
11. 工程政策「未來私下聯絡類功能需先核准」是否要寫進 `CLAUDE.md`（第 2 節，本次未執行）。
12. 資料庫 schema 隔離方式：`forum` schema + Prisma `multiSchema`（第 0-4 節）是否核准此架構方向。
