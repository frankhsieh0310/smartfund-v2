"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type PersonalityKey = "conservative" | "balanced" | "growth" | "aggressive";

type EtfItem = {
  code: string;
  name: string;
  desc: string;
};

type FundItem = {
  category: string;
  desc: string;
};

type ReportData = {
  title: string;
  stars: number;
  riskLabel: string;
  summary: string;
  allocation: { label: string; value: number; color: string }[];
  etfs: EtfItem[];
  funds: FundItem[];
};

const REPORTS: Record<PersonalityKey, ReportData> = {
  conservative: {
    title: "保守型",
    stars: 2,
    riskLabel: "風險承受度：中低",
    summary: "你重視資產的安全與穩定，對虧損的容忍度較低，適合以保本與穩定收益為主的投資組合。",
    allocation: [
      { label: "債券", value: 60, color: "#64748b" },
      { label: "現金", value: 25, color: "#334155" },
      { label: "股票", value: 15, color: "#F5B700" },
    ],
    etfs: [
      { code: "BND", name: "Vanguard Total Bond Market ETF", desc: "美國綜合債券市場，分散信用與利率風險" },
      { code: "AGG", name: "iShares Core U.S. Aggregate Bond ETF", desc: "追蹤美國投資級債券指數，流動性高" },
      { code: "00679B", name: "元大美債20年", desc: "台股掛牌美國長天期公債ETF，免換匯" },
    ],
    funds: [
      { category: "投資等級債券型基金", desc: "聚焦已開發市場政府與投資級公司債，波動度較低" },
      { category: "貨幣市場基金", desc: "短期票券與存款工具為主，流動性與穩定性優先" },
    ],
  },
  balanced: {
    title: "穩健型",
    stars: 3,
    riskLabel: "風險承受度：中等",
    summary: "你希望在風險與報酬之間取得平衡，能接受一定程度的波動，適合股債均衡配置的投資組合。",
    allocation: [
      { label: "股票", value: 45, color: "#F5B700" },
      { label: "債券", value: 40, color: "#64748b" },
      { label: "現金", value: 15, color: "#334155" },
    ],
    etfs: [
      { code: "VTI", name: "Vanguard Total Stock Market ETF", desc: "涵蓋美國全市場股票，分散個股風險" },
      { code: "VT", name: "Vanguard Total World Stock ETF", desc: "全球股市曝險，含已開發與新興市場" },
      { code: "0050", name: "元大台灣50", desc: "追蹤台灣市值前50大企業，台股核心配置" },
    ],
    funds: [
      { category: "平衡型基金", desc: "股債混合配置，依市場狀況動態調整比重" },
      { category: "全球股票型基金", desc: "跨區域、跨產業分散，降低單一市場集中風險" },
    ],
  },
  growth: {
    title: "成長型",
    stars: 4,
    riskLabel: "風險承受度：中高",
    summary: "你願意承擔較高波動以追求資產成長，投資期間較長，適合以股票為主、債券為輔的配置。",
    allocation: [
      { label: "股票", value: 70, color: "#F5B700" },
      { label: "債券", value: 22, color: "#64748b" },
      { label: "現金", value: 8, color: "#334155" },
    ],
    etfs: [
      { code: "QQQ", name: "Invesco QQQ Trust", desc: "追蹤那斯達克100指數，科技成長股集中" },
      { code: "VUG", name: "Vanguard Growth ETF", desc: "美國大型成長股，著重獲利成長動能" },
      { code: "00878", name: "國泰永續高股息", desc: "結合ESG篩選與高股息策略的台股ETF" },
    ],
    funds: [
      { category: "科技產業型基金", desc: "聚焦科技與創新產業，成長動能較強但波動較大" },
      { category: "新興市場股票型基金", desc: "佈局高成長潛力市場，承擔較高政經與匯率風險" },
    ],
  },
  aggressive: {
    title: "積極型",
    stars: 5,
    riskLabel: "風險承受度：高",
    summary: "你能承受高度波動，追求長期最大化報酬，適合以股票為核心、搭配高成長資產的投資組合。",
    allocation: [
      { label: "股票", value: 85, color: "#F5B700" },
      { label: "債券", value: 10, color: "#64748b" },
      { label: "現金", value: 5, color: "#334155" },
    ],
    etfs: [
      { code: "SOXX", name: "iShares Semiconductor ETF", desc: "半導體產業集中曝險，波動較高" },
      { code: "QQQ", name: "Invesco QQQ Trust", desc: "那斯達克100指數，科技成長股核心部位" },
      { code: "SMH", name: "VanEck Semiconductor ETF", desc: "全球半導體龍頭企業，產業週期波動大" },
    ],
    funds: [
      { category: "產業主題型基金", desc: "集中佈局單一高成長產業，報酬與風險同步放大" },
      { category: "槓桿型/單一國家股票基金", desc: "高波動高彈性，適合能承受大幅回檔的投資人" },
    ],
  },
};

