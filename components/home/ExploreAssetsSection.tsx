import Link from "next/link";

const assets = [
  { icon: "▦", name: "股票", description: "探索全球上市公司", href: "/markets" },
  { icon: "◇", name: "ETF", description: "搜尋全球交易所交易基金", href: "/etf" },
  { icon: "◫", name: "基金", description: "研究全球共同基金", href: "/funds" },
  { icon: "▤", name: "債券", description: "查看政府債與固定收益市場", href: "/markets" },
  { icon: "⌂", name: "REITs", description: "探索全球不動產投資信託" },
  { icon: "⌁", name: "指數", description: "追蹤全球主要市場指標", href: "/markets" },
  { icon: "⇄", name: "外匯", description: "查看全球主要貨幣市場", href: "/markets" },
  { icon: "◆", name: "商品", description: "黃金、能源與原物料市場", href: "/markets" },
  { icon: "₿", name: "加密資產", description: "探索全球數位資產" },
  { icon: "↗", name: "期貨", description: "研究全球主要期貨市場" },
];

const cardClass = "group min-h-[150px] rounded-2xl border border-white/[0.09] bg-white/[0.035] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-[#F5B700]/35 hover:bg-white/[0.055] hover:shadow-[0_14px_35px_rgba(0,0,0,0.22)]";

export function ExploreAssetsSection() {
  return (
    <section className="relative z-10 bg-[#091526] py-16 md:py-20">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-8 md:px-10">
        <div className="mb-9">
          <div className="mb-3 text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">探索全球投資市場</div>
          <h2 className="text-[32px] font-black tracking-[-0.02em] text-white md:text-[40px]">探索全球投資市場</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400 md:text-[16px]">
            從股票、ETF、基金到債券與另類資產，<br className="hidden sm:block" />快速進入你想研究的市場。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-5">
          {assets.map((asset) => asset.href ? (
            <Link key={asset.name} href={asset.href} className={cardClass}>
              <div className="text-[24px] font-semibold text-[#F5B700]">{asset.icon}</div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <h3 className="text-[17px] font-bold text-white">{asset.name}</h3>
                <span className="text-[16px] text-slate-500 transition-colors group-hover:text-[#F5B700]">→</span>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500 md:text-[13px]">{asset.description}</p>
            </Link>
          ) : (
            <div key={asset.name} aria-disabled="true" className={`${cardClass} cursor-default opacity-65 hover:translate-y-0 hover:border-white/[0.09] hover:bg-white/[0.035] hover:shadow-none`}>
              <div className="text-[24px] font-semibold text-slate-500">{asset.icon}</div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <h3 className="text-[17px] font-bold text-white">{asset.name}</h3>
                <span className="text-[9px] font-semibold tracking-[0.1em] text-slate-600">即將推出</span>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500 md:text-[13px]">{asset.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
