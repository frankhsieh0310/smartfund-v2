import type { Metadata } from "next";
import { Ext, H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "SmartMatch App 隱私權政策｜瑞宇智庫有限公司",
  description: "「SmartMatch」App 的隱私權政策：處理哪些資料、存放在哪裡、如何刪除。",
};

// 2026-10-17：內容依 smartmatch-mobile 目前實際程式行為撰寫——帳號／提醒／推播／訂閱走伺服器
// （src/auth、src/alerts/service.ts、src/push/service.ts、src/payments/revenuecat.ts），自選清單、
// 投資組合、現金流記帳、比較草稿只存在裝置本機（src/storage/deviceStorage.ts，iOS/Android 用
// expo-secure-store，網頁版用 localStorage，見 src/watchlist/service.ts 等註解）。程式行為改變時
// （例如提醒/推播功能從目前的 FEATURES.alerts=false 正式開放）要同步更新本頁。
const cell = "border border-white/10 px-3 py-2 align-top";

export default function SmartMatchAppPrivacyPage() {
  return (
    <article>
      <H1>「SmartMatch」App 隱私權政策</H1>
      <p className="text-[14px] text-slate-400">最後更新：2026 年 10 月 17 日</p>
      <P>瑞宇智庫有限公司（RUI YU THINK TANK LIMITED，統一編號 93639659，地址：新北市三重區重新路2段21號11樓，下稱「我們」）提供「SmartMatch」App（下稱「本 App」）。本 App 與我們的網站 smartmatchpilot.com 共用同一套會員帳號與後端服務。本政策說明本 App 會處理哪些資料、存放在哪裡，以及您可以怎麼刪除。</P>

      <H2>一、帳號與登入</H2>
      <P>部分功能（例如提醒通知、訂閱）需要登入。登入只能使用 Google 或 Apple 帳戶，透過 Supabase 驗證服務完成，我們不會自己儲存您的密碼。登入後我們的資料庫會保存：您的 Email、顯示名稱（若 Google／Apple 有提供）、Supabase 帳號識別碼。同一個會員帳號可同時在本 App 與網站上使用。</P>

      <H2>二、只存在您裝置上的資料</H2>
      <P>以下資料只存在本 App 在您裝置本機的儲存空間（手機用系統安全儲存區，網頁版用瀏覽器 localStorage），不會傳到我們的伺服器，登入或登出其他帳號也不會同步：</P>
      <UL>
        <li>自選清單與分組</li>
        <li>投資組合（持股穿透）設定</li>
        <li>現金流記帳紀錄</li>
        <li>基金／ETF 比較草稿</li>
      </UL>
      <P>刪除本 App 或清除瀏覽器資料時，以上資料會一併清除；<strong>刪除伺服器端的會員帳號不會自動清除這些本機資料</strong>，詳見第六點。</P>

      <H2>三、會傳到我們伺服器的資料</H2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[14px] leading-6">
          <thead className="bg-white/5 text-white">
            <tr><th className={cell}>資料</th><th className={cell}>什麼時候傳</th><th className={cell}>用途</th></tr>
          </thead>
          <tbody>
            <tr><td className={cell}>登入身份資訊（Email、顯示名稱、Supabase 帳號識別碼）</td><td className={cell}>登入時</td><td className={cell}>識別會員身份，讓同一帳號在 App 與網站間同步</td></tr>
            <tr><td className={cell}>提醒規則（您設定的資產代號、觸發條件、門檻）</td><td className={cell}>建立或修改提醒時</td><td className={cell}>條件成立時發送通知給您</td></tr>
            <tr><td className={cell}>推播裝置代碼、裝置時區、通知設定</td><td className={cell}><strong>只有在您開啟通知時</strong></td><td className={cell}>發送您設定的提醒通知</td></tr>
            <tr><td className={cell}>訂閱狀態（透過 RevenueCat 同步的方案與到期時間）</td><td className={cell}>完成訂閱或訂閱狀態變動時</td><td className={cell}>確認您的會員方案，開放對應功能</td></tr>
            <tr><td className={cell}>查詢的股票、ETF、基金代號或搜尋文字</td><td className={cell}>搜尋或打開頁面時</td><td className={cell}>回傳查詢結果，只用於當次查詢</td></tr>
            <tr><td className={cell}>連線資訊（IP 位址、時間、請求的網址）</td><td className={cell}>每次連線</td><td className={cell}>維護服務、防止濫用（由主機服務的系統紀錄保存）</td></tr>
          </tbody>
        </table>
      </div>
      <P>伺服器資料存放在雲端主機與雲端資料庫，可能位於臺灣以外的地區。我們不會把您的資料用於廣告，也不會出售或出租任何資料。</P>

      <H2>四、市場資料來源</H2>
      <P>本 App 顯示的股票、ETF、基金等市場資料整理自以下公開或商業資料來源，並依各來源的公開/授權方式使用：臺灣證券交易所（TWSE）、證券櫃檯買賣中心（TPEx）、臺灣集中保管結算所（TDCC）、中華民國投信投顧公會（SITCA）、公開資訊觀測站、Yahoo Finance、MoneyDJ 理財網。資料可能延遲、不完整或有誤，實際數字請以各來源官方公告為準。</P>

      <H2>五、第三方服務</H2>
      <UL>
        <li><strong>Supabase</strong>（Supabase, Inc.）：處理登入驗證與會員資料庫。（<Ext href="https://supabase.com/privacy">隱私權政策</Ext>）</li>
        <li><strong>Google、Apple</strong>：處理登入授權。（<Ext href="https://policies.google.com/privacy">Google 隱私權政策</Ext>、<Ext href="https://www.apple.com/legal/privacy/">Apple 隱私權政策</Ext>）</li>
        <li><strong>Apple App Store、Google Play</strong>：處理訂閱付款。我們拿不到您的信用卡號或付款資訊。</li>
        <li><strong>RevenueCat</strong>（RevenueCat, Inc.）：管理訂閱狀態，處理匿名使用者代碼、購買與訂閱紀錄、裝置與 App 版本。（<Ext href="https://www.revenuecat.com/privacy">隱私權政策</Ext>）</li>
        <li><strong>Expo 推播服務</strong>（650 Industries, Inc.）：把通知轉送到 Apple 或 Google 的推播服務，處理推播代碼與通知內容。只有在您開啟通知時使用。（<Ext href="https://expo.dev/privacy">隱私權政策</Ext>）</li>
        <li><strong>Vercel</strong>（Vercel Inc.）：執行我們的伺服器，處理連線資訊。（<Ext href="https://vercel.com/legal/privacy-policy">隱私權政策</Ext>）</li>
      </UL>

      <H2>六、您的權利</H2>
      <P>依《個人資料保護法》，您可以查詢、閱覽、取得複本、補充或更正，也可以要求停止蒐集、處理、利用或要求刪除。</P>
      <UL>
        <li><strong>刪除會員帳號：</strong>在本 App「登入 / 會員」頁按「刪除帳號」。這會刪除您的登入身份與資料庫中的會員資料（包含提醒規則、推播裝置、訂閱對應紀錄），無法復原。<strong>自選清單、投資組合、現金流記帳、比較草稿是存在裝置本機的資料，刪除會員帳號不會清除它們</strong>，需要另外在 App 內清除或刪除 / 重新安裝 App。</li>
        <li><strong>關閉通知：</strong>在本 App 的通知設定關閉，或在裝置系統設定關閉本 App 的通知。</li>
        <li><strong>取消訂閱：</strong>iPhone 在「設定 › Apple ID › 訂閱」；Android 在 Google Play「付款與訂閱 › 訂閱」。</li>
        <li>其他查詢、更正或刪除需求請來信 <Mail />。</li>
      </UL>

      <H2>七、追蹤與廣告</H2>
      <P>本 App 沒有廣告，不會跨 App 或跨網站追蹤您，也不會把資料提供給資料仲介。</P>

      <H2>八、兒童</H2>
      <P>本 App 不是為兒童設計，我們不會刻意蒐集兒童的資料。</P>

      <H2>九、資料安全</H2>
      <P>本 App 與伺服器之間的連線都使用 HTTPS 加密，伺服器只接受格式正確的資料。</P>

      <H2>十、政策更新</H2>
      <P>本政策更新時，會公布在本頁並更新日期；重大變更會在 App 內通知您。</P>

      <H2>十一、聯絡我們</H2>
      <P>瑞宇智庫有限公司　<Mail /></P>
    </article>
  );
}
