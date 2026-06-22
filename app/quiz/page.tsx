import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-white overflow-hidden">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-white border-b border-slate-200">
        <div className="max-w-[1700px] mx-auto h-24 px-10 flex items-center justify-between">

          <div>
            <div className="text-[52px] font-black text-[#0B1220] leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>

            <div className="text-[14px] text-slate-500 mt-1">
              ETF & 基金資產配置分析平台
            </div>
          </div>

          <nav className="hidden lg:flex gap-8 text-[15px] font-semibold tracking-[0.3px] text-slate-700">
            <Link href="/quiz" className="hover:text-[#0B1220] transition-colors">投資人格分析</Link>
            <Link href="/etf" className="hover:text-[#0B1220] transition-colors">ETF篩選器</Link>
            <a href="#" className="hover:text-[#0B1220] transition-colors">基金篩選器</a>
            <Link href="/compare" className="hover:text-[#0B1220] transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-[#0B1220] transition-colors">客戶管理</Link>
          </nav>

          <div className="flex items-center gap-6">
            <a href="#" className="text-[15px] font-semibold text-slate-600 hover:text-[#0B1220] transition-colors">
              登入
            </a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-7 py-3 rounded-lg font-bold text-[15px]">
              開始分析
            </Link>
          </div>

        </div>
      </header>

      {/* HERO */}
      <section className="pt-24">

        <div className="grid lg:grid-cols-[47%_53%] min-h-[1100px]">

          {/* LEFT */}
          <div className="flex flex-col items-start justify-center pt-32 bg-white relative z-20 px-12">

            <div className="max-w-[860px]">

              <div className="tracking-[14px] text-[#F5B700] text-[20px] font-semibold mb-6">
                SMARTMATCH
              </div>

              <div className="text-[24px] font-medium text-slate-500 mb-6">
                讓資產配置不再憑感覺
              </div>

              <h1 className="text-[126px] font-black leading-[0.88] tracking-[-1px] text-[#0B1220] mb-14">

                找到適合你的

                <br />

                <span className="text-[#F5B700] text-[108px]">ETF</span>與基金

              </h1>

              <p className="text-[36px] leading-[1.7] font-medium text-slate-600 max-w-[680px] mb-16">
                透過投資人格分析、ETF與基金資料庫、
                <br />
                以及資產配置模型，協助投資人建立長期可執行的投資策略。
              </p>

              <div className="flex gap-5">

                <Link
                  href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-12 py-5 rounded-lg font-semibold text-[22px] transition-colors"
                >
                  開始投資人格分析
                </Link>

                <button className="border border-slate-300 text-[#0B1220] px-12 py-5 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[22px]">
                  瀏覽資料庫
                </button>

              </div>

            </div>

          </div>

          {/* RIGHT */}
          <div className="relative overflow-hidden">

            {/* BUILDING */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
                backgroundSize: "115%",
                backgroundPosition: "20% center",
                backgroundRepeat: "no-repeat",
              }}
            />

            {/* OVERLAY */}
            <div className="absolute inset-0 bg-black/25" />

            {/* GOLD GLOW */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(ellipse 900px 600px at 75% 15%, rgba(245,183,0,0.18), transparent 60%)",
              }}
            />

            {/* DATA LINES */}
            <svg
              className="absolute inset-0 w-full h-full opacity-[0.35] pointer-events-none"
              viewBox="0 0 800 1000"
              preserveAspectRatio="xMidYMid slice"
            >
              <polyline
                points="0,820 80,790 160,830 240,760 320,780 400,700 480,730 560,650 640,680 720,600 800,560"
                fill="none"
                stroke="#F5B700"
                strokeWidth="2"
                strokeOpacity="0.5"
              />
              <polyline
                points="0,900 90,880 180,905 270,860 360,875 450,820 540,840 630,790 720,810 800,770"
                fill="none"
                stroke="#F5B700"
                strokeWidth="1.5"
                strokeOpacity="0.3"
              />
            </svg>

            {/* DIAGONAL CUT */}
            <div
              className="absolute left-[-380px] top-0 h-full w-[620px] bg-white z-10"
              style={{
                clipPath: "polygon(0 0,100% 0,0 100%)",
              }}
            />

            {/* DASHBOARD */}
            <div className="relative z-20 h-full flex items-start pt-12 justify-center pl-36">

              <div className="grid grid-cols-2 gap-4 w-[920px]">

                {/* MARKET — 玻璃卡 */}
                <div className="bg-white/[0.18] backdrop-blur-2xl border border-white/20 rounded-[24px] p-8 h-auto text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">

                  <div className="flex justify-between mb-8">

                    <div className="font-bold text-[30px]">
                      市場概覽
                    </div>

                    <div className="text-[14px] text-slate-400">
                      即時更新 15:30
                    </div>

                  </div>

                  <div className="space-y-7 text-[18px]">

                    <div className="flex justify-between">
                      <span>S&P 500</span>
                      <span className="text-green-400">+0.68%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>NASDAQ</span>
                      <span className="text-green-400">+0.85%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>DOW JONES</span>
                      <span className="text-green-400">+0.53%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>MSCI ACWI</span>
                      <span className="text-green-400">+0.62%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>VIX</span>
                      <span className="text-red-400">-1.19%</span>
                    </div>

                  </div>

                </div>

                {/* ASSET — 深藍卡 */}
                <div className="bg-[#0B1220] border border-white/10 rounded-[24px] p-8 h-auto text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">

                  <div className="font-bold text-[30px] mb-8">
                    資產配置分析
                  </div>

                  <div className="flex justify-center mb-8">

                    <div className="relative w-48 h-48">

                      <div className="absolute inset-0 rounded-full border-[22px] border-[#F5B700]" />

                      <div className="absolute inset-[32px] rounded-full bg-black" />

                    </div>

                  </div>

                  <div className="space-y-3 text-[18px]">

                    <div className="flex justify-between">
                      <span>股票</span>
                      <span>65%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>債券</span>
                      <span>20%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>現金</span>
                      <span>15%</span>
                    </div>

                  </div>

                </div>

                {/* PERFORMANCE — 純黑卡 */}
                <div className="bg-black border border-white/10 rounded-[24px] p-8 h-auto text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">

                  <div className="font-bold text-[30px]">
                    投資組合績效
                  </div>

                  <div className="text-[14px] text-slate-400 mt-1">
                    年化報酬率
                  </div>

                  <div className="text-[120px] font-bold text-lime-400 mt-4 leading-none">
                    8.47%
                  </div>

                  <svg
                    viewBox="0 0 300 90"
                    className="w-full h-36 mt-8"
                  >
                    <polyline
                      fill="none"
                      stroke="#84cc16"
                      strokeWidth="4"
                      points="0,78 25,76 50,79 75,63 100,66 125,58 150,61 175,48 200,53 225,43 250,36 300,28"
                    />
                  </svg>

                </div>

                {/* ETF — 半透明卡 */}
                <div className="bg-black/75 backdrop-blur-xl border border-white/10 rounded-[24px] p-8 h-auto text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">

                  <div className="font-bold text-[30px] mb-6">
                    ETF 熱門排行
                  </div>

                  <div className="space-y-4 text-[18px]">

                    <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#8B0000] flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                          VG
                        </div>
                        <div>
                          <div className="font-semibold">VOO</div>
                          <div className="text-[14px] text-slate-400 mt-0.5">
                            AUM 4,200億・費用率 0.03%
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-green-400">+0.63%</div>
                        <div className="text-[14px] text-slate-400">1Y +24.1%</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#003DA5] flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                          IV
                        </div>
                        <div>
                          <div className="font-semibold">QQQ</div>
                          <div className="text-[14px] text-slate-400 mt-0.5">
                            AUM 2,800億・費用率 0.20%
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-green-400">+0.85%</div>
                        <div className="text-[14px] text-slate-400">1Y +29.4%</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#8B0000] flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                          VG
                        </div>
                        <div>
                          <div className="font-semibold">VTI</div>
                          <div className="text-[14px] text-slate-400 mt-0.5">
                            AUM 1,600億・費用率 0.03%
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-green-400">+0.59%</div>
                        <div className="text-[14px] text-slate-400">1Y +23.5%</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#8B0000] flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                          VG
                        </div>
                        <div>
                          <div className="font-semibold">VXUS</div>
                          <div className="text-[14px] text-slate-400 mt-0.5">
                            AUM 980億・費用率 0.05%
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-green-400">+0.31%</div>
                        <div className="text-[14px] text-slate-400">1Y +14.2%</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#8B0000] flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                          VG
                        </div>
                        <div>
                          <div className="font-semibold">BND</div>
                          <div className="text-[14px] text-slate-400 mt-0.5">
                            AUM 1,100億・費用率 0.03%
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-green-400">+0.21%</div>
                        <div className="text-[14px] text-slate-400">1Y +3.8%</div>
                      </div>
                    </div>

                  </div>

                </div>

              </div>

            </div>

          </div>

        </div>

        {/* STAT BAND — full width, outside the 43/57 grid */}
        <div className="w-full max-w-[1200px] mx-auto px-12 pb-32 pt-8">
          <div className="grid grid-cols-4 gap-12">

            <div>
              <div className="text-[64px] font-black text-[#0B1220] leading-none">
                2,000+
              </div>
              <div className="text-[20px] font-medium text-slate-500 mt-3">
                基金資料
              </div>
            </div>

            <div>
              <div className="text-[64px] font-black text-[#0B1220] leading-none">
                500+
              </div>
              <div className="text-[20px] font-medium text-slate-500 mt-3">
                ETF資料
              </div>
            </div>

            <div>
              <div className="text-[64px] font-black text-[#0B1220] leading-none">
                50+
              </div>
              <div className="text-[20px] font-medium text-slate-500 mt-3">
                基金公司
              </div>
            </div>

            <div>
              <div className="text-[64px] font-black text-[#F5B700] leading-none">
                AI
              </div>
              <div className="text-[20px] font-medium text-slate-500 mt-3">
                資產配置
              </div>
            </div>

          </div>
        </div>

      </section>

      {/* PERSONALITY ENTRY */}
      <section className="bg-[#0B1220] border-t border-white/10 py-40">
        <div className="max-w-[1700px] mx-auto px-10">

          <div className="text-center mb-16">
            <div className="text-[22px] tracking-[10px] text-[#F5B700] mb-6 font-semibold">
              STEP 1
            </div>
            <h2 className="text-[72px] font-black text-white leading-tight">
              投資人格分析
            </h2>
            <p className="text-slate-400 text-[28px] mt-6">
              3 分鐘問卷，了解你的投資屬性與風險承受度
            </p>
          </div>

          <div className="grid grid-cols-4 gap-6">

            <PersonalityCard
              tag="保守型"
              desc="追求穩定現金流"
            />
            <PersonalityCard
              tag="穩健型"
              desc="兼顧成長與防禦"
            />
            <PersonalityCard
              tag="成長型"
              desc="追求長期資本增值"
            />
            <PersonalityCard
              tag="積極型"
              desc="最大化長期報酬"
            />

          </div>

          <div className="flex justify-center mt-14">
            <Link
              href="/quiz"
              className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-12 py-5 rounded-lg font-bold transition-colors"
            >
              開始投資人格分析
            </Link>
          </div>

        </div>
      </section>

      {/* INVESTMENT PROCESS */}
      <section className="bg-[#111827] border-t border-white/10 py-40">
        <div className="max-w-[1700px] mx-auto px-10">

          <div className="text-center mb-20">
            <div className="text-[22px] tracking-[10px] text-[#F5B700] mb-6 font-semibold">
              HOW IT WORKS
            </div>
            <h2 className="text-[72px] font-black text-white leading-tight">
              投資流程
            </h2>
          </div>

          <div className="grid grid-cols-4 gap-6 max-w-[1440px] mx-auto">

            <ProcessCard
              icon="quiz"
              step="STEP 1"
              title="投資人格分析"
              desc="了解風險偏好與投資屬性"
            />
            <ProcessCard
              icon="search"
              step="STEP 2"
              title="ETF / 基金篩選"
              desc="依條件快速比較標的"
            />
            <ProcessCard
              icon="chart"
              step="STEP 3"
              title="AI 資產配置"
              desc="生成專屬投資組合"
            />
            <ProcessCard
              icon="report"
              step="STEP 4"
              title="產生投資報告"
              desc="可執行的長期策略"
            />

          </div>

        </div>
      </section>

    </main>
  );
}

