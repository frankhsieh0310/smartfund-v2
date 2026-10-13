import Link from "next/link";

export const metadata = {
  title: "隱私權政策｜SmartMatch",
  description: "SmartMatch 隱私權政策草稿",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-[22px] font-bold text-white">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-slate-300">{children}</div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[#020817] px-6 py-16">
      <div className="mx-auto max-w-[840px]">
        <div className="rounded-lg border border-[#F5B700]/40 bg-[#F5B700]/10 px-5 py-3 text-[14px] font-semibold text-[#F5B700]">
          草稿，待法律審閱 — 本頁內容尚未經法務確認，上架前請勿視為最終版本。
        </div>

        <h1 className="mt-8 text-[32px] font-black text-white">隱私權政策</h1>
        <p className="mt-2 text-[14px] text-slate-500">版本：v0.1 草案｜最後更新：2026-10-13</p>

        <Section title="一、適用範圍">
          <p>
            本政策說明 SmartMatch（網站 smartfund-v2.vercel.app 及 iOS／Android App「SmartMatch」，由瑞宇智庫有限公司提供）如何收集、使用、保存與保護使用者的個人資料。使用本服務即表示你已閱讀並同意本政策。
          </p>
        </Section>

        <Section title="二、我們收集的資料">
          <p><strong className="text-white">1. 帳號資料</strong>：透過 Supabase Auth 進行登入驗證時，我們會取得你的 Email、顯示名稱與（若你使用 Apple 登入）大頭照網址。</p>
          <p><strong className="text-white">2. 你自行輸入的投資資料</strong>：投資人問卷結果、自訂篩選條件、你手動建立的「資產組合」（名稱、幣別、自行輸入的持股／交易／現金紀錄）、觀察清單、比較紀錄、策略與收藏。這些資料由你自行輸入，並非連結真實券商帳戶取得。</p>
          <p><strong className="text-white">3. 使用紀錄</strong>：站內搜尋關鍵字與搜尋結果數量、App 內通知的已讀狀態、系統操作紀錄（AuditLog）。</p>
          <p><strong className="text-white">4. 推播與通知</strong>：若你開啟 App 推播，我們會儲存 Expo 推播權杖（device push token）與你設定的通知時段、頻率上限。</p>
          <p><strong className="text-white">5. 付費會員與訂閱狀態</strong>：若你訂閱付費方案，我們透過 RevenueCat 取得你的訂閱是否生效與到期時間；<strong className="text-white">我們不會接觸或儲存你的信用卡卡號等付款資訊</strong>，付款由 Apple App Store／Google Play 直接處理。</p>
          <p><strong className="text-white">6. 討論區資料（規劃中功能）</strong>：若你加入付費會員討論區，我們會儲存你設定的討論區暱稱、發文與回覆內容、檢舉紀錄；若發文被自動過濾系統擋下，系統會保留該次被擋下的原始內容，僅供調整過濾規則使用，不會公開顯示。</p>
        </Section>

        <Section title="三、資料用途">
          <ul className="list-disc space-y-2 pl-5">
            <li>提供登入驗證、帳號管理與你所使用的各項功能（投資條件比對、觀察清單提醒、討論區等）。</li>
            <li>推播通知與 App 內通知的發送。</li>
            <li>驗證付費會員身分，決定你可使用的功能範圍。</li>
            <li>維運與除錯（系統操作紀錄）、防止濫用（討論區過濾與檢舉機制）。</li>
          </ul>
          <p>我們<strong className="text-white">不會將你的個人資料用於與上述用途無關的目的</strong>，也不會對外販售你的個人資料。</p>
        </Section>

        <Section title="四、第三方服務">
          <p>我們使用以下第三方服務處理你的資料，各自依其自身的隱私權政策處理資料：</p>
          <ul className="list-disc space-y-2 pl-5">
            <li><strong className="text-white">Supabase</strong>：帳號登入驗證與資料庫主機服務。</li>
            <li><strong className="text-white">Vercel</strong>：網站與後端 API 的伺服器主機服務。</li>
            <li><strong className="text-white">RevenueCat</strong>：訂閱狀態管理，橋接 Apple／Google 的付款結果。</li>
            <li><strong className="text-white">Expo</strong>：App 推播通知的發送服務。</li>
            <li><strong className="text-white">Apple App Store／Google Play</strong>：App 內購買的付款處理，實際付款資訊由 Apple／Google 保管，不經過我們的伺服器。</li>
          </ul>
        </Section>

        <Section title="五、資料保存期限">
          <p>
            帳號資料與你自行輸入的投資資料，於帳號存續期間保留；你可依本政策第七節申請刪除帳號。討論區發文與回覆，於帳號刪除後會清空內容但保留紀錄列（原因詳見服務條款「討論區規範」一節）。討論區被過濾系統擋下的原始內容，保存期限<strong className="text-white">尚未確定（草案提案 90 天後清除，待確認）</strong>。
          </p>
        </Section>

        <Section title="六、你的權利">
          <p>你可以透過 contact@smartmatch.tw 聯絡我們，要求查詢、更正或刪除你的個人資料；App 內也提供帳號刪除功能（見服務條款）。</p>
        </Section>

        <Section title="七、聯絡我們">
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
