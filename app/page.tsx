export default function Home() {
  return (
    <main className="bg-slate-950 text-white">

      {/* NAVBAR */}
      <header className="fixed top-0 w-full z-50 bg-slate-950/80 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">

          <div>
            <div className="text-3xl font-bold text-yellow-400">
              FUNDMATCH
            </div>

            <div className="text-xs text-slate-400">
              基金 ETF 篩選平台
            </div>
          </div>

          <nav className="hidden md:flex gap-10 text-slate-300">
            <a href="#">投資流程</a>
            <a href="#">熱門ETF</a>
            <a href="#">熱門基金</a>
            <a href="#">基金比較</a>
          </nav>

          <button className="bg-yellow-500 text-black px-5 py-2 rounded-lg font-semibold">
            開始測驗
          </button>
        </div>
      </header>

      {/* HERO */}
      <section
        className="min-h-screen flex items-center pt-20 bg-cover bg-center"
        style={{
          backgroundImage:
            "linear-gradient(rgba(2,6,23,.85),rgba(2,6,23,.85)),url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2000')",
        }}
      >
        <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16">

          <div className="flex flex-col justify-center">

            <div className="text-yellow-400 tracking-[4px] mb-4">
              FUNDMATCH
            </div>

            <h1 className="text-6xl md:text-7xl font-bold leading-tight">
              找到適合你的
              <br />
              <span className="text-yellow-400">
                ETF 與基金
              </span>
            </h1>

            <p className="text-xl text-slate-300 mt-8 leading-relaxed">
              透過投資人格分析、ETF資料庫、
              基金資料庫與資產配置模型，
              協助投資人快速建立專屬投資組合。
            </p>

            <div className="flex gap-4 mt-10">

              <button className="bg-yellow-500 text-black px-8 py-4 rounded-xl font-bold">
                開始投資分析
              </button>

              <button className="border border-slate-500 px-8 py-4 rounded-xl">
                瀏覽資料庫
              </button>

            </div>
          </div>

          {/* 功能卡 */}
          <div className="grid grid-cols-2 gap-5">

            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
              <h3 className="text-xl font-bold mb-3">
                投資人格分析
              </h3>

              <p className="text-slate-400">
                15題問卷了解你的風險偏好與投資屬性
              </p>
            </div>

            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
              <h3 className="text-xl font-bold mb-3">
                ETF 篩選器
              </h3>

              <p className="text-slate-400">
                依報酬率、波動度、產業快速篩選
              </p>
            </div>

            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
              <h3 className="text-xl font-bold mb-3">
                基金篩選器
              </h3>

              <p className="text-slate-400">
                依風險等級與績效挑選基金
              </p>
            </div>

            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
              <h3 className="text-xl font-bold mb-3">
                資產配置模型
              </h3>

              <p className="text-slate-400">
                建立專屬你的基金ETF投資組合
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* 基金績效比較 */}
      <section className="py-24 bg-white text-slate-900">

        <div className="max-w-7xl mx-auto px-6">

          <h2 className="text-5xl font-bold text-center mb-6">
            基金績效比較
          </h2>

          <p className="text-center text-slate-500 mb-16">
            比較不同基金在各期間的報酬率表現
          </p>

          <div className="bg-slate-100 rounded-3xl p-10">

            <div className="flex flex-wrap gap-3 mb-10">

              <span className="bg-white px-4 py-2 rounded-lg">
                野村全球金融收益
              </span>

              <span className="bg-white px-4 py-2 rounded-lg">
                聯博美國收益
              </span>

              <span className="bg-white px-4 py-2 rounded-lg">
                貝萊德世界科技
              </span>

            </div>

            <div className="h-[450px] bg-white rounded-2xl flex items-center justify-center text-slate-400 text-xl">
              未來放入基金績效折線圖
            </div>

          </div>
        </div>
      </section>

      {/* 熱門基金 */}
      <section className="py-24 bg-slate-50">

        <div className="max-w-7xl mx-auto px-6">

          <h2 className="text-5xl font-bold text-center text-slate-900 mb-16">
            熱門基金排行
          </h2>

          <div className="grid md:grid-cols-3 gap-8">

            <div className="bg-white p-8 rounded-2xl shadow">
              🥇 野村全球金融收益基金
            </div>

            <div className="bg-white p-8 rounded-2xl shadow">
              🥈 聯博美國收益基金
            </div>

            <div className="bg-white p-8 rounded-2xl shadow">
              🥉 貝萊德世界科技基金
            </div>

          </div>

        </div>
      </section>

      {/* 投資流程 */}
      <section className="py-24 bg-white text-slate-900">

        <div className="max-w-6xl mx-auto px-6">

          <h2 className="text-5xl font-bold text-center mb-20">
            投資流程
          </h2>

          <div className="grid md:grid-cols-4 gap-8 text-center">

            <div>
              <div className="text-5xl mb-4">①</div>
              投資人格測驗
            </div>

            <div>
              <div className="text-5xl mb-4">②</div>
              ETF / 基金篩選
            </div>

            <div>
              <div className="text-5xl mb-4">③</div>
              績效比較分析
            </div>

            <div>
              <div className="text-5xl mb-4">④</div>
              建立投資組合
            </div>

          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-28 bg-slate-950 text-center">

        <h2 className="text-5xl font-bold mb-8">
          開始建立你的投資組合
        </h2>

        <button className="bg-yellow-500 text-black px-10 py-5 rounded-xl text-xl font-bold">
          立即開始
        </button>

      </section>

      {/* FOOTER */}
      <footer className="bg-black text-slate-500 py-8 text-center">
        © 2026 FundMatch
      </footer>

    </main>
  );
}