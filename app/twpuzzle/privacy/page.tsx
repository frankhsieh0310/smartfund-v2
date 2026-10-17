import type { Metadata } from "next";
import { Ext, H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "台股拼圖 隱私權政策｜瑞宇智庫有限公司",
  description: "「台股拼圖」App 的隱私權政策：處理哪些資料、存放在哪裡、如何刪除。",
};

// 2026-10-16：內容依「台股拼圖」1.0.0 的實際程式行為撰寫（tw-etf-lookup release-1 app/docs/legal/privacy-policy-draft.md）。程式行為改變時要同步更新。
const cell = "border border-white/10 px-3 py-2 align-top";

export default function TwPuzzlePrivacyPage() {
  return (
    <article>
      <H1>「台股拼圖」隱私權政策</H1>
      <p className="text-[14px] text-slate-400">最後更新：2026 年 10 月 16 日</p>
      <P>瑞宇智庫有限公司（RUI YU THINK TANK LIMITED，統一編號 93639659，地址：新北市三重區重新路2段21號11樓，下稱「我們」）提供「台股拼圖」App（下稱「本 App」）。本政策說明本 App 會處理哪些資料、存放在哪裡，以及您可以怎麼刪除。</P>

      <H2>一、不需要帳號</H2>
      <P>本 App 不需要註冊或登入，也不會要求您提供姓名、電話、電子郵件或身分證字號。</P>

      <H2>二、只存在您手機上的資料</H2>
      <P>以下資料只存在本 App 在您手機上的儲存空間，不會傳到我們的伺服器：</P>
      <UL>
        <li>自選清單與分組</li>
        <li>持股穿透輸入的 ETF 與單位數</li>
        <li>持股記帳的每筆紀錄，以及 CSV 匯入的內容（CSV 只在手機上解析）</li>
        <li>試算設定，例如所得稅級距、每月目標金額</li>
        <li>通知設定與價格提醒規則（開啟通知時，另外送到伺服器的部分見第三點）</li>
      </UL>
      <P>刪除本 App 時，以上資料會一併清除。</P>

      <H2>三、會傳到我們伺服器的資料</H2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[14px] leading-6">
          <thead className="bg-white/5 text-white">
            <tr><th className={cell}>資料</th><th className={cell}>什麼時候傳</th><th className={cell}>用途</th></tr>
          </thead>
          <tbody>
            <tr><td className={cell}>本 App 自己產生的隨機裝置代碼（不是廣告識別碼，也不是硬體序號）</td><td className={cell}>查詢資料、使用試看、開啟通知時</td><td className={cell}>防止濫用、計算每日免費試看次數、辨識要寄送通知的裝置</td></tr>
            <tr><td className={cell}>推播代碼、平台（iOS／Android）、通知設定、要通知的自選代碼與持股 ETF 代碼</td><td className={cell}><strong>只有在您開啟通知時</strong></td><td className={cell}>寄送配息提醒、新 ETF 上市通知等您開啟的通知</td></tr>
            <tr><td className={cell}>價格提醒規則（股票代號、條件、門檻）</td><td className={cell}><strong>只有在您設定價格提醒並開啟通知時</strong></td><td className={cell}>收盤價達到條件時通知您</td></tr>
            <tr><td className={cell}>訂閱用的匿名使用者代碼</td><td className={cell}>開啟通知時</td><td className={cell}>確認 Pro 訂閱狀態（Pro 功能的通知只寄給 Pro 用戶）</td></tr>
            <tr><td className={cell}>已寄送通知的紀錄（通知代號、寄送時間、結果）</td><td className={cell}>寄送通知時</td><td className={cell}>避免同一則通知重複寄送</td></tr>
            <tr><td className={cell}>查詢的股票或 ETF 代號、搜尋文字</td><td className={cell}>搜尋或打開頁面時</td><td className={cell}>回傳查詢結果，只用於當次查詢</td></tr>
            <tr><td className={cell}>連線資訊（IP 位址、時間、請求的網址）</td><td className={cell}>每次連線</td><td className={cell}>維護服務、防止濫用（由主機服務的系統紀錄保存）</td></tr>
          </tbody>
        </table>
      </div>
      <P>伺服器資料存放在雲端主機與雲端資料庫，可能位於臺灣以外的地區（例如新加坡）。我們不會把您的資料用於廣告，也不會出售或出租任何資料。</P>
      <P>保存期限：關閉通知後，我們會停止寄送並停用該裝置的推播資料；您可以隨時依第六點要求刪除伺服器上與您裝置相關的資料。</P>

      <H2>四、第三方服務</H2>
      <UL>
        <li><strong>Apple App Store、Google Play</strong>：處理付款與訂閱。我們拿不到您的信用卡號或付款資訊。（<Ext href="https://www.apple.com/legal/privacy/">Apple 隱私權政策</Ext>、<Ext href="https://policies.google.com/privacy">Google 隱私權政策</Ext>）</li>
        <li><strong>RevenueCat</strong>（RevenueCat, Inc.）：管理訂閱狀態，處理匿名使用者代碼、購買與訂閱紀錄、裝置與 App 版本。（<Ext href="https://www.revenuecat.com/privacy">隱私權政策</Ext>）</li>
        <li><strong>Expo 推播服務</strong>（650 Industries, Inc.）：把通知轉送到 Apple 或 Google 的推播服務，處理推播代碼與通知內容。只有在您開啟通知時使用。（<Ext href="https://expo.dev/privacy">隱私權政策</Ext>）</li>
        <li><strong>Vercel</strong>（Vercel Inc.）：執行我們的伺服器，處理連線資訊。（<Ext href="https://vercel.com/legal/privacy-policy">隱私權政策</Ext>）</li>
      </UL>
      <P>若日後啟用當機回報服務，會在本頁更新並說明處理的資料。</P>

      <H2>五、追蹤與廣告</H2>
      <P>本 App 沒有廣告，不會跨 App 或跨網站追蹤您，也不會把資料提供給資料仲介。</P>

      <H2>六、您的權利</H2>
      <P>依《個人資料保護法》，您可以查詢、閱覽、取得複本、補充或更正，也可以要求停止蒐集、處理、利用或要求刪除。</P>
      <UL>
        <li><strong>關閉通知：</strong>在本 App「通知設定」關閉，或在手機的系統設定關閉本 App 的通知。</li>
        <li><strong>刪除伺服器上的資料：</strong>來信 <Mail />，並附上本 App「通知設定」頁下方顯示的裝置代碼。我們刪除後會回信告知。</li>
        <li><strong>取消訂閱：</strong>iPhone 在「設定 › Apple ID › 訂閱」；Android 在 Google Play「付款與訂閱 › 訂閱」。</li>
      </UL>

      <H2>七、兒童</H2>
      <P>本 App 不是為兒童設計，我們不會刻意蒐集兒童的資料。</P>

      <H2>八、資料安全</H2>
      <P>本 App 與伺服器之間的連線都使用 HTTPS 加密，伺服器只接受格式正確的資料。</P>

      <H2>九、政策更新</H2>
      <P>本政策更新時，會公布在本頁並更新日期；重大變更會在 App 內通知您。</P>

      <H2>十、聯絡我們</H2>
      <P>瑞宇智庫有限公司　<Mail /></P>
    </article>
  );
}