function PersonalityCard({ tag, desc }: { tag: string; desc: string }) {
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-8 h-[220px] flex flex-col justify-center hover:border-[#F5B700]/50 transition-colors cursor-pointer group">
      <div className="text-[42px] font-bold text-white group-hover:text-[#F5B700] transition-colors">
        {tag}
      </div>
      <div className="text-slate-400 text-[24px] mt-3">
        {desc}
      </div>
    </div>
  );
}

function ProcessCard({
  icon,
  step,
  title,
  desc,
}: {
  icon: "quiz" | "search" | "chart" | "report";
  step: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="w-full h-[220px] bg-white/[0.03] border border-white/10 rounded-2xl p-8 flex flex-col hover:border-[#F5B700]/50 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <div className="w-12 h-12 rounded-xl bg-[#F5B700]/10 flex items-center justify-center text-[#F5B700]">
          <ProcessIcon name={icon} />
        </div>
        <span className="text-[13px] tracking-[2px] text-slate-500 font-semibold">
          {step}
        </span>
      </div>
      <div className="text-white text-[24px] font-bold mb-2">
        {title}
      </div>
      <div className="text-slate-400 text-[16px] leading-snug">
        {desc}
      </div>
    </div>
  );
}

function ProcessIcon({ name }: { name: "quiz" | "search" | "chart" | "report" }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" } as const;
  switch (name) {
    case "quiz":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.7.25-1.2.85-1.2 1.6V14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="17" r="0.9" fill="currentColor" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M19 19l-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path d="M4 19h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <rect x="6" y="12" width="3" height="6" rx="0.5" fill="currentColor" />
          <rect x="11" y="8" width="3" height="10" rx="0.5" fill="currentColor" />
          <rect x="16" y="5" width="3" height="13" rx="0.5" fill="currentColor" />
        </svg>
      );
    case "report":
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}