import type { Metadata } from "next";
import { H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "台股拼圖 使用條款｜瑞宇智庫有限公司",
  description: "「台股拼圖」App 的使用條款：服務性質、Pro 訂閱、使用規範與責任限制。",
};

// 2026-10-16：內容依 tw-etf-lookup release-1 app/docs/legal/terms-of-use-draft.md，價格與試用依 src/billing/plans.json。
export default function TwPuzzleTermsPage() {
  return (
    <article>
      <H1>「台股拼圖」使用條款</H1>
      <p className="text-[14px] text-slate-400">最後更新：2026 年 10 月 16 日</p>

      <H2>一、服務提供者</H2>
      <P>「台股拼圖」App（下稱「本 App」）由瑞宇智庫有限公司（RUI YU THINK TANK LIMITED，統一編號 93639659，下稱「我們」）提供。使用本 App 即表示您同意本條款。</P>

      <H2>二、服務內容與性質</H2>
      <UL>
        <li>本 App 整理各投信公布的 ETF 持股、臺灣證券交易所與證券櫃檯買賣中心的開放資料、公開資訊觀測站的公告、集保結算所的開放資料等公開資訊，並依公開的計算方式算出數字，例如年度現金殖利率、填息天數。</li>
        <li><strong>本 App 僅提供資訊，不構成任何投資建議、要約或招攬。</strong>本 App 不提供下單、帳戶連結或代為操作。持股異動是比較投信前後兩次公布的持股，不是實際成交紀錄。</li>
        <li>資料可能延遲、不完整或有誤，請以官方公告為準。實際配息以發行公司公告為準；試算結果依歷史資料計算，不代表未來表現。</li>
        <li>公司公告與法說會的摘要由程式依規則整理，請以公開資訊觀測站的原文為準。</li>
      </UL>

      <H2>三、Pro 訂閱</H2>
      <UL>
        <li><strong>價格與試用：</strong>Pro 為自動續訂訂閱，月費 NT$129／月、年費 NT$1,190／年。新用戶可免費試用 7 天，每個商店帳號限一次。</li>
        <li><strong>扣款：</strong>確認購買時，由您的 Apple ID 或 Google 帳戶扣款。</li>
        <li><strong>自動續訂：</strong>除非在本期結束前至少 24 小時關閉自動續訂，訂閱會自動續訂，並在本期結束前 24 小時內收取下一期費用。</li>
        <li><strong>取消：</strong>iPhone 在「設定 › Apple ID › 訂閱」，Android 在 Google Play「付款與訂閱 › 訂閱」取消；取消後到本期結束前仍可使用 Pro。試用期間購買訂閱時，未使用的試用期會失效。</li>
        <li><strong>恢復購買：</strong>換手機或重新安裝後，可在本 App 的「升級 Pro」頁或「我的 › 會員方案」按「恢復購買」。</li>
        <li><strong>退款：</strong>依 Apple 或 Google 的規定辦理。</li>
        <li><strong>調整：</strong>價格或 Pro 內容調整時，會依商店規定事先通知。</li>
      </UL>

      <H2>四、使用規範</H2>
      <P>您不得從事以下行為：</P>
      <UL>
        <li>以程式大量擷取本 App 或其伺服器的資料</li>
        <li>規避頻率限制、試看次數或付費限制</li>
        <li>反向工程或干擾服務運作</li>
        <li>將資料轉售或以商業目的重新散布</li>
      </UL>

      <H2>五、責任限制</H2>
      <P>在法律允許的範圍內，因使用或無法使用本 App、或資料延遲、錯誤所生的任何損失，包括投資損失，我們不負賠償責任。</P>

      <H2>六、智慧財產與資料授權</H2>
      <UL>
        <li>臺灣證券交易所、證券櫃檯買賣中心等政府機關及機構的開放資料，依「政府資料開放授權條款－第 1 版」使用。</li>
        <li>各投信、基金公司公布的資料，以其公布的內容為準，相關權利屬於原權利人。</li>
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
