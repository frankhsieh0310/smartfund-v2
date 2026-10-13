import Link from "next/link";

export const metadata = {
  title: "服務條款｜SmartMatch",
  description: "SmartMatch 服務條款草稿",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-[22px] font-bold text-white">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-slate-300">{children}</div>
    </section>
  );
}

export default function TermsOfServicePage() {
  return (
    <main className="min-h-screen bg-[#020817] px-6 py-16">
      <div className="mx-auto max-w-[840px]">
        <div className="rounded-lg border border-[#F5B700]/40 bg-[#F5B700]/10 px-5 py-3 text-[14px] font-semibold text-[#F5B700]">
          草稿，待法律審閱 — 本頁內容尚未經法務確認，上架前請勿視為最終版本。
        </div>

        <h1 className="mt-8 text-[32px] font-black text-white">服務條款</h1>
        <p className="mt-2 text-[14px] text-slate-500">版本：v0.1 草案｜最後更新：2026-10-13</p>

        <Section title="一、服務說明">
          <p>
            SmartMatch 由瑞宇智庫有限公司（下稱「我們」）提供，是一個投資條件管理與市場資料分析平台。
            <strong className="text-white"> 本服務不提供任何投資建議，所有資料、分析結果與討論區內容僅供參考，不構成買賣任何金融商品之建議或邀約。</strong>
            你應自行判斷並承擔投資決策的風險。
          </p>
        </Section>

        <Section title="二、付費訂閱方案">
          <ul className="list-disc space-y-2 pl-5">
            <li>部分功能（包括付費會員討論區、股票與 ETF 的配息提醒）需透過 App 內付費訂閱方可使用。</li>
            <li>訂閱透過 Apple App Store 或 Google Play 的應用程式內購買機制處理，<strong className="text-white">採自動續訂制</strong>：除非你在目前訂閱週期結束前取消，訂閱將自動按原定週期與價格續訂。</li>
            <li>
              取消訂閱、退款與試用規則，依 Apple 與 Google 各自的政策為準：iOS 用戶請至「設定 → [你的帳號] → 訂閱」管理；Android 用戶請至 Google Play 應用程式的「訂閱項目」管理。我們無法代為處理 Apple／Google 的退款申請。
            </li>
            <li>訂閱到期或取消後，你先前建立的討論區文章與回覆會保留，但你將無法再閱讀討論區內容，也無法繼續發言，直到重新訂閱為止。</li>
          </ul>
        </Section>

        <Section title="三、討論區規範摘要">
          <p>完整規範以 App 內公告的最新版本為準，使用討論區前你需先閱讀並同意該版本的規範。摘要如下：</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>僅付費會員可瀏覽與發言，需設定討論區暱稱。</li>
            <li>不提供任何使用者間的私訊、私人聊天室、加好友或追蹤功能；所有發言僅存在於公開頻道。</li>
            <li>禁止招攬、導流聯絡方式（電話、Email、通訊軟體帳號、外部連結等）、個股買賣建議與不雅字詞；違規發文將被系統或管理員攔截或移除。</li>
            <li>內容經他人檢舉達一定人數將自動隱藏，由管理員後續覆核處理。</li>
            <li><strong className="text-white">本區為用戶交流，不構成投資建議。</strong></li>
          </ul>
        </Section>

        <Section title="四、帳號刪除">
          <p>
            你可以在 App 內刪除帳號。刪除帳號後，我們會停用你的登入身分；你在討論區發表的文章與回覆內容將被清空並標示為已刪除，其他使用者引用你內容的地方會顯示「此內容已刪除」。
            部分不含個人資料的系統紀錄（例如管理員處理違規的動作紀錄）不會因帳號刪除而移除。
          </p>
        </Section>

        <Section title="五、服務變更與終止">
          <p>我們可能因維運、法規或營運考量調整或終止部分功能，重大變更將於 App 內或本網站公告。</p>
        </Section>

        <Section title="六、聯絡我們">
          <address className="not-italic">
            瑞宇智庫有限公司 Ruiyu Think Tank Co., Ltd.<br />
            統一編號：93639659<br />
            地址：新北市三重區重新路2段21號11樓<br />
            Email：<a href="mailto:contact@smartmatch.tw" className="underline underline-offset-4 hover:text-white">contact@smartmatch.tw</a>
          </address>
        </Section>

        <div className="mt-14">
          <Link href="/" className="text-[14px] text-slate-500 underline underline-offset-4 hover:text-slate-300">
            回首頁
          </Link>
        </div>
      </div>
    </main>
  );
}
