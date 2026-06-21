export default function HomeV3() {
    return (
      <main className="bg-slate-950 text-white min-h-screen">
  
{/* NAVBAR */}
<header className="fixed top-0 left-0 w-full z-50 bg-slate-950/90 backdrop-blur border-b border-slate-800">
  <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">

    <div>
      <div className="text-3xl font-bold text-yellow-400">
        FUNDMATCH
      </div>

      <div className="text-xs text-slate-400">
        基金 ETF 篩選平台
      </div>
    </div>

    <nav className="hidden lg:flex gap-10 text-slate-300">
      <a href="#">投資流程</a>
      <a href="#">熱門ETF</a>
      <a href="#">熱門基金</a>
      <a href="#">基金比較</a>
      <a href="#">資產配置</a>
    </nav>

    <button className="bg-yellow-500 hover:bg-yellow-400 text-black px-5 py-2 rounded-lg font-semibold">
      開始測驗
    </button>

  </div>
</header>

{/* HERO */}
<section
  className="min-h-screen flex items-center bg-cover bg-center pt-24"
  style={{
    backgroundImage:
      "linear-gradient(rgba(2,6,23,.88),rgba(2,6,23,.88)),url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2000')",
  }}
>
  <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16">

    <div className="flex flex-col justify-center">

      <div className="text-yellow-400 tracking-[6px] mb-6">
        FUNDMATCH
      </div>

      <h1 className="text-6xl lg:text-7xl font-bold leading-tight">
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

        <button className="border border-slate-600 px-8 py-4 rounded-xl">
          瀏覽資料庫
        </button>

      </div>

      <div className="grid grid-cols-3 gap-6 mt-16">

        <div>
          <div className="text-4xl font-bold text-yellow-400">
            2,000+
          </div>
          <div className="text-slate-400">
            基金資料
          </div>
        </div>

        <div>
          <div className="text-4xl font-bold text-yellow-400">
            500+
          </div>
          <div className="text-slate-400">
            ETF資料
          </div>
        </div>

        <div>
          <div className="text-4xl font-bold text-yellow-400">
            AI
          </div>
          <div className="text-slate-400">
            資產配置
          </div>
        </div>

      </div>

    </div>

    <div className="grid grid-cols-2 gap-5">

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
        <h3 className="text-xl font-bold mb-3">
          投資人格分析
        </h3>

        <p className="text-slate-400">
          15題問卷了解風險偏好與投資屬性
        </p>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
        <h3 className="text-xl font-bold mb-3">
          ETF篩選器
        </h3>

        <p className="text-slate-400">
          依產業、波動度與報酬率篩選
        </p>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
        <h3 className="text-xl font-bold mb-3">
          基金篩選器
        </h3>

        <p className="text-slate-400">
          快速比較全球基金績效
        </p>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6">
        <h3 className="text-xl font-bold mb-3">
          資產配置模型
        </h3>

        <p className="text-slate-400">
          建立專屬你的投資組合
        </p>
      </div>

    </div>

  </div>
</section>
  
      </main>
    );
  }