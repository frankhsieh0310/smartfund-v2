import Link from "next/link";

const tools = [
  {
    icon: "✦",
    name: "SmartMatch",
    description: "依照你的投資需求，快速探索符合條件的投資商品。",
    action: "開始探索 →",
    href: "/quiz",
    premium: false,
  },
  {
    icon: "⇆",
    name: "商品比較",
    description: "將不同投資商品的重要數據放在同一個畫面比較。",
    action: "開始比較 →",
    href: "/compare",
    premium: true,
  },
  {
    icon: "⌕",
    name: "條件篩選",
    description: "利用市場、資產類別與關鍵指標快速縮小研究範圍。",
    action: "開始篩選 →",
    href: "/screener",
    premium: true,
  },
  {
    icon: "◫",
    name: "投資組合",
    description: "集中查看資產配置、績效與投資組合結構。",
    action: "查看投資組合 →",
    href: "/portfolio",
    premium: true,
  },
];

const cardClass = "group relative flex min-h-[270px] flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-white/[0.04] p-6 transition-all hover:-translate-y-0.5 hover:border-[#F5B700]/35 hover:bg-white/[0.055] hover:shadow-[0_18px_55px_rgba(0,0,0,0.26)] md:p-7";

export function ResearchToolsSection() {
  return (
    <section className="relative z-10 bg-[#07111f] py-16 md:py-20">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-8 md:px-10">
        <div className="mb-10">
          <div className="mb-3 text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">研究工具</div>
          <h2 className="text-[32px] font-black tracking-[-0.02em] text-white md:text-[40px]">智慧研究工具</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400 md:text-[16px]">
            從商品探索、比較、篩選到投資組合分析，<br className="hidden sm:block" />把複雜的投資資料變得更簡單。
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tools.map((tool) => {
            const content = (
              <>
                <div aria-hidden="true" className="absolute -right-8 -top-8 h-28 w-28 rounded-full border border-white/[0.05]" />
                <div aria-hidden="true" className="absolute right-7 top-12 h-px w-16 bg-gradient-to-r from-transparent to-[#F5B700]/25" />
                {tool.premium && (
                  <span className="absolute right-5 top-5 rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.12em] text-[#F5B700]">進階功能</span>
                )}
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#F5B700]/20 bg-[#F5B700]/10 text-[22px] font-semibold text-[#F5B700]">{tool.icon}</div>
                <h3 className="mt-8 text-[24px] font-black tracking-[-0.02em] text-white">{tool.name}</h3>
                <p className="mt-3 text-[14px] leading-7 text-slate-400">{tool.description}</p>
                <span className={`mt-auto pt-7 text-[14px] font-semibold ${tool.href ? "text-[#F5B700] transition-colors group-hover:text-[#ffd04a]" : "tracking-[0.12em] text-slate-600"}`}>{tool.action}</span>
              </>
            );

            return tool.href ? (
              <Link key={tool.name} href={tool.href} className={cardClass}>{content}</Link>
            ) : (
              <div key={tool.name} aria-disabled="true" className={`${cardClass} cursor-default opacity-70 hover:translate-y-0 hover:border-white/[0.1] hover:bg-white/[0.04] hover:shadow-none`}>{content}</div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
