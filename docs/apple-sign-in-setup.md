# 設定「使用 Apple 登入」— 給非工程師的逐步教學

這份文件是給**不寫程式的人**看的。目的：讓 App 可以提供「使用 Apple 登入」（iOS 上架需要，因為 App 已經有 Google 登入）。

你會用到兩個網站：
1. **Apple Developer 後台**（developer.apple.com）— 需要公司/個人的 Apple Developer 付費帳號（一年約 US$99，免費帳號不能用這個功能）。
2. **Supabase 後台**（supabase.com/dashboard）— 這個專案已經有帳號，直接登入既有帳號即可。

全部做完大約 20-40 分鐘。**過程中會下載一個檔案（.p8），這個檔案只能下載一次，請小心保存，不要刪除、不要外流。**

---

## 第一部分：Apple Developer 後台

### 步驟 1：確認帳號資格
1. 打開 https://developer.apple.com/account
2. 用你的 Apple ID 登入。
3. 確認頁面上方有顯示你是「Apple Developer Program」的會員（不是免費帳號）。如果沒有，需要先加入付費方案才能繼續。

### 步驟 2：記下 Team ID
1. 還在 developer.apple.com/account 這個頁面，往下找「Membership details」（會員資料）這個區塊。
2. 找到「Team ID」，是一串 10 個字元的英數字（例如 `A1B2C3D4E5`）。
3. **把這串 Team ID 複製下來**，先貼到一個記事本暫存——之後 Supabase 設定會用到。

### 步驟 3：在 App ID 上開啟「Sign In with Apple」功能
1. 左側選單點「Certificates, Identifiers & Profiles」。
2. 點左邊的「Identifiers」。
3. 清單裡找到 `com.smartmatch.mobile`（這是這個 App 的 ID），點進去。
4. 畫面會列出一堆可以勾選的「Capabilities」（功能）。往下找到「Sign In with Apple」，**勾選它**。
5. 右上角點「Save」存檔。如果跳出確認視窗，點「Confirm」。

### 步驟 4：建立一個「Sign in with Apple」用的金鑰（Key）
1. 還在「Certificates, Identifiers & Profiles」頁面，左邊選單點「Keys」。
2. 點右上角的「+」（新增）。
3. 「Key Name」隨便填一個好記的名字，例如 `SmartMatch Apple Sign In Key`。
4. 往下找到「Sign In with Apple」，**勾選它**，右邊會出現一個「Configure」按鈕，點進去。
5. 在「Primary App ID」選單選 `com.smartmatch.mobile`，點「Save」。
6. 點右上角「Continue」，再點「Register」。
7. 下一頁會出現「Download」按鈕——**點下去，把這個 `.p8` 檔案存到安全的地方（例如一個加密的隨身碟，或密碼管理工具的附件）。這個檔案只能下載這一次，之後 Apple 不會再給你第二次下載的機會，如果遺失要整個重新做一次這個步驟。**
8. 這一頁也會顯示一個「Key ID」，是一串 10 個字元的英數字。**把這個 Key ID 也複製下來**，貼到剛才那個記事本。

做完這一步，你的記事本應該有三個東西：
- Team ID（第 2 步拿到的）
- Key ID（第 4 步拿到的）
- 一個 `.p8` 檔案（第 4 步下載的）

---

## 第二部分：Supabase 後台

### 步驟 5：把三個東西填進 Supabase
1. 打開 https://supabase.com/dashboard，登入這個專案既有的帳號。
2. 選進這個專案（專案名稱應該跟 smartfund-v2 / smartmatchpilot 有關）。
3. 左側選單點「Authentication」（人形圖示）。
4. 上方選單點「Providers」（或「Sign In / Providers」）。
5. 在 Provider 清單裡找到「Apple」，點開它。
6. 把開關打開（Enable）。
7. 會看到幾個欄位要填：
   - **Team ID**：填第 2 步拿到的那串。
   - **Key ID**：填第 4 步拿到的那串。
   - **Secret Key (.p8)**：用文字編輯器（例如記事本）打開第 4 步下載的 `.p8` 檔案，整個內容複製貼上到這個欄位（包含 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----` 這兩行）。
   - **Client ID (Bundle ID)**：填 `com.smartmatch.mobile`
8. 點「Save」。

### 步驟 6：完成，通知工程端
設定完成後，請告知已完成，不需要再把任何金鑰內容傳給任何人（包含 Claude／AI 助理）——這些金鑰只需要留在 Supabase 後台和你自己保存的備份裡。

---

## 做完之後會發生什麼事

App 端的程式碼會另外處理（不需要你動手）。等你完成上面的設定後，會需要重新打包一個新版本的 App 給實體 iPhone 安裝測試（因為「使用 Apple 登入」需要手機上有登入真實的 Apple ID 才能測試，模擬器通常不行），工程端會另外通知你什麼時候可以測試。
