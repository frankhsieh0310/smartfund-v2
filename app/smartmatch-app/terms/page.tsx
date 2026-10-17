import type { Metadata } from "next";
import { H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "SmartMatch App 使用條款｜瑞宇智庫有限公司",
  description: "「SmartMatch」App 的使用條款：服務性質、訂閱、使用規範與責任限制。",
};

// 2026-10-17：訂閱方案名稱與價格在撰寫本頁時尚未在 RevenueCat／商店後台最終設定，條款故意不寫死
// 具體金額（避免跟商店頁面顯示的實際金額不一致），改成「依商店頁面顯示為準」。等方案確定後可以
// 補上具體數字，寫法可參考 app/twpuzzle/terms/page.tsx 的第三節。
export default function SmartMatchAppTermsPage() {
  return (
    <article>
      <H1>「SmartMatch」使用條款</H1>
      <p className="text-[14px] text-slate-400">最後更新：2026 年 10 月 17 日</p>

      <H2>一、服務提供者</H2>
      <P>「SmartMatch」App（下稱「本 App」）由瑞宇智庫有限公司（RUI YU THINK TANK LIMITED，統一編號 93639659，下稱「我們」）提供，與我們的網站 smartmatchpilot.com 共用同一套會員帳號與後端服務。使用本 App 即表示您同意本條款。</P>

      <H2>二、服務內容與性質</H2>
      <UL>
        <li>本 App 整理臺灣證券交易所、證券櫃檯買賣中心、臺灣集中保管結算所、中華民國投信投顧公會等公開資料，以及 Yahoo Finance、MoneyDJ 理財網等資料來源，提供股票／ETF／基金的反查、比較、投資組合穿透、排行、技術指標、配息資訊等功能。</li>
        <li><strong>本 App 僅提供資訊整理與試算，不構成任何投資建議、要約或招攬。</strong>本 App 不提供下單、帳戶連結或代為操作。</li>
        <li>資料可能延遲、不完整或有誤，請以各資料來源的官方公告為準；試算結果依歷史或目前公開資料計算，不代表未來表現。</li>
        <li>部分分析內容（例如法人觀點彙整）由程式依規則整理或由 AI 輔助產生，僅供參考，請自行判斷並以原始公開資訊為準。</li>
      </UL>

      <H2>三、會員帳號與訂閱</H2>
      <UL>
        <li><strong>帳號：</strong>部分功能需要使用 Google 或 Apple 帳戶登入，與我們網站共用同一會員身份。</li>
        <li><strong>訂閱方案：</strong>本 App 可能提供付費訂閱方案，解鎖進階功能。方案名稱、週期與價格以您在 App Store 或 Google Play 購買頁面上實際看到的內容為準。</li>
        <li><strong>自動續訂與扣款：</strong>訂閱為自動續訂，確認購買時由您的 Apple ID 或 Google 帳戶扣款；除非在本期結束前依商店規定取消，訂閱會自動續訂並扣下一期費用。</li>
        <li><strong>取消：</strong>iPhone 在「設定 › Apple ID › 訂閱」，Android 在 Google Play「付款與訂閱 › 訂閱」取消；取消後到本期結束前仍可使用已購買的功能。</li>
        <li><strong>退款：</strong>依 Apple 或 Google 的規定辦理，我們無法直接代為退款。</li>
        <li><strong>調整：</strong>方案內容或價格調整時，會依商店規定事先通知。</li>
      </UL>

      <H2>四、使用規範</H2>
      <P>您不得從事以下行為：</P>
      <UL>
        <li>以程式大量擷取本 App 或其伺服器的資料</li>
        <li>規避訂閱限制或存取未授權的功能</li>
        <li>反向工程或干擾服務運作</li>
        <li>將資料轉售或以商業目的重新散布</li>
      </UL>

      <H2>五、責任限制</H2>
      <P>在法律允許的範圍內，因使用或無法使用本 App、或資料延遲、錯誤所生的任何損失，包括投資損失，我們不負賠償責任。</P>

      <H2>六、智慧財產與資料授權</H2>
      <UL>
        <li>臺灣證券交易所、證券櫃檯買賣中心、臺灣集中保管結算所等政府機關及機構的開放資料，依其公告的開放資料授權條款使用。</li>
        <li>各投信、基金公司、Yahoo Finance、MoneyDJ 理財網等公布的資料，以其公布的內容為準，相關權利屬於原權利人。</li>
        <li>本 App 的介面、程式與文字屬於瑞宇智庫有限公司。</li>
      </UL>

      <H2>七、服務變更與中止</H2>
      <P>我們可以調整、暫停或終止部分功能；若影響付費內容，會事先在 App 內公告。</P>

      <H2>八、條款修改</H2>
      <P>條款修改後會公布在本頁並更新日期；修改後繼續使用本 App，視為同意修改後的條款。</P>

      <H2>九、準據法</H2>
      <P>本條款以中華民國法律為準據法。</P>

      <H2>十、聯絡方式</H2>
      <P><Mail /></P>
    </article>
  );
}