function isPersonalityKey(value: string | null): value is PersonalityKey {
  return (
    value === "conservative" ||
    value === "balanced" ||
    value === "growth" ||
    value === "aggressive"
  );
}

function StarRating({ stars }: { stars: number }) {
  return (
    <span className="text-[#F5B700] text-[24px] tracking-wider">
      {"★".repeat(stars)}
      <span className="text-slate-300">{"★".repeat(5 - stars)}</span>
    </span>
  );
}

function ReportContent() {
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type");
  const type: PersonalityKey = isPersonalityKey(typeParam) ? typeParam : "balanced";
  const data = REPORTS[type];

  return (
    <main className="min-h-screen bg-white px-6 py-24">
      <div className="max-w-[860px] mx-auto">

        <div className="text-center mb-12">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-6">
            SMARTMATCH
          </div>
          <div className="text-[18px] text-slate-500 mb-3">
            你的投資人格分析報告
          </div>
          <h1 className="text-[64px] font-black text-[#0B1220] leading-tight">
            {data.title}投資人
          </h1>
        </div>

        <p className="text-[20px] leading-[1.8] text-slate-600 text-center mb-10">
          {data.summary}
        </p>

        <div className="flex items-center justify-center gap-3 mb-14">
          <span className="text-[16px] text-slate-500">{data.riskLabel}</span>
          <StarRating stars={data.stars} />
        </div>

        {/* 建議資產配置 */}
        <div className="bg-[#0B1220] rounded-[24px] p-10 mb-10">
          <div className="text-white text-[22px] font-bold mb-6">
            建議資產配置
          </div>

          <div className="flex h-4 rounded-full overflow-hidden mb-6">
            {data.allocation.map((a) => (
              <div
                key={a.label}
                style={{ width: `${a.value}%`, backgroundColor: a.color }}
              />
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4">
            {data.allocation.map((a) => (
              <div key={a.label}>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="text-slate-300 text-[15px]">{a.label}</span>
                </div>
                <div className="text-white text-[28px] font-bold">
                  {a.value}%
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ETF 推薦 */}
        <div className="mb-12">
          <div className="text-[24px] font-bold text-[#0B1220] mb-6">
            ETF 推薦
          </div>

          <div className="flex flex-col gap-4">
            {data.etfs.map((etf) => (
              <div
                key={etf.code}
                className="border border-slate-200 rounded-xl p-6"
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-[22px] font-bold text-[#0B1220]">
                    {etf.code}
                  </span>
                  <span className="text-[15px] text-slate-500">
                    {etf.name}
                  </span>
                </div>
                <div className="text-[15px] text-slate-500 mt-1">
                  {etf.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 基金推薦 */}
        <div className="mb-12">
          <div className="text-[24px] font-bold text-[#0B1220] mb-6">
            基金推薦
          </div>

          <div className="flex flex-col gap-4">
            {data.funds.map((fund) => (
              <div
                key={fund.category}
                className="border border-slate-200 rounded-xl p-6"
              >
                <div className="text-[18px] font-bold text-[#0B1220]">
                  {fund.category}
                </div>
                <div className="text-[15px] text-slate-500 mt-1">
                  {fund.desc}
                </div>
              </div>
            ))}
          </div>

          <p className="text-[13px] text-slate-400 mt-4 leading-relaxed">
            以上為基金類型範例，實際商品請洽詢理財顧問或基金公司公開說明書。
          </p>
        </div>

        <p className="text-[13px] text-slate-400 text-center mb-12 leading-relaxed">
          以上配置與推薦僅供參考，不構成投資建議。投資前請詳閱商品公開說明書，並評估自身風險承受能力。
        </p>

        <div className="flex gap-4 justify-center">
          <Link
            href="/quiz"
            className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-10 py-4 rounded-lg font-semibold text-[18px] transition-colors"
          >
            重新測驗
          </Link>
          <Link
            href="/"
            className="border border-slate-300 text-[#0B1220] px-10 py-4 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[18px]"
          >
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}

export default function ReportPage() {
  return (
    <Suspense fallback={null}>
      <ReportContent />
    </Suspense>
  );
}