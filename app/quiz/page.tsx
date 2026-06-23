"use client";

import { Suspense } from "react";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

type Answer = {
  text: string;
  score: number;
};

type Question = {
  id: number;
  text: string;
  answers: Answer[];
};

const QUESTIONS: Question[] = [
  {
    id: 1,
    text: "如果你的投資組合在一個月內下跌 15%，你會怎麼做？",
    answers: [
      { text: "立即全部賣出，停損出場", score: 1 },
      { text: "賣出一部分，降低風險", score: 2 },
      { text: "維持不動，觀察情況", score: 3 },
      { text: "加碼買進，逢低布局", score: 5 },
    ],
  },
  {
    id: 2,
    text: "你的投資目標主要是？",
    answers: [
      { text: "保本，避免任何虧損", score: 1 },
      { text: "穩定領息或小幅成長", score: 2 },
      { text: "資產中長期成長", score: 4 },
      { text: "追求最大化報酬", score: 5 },
    ],
  },
  {
    id: 3,
    text: "這筆投資的資金，預計多久之後會需要動用？",
    answers: [
      { text: "1年內", score: 1 },
      { text: "1~3年", score: 2 },
      { text: "3~7年", score: 4 },
      { text: "7年以上", score: 5 },
    ],
  },
  {
    id: 4,
    text: "你過去的投資經驗大概是？",
    answers: [
      { text: "完全沒有投資經驗", score: 1 },
      { text: "只買過定存、儲蓄險", score: 2 },
      { text: "買過基金或ETF", score: 3 },
      { text: "個股、期貨都操作過", score: 5 },
    ],
  },
  {
    id: 5,
    text: "如果有兩個方案，你會選哪一個？",
    answers: [
      { text: "穩賺3%，零風險", score: 1 },
      { text: "70%機會賺8%，30%機會賺0%", score: 3 },
      { text: "50%機會賺20%，50%機會虧5%", score: 5 },
    ],
  },
  {
    id: 6,
    text: "你的家庭財務狀況是？",
    answers: [
      { text: "收入不穩定，沒有緊急預備金", score: 1 },
      { text: "收入穩定，有基本緊急預備金", score: 3 },
      { text: "收入充裕，財務狀況寬裕", score: 5 },
    ],
  },
  {
    id: 7,
    text: "看到新聞報導股市大跌，你的第一反應是？",
    answers: [
      { text: "緊張焦慮，想趕快出場", score: 1 },
      { text: "有點擔心，但會先觀察", score: 2 },
      { text: "覺得是正常波動", score: 4 },
      { text: "覺得是進場好時機", score: 5 },
    ],
  },
  {
    id: 8,
    text: "你比較能接受哪一種資產配置？",
    answers: [
      { text: "100% 定存或債券", score: 1 },
      { text: "債券為主，股票為輔", score: 2 },
      { text: "股債各半", score: 3 },
      { text: "股票為主，少量債券", score: 5 },
    ],
  },
  {
    id: 9,
    text: "你對「投資波動」的看法是？",
    answers: [
      { text: "波動讓我睡不著覺", score: 1 },
      { text: "波動會讓我有些不安", score: 2 },
      { text: "波動是投資必經過程", score: 4 },
      { text: "波動代表機會", score: 5 },
    ],
  },
  {
    id: 10,
    text: "你希望多久檢視一次投資組合？",
    answers: [
      { text: "每天都要看", score: 2 },
      { text: "每週看一次", score: 3 },
      { text: "每月看一次", score: 4 },
      { text: "一季或更久看一次即可", score: 5 },
    ],
  },
  {
    id: 11,
    text: "如果投資虧損 10%，你會？",
    answers: [
      { text: "完全無法接受，立刻處理", score: 1 },
      { text: "會擔心，但能忍受一段時間", score: 3 },
      { text: "可以接受，視為正常波動", score: 5 },
    ],
  },
  {
    id: 12,
    text: "你的年齡階段大概是？",
    answers: [
      { text: "55歲以上，接近退休", score: 1 },
      { text: "45~55歲", score: 2 },
      { text: "35~45歲", score: 3 },
      { text: "35歲以下", score: 5 },
    ],
  },
  {
    id: 13,
    text: "比起穩定領息，你更在意？",
    answers: [
      { text: "穩定領息比較重要", score: 1 },
      { text: "息收與成長都要兼顧", score: 3 },
      { text: "資產長期成長比較重要", score: 5 },
    ],
  },
  {
    id: 14,
    text: "如果朋友推薦一檔高波動的科技股，你會？",
    answers: [
      { text: "完全不考慮", score: 1 },
      { text: "了解一下，但不會投入太多", score: 3 },
      { text: "願意投入一部分資金嘗試", score: 5 },
    ],
  },
  {
    id: 15,
    text: "你對「本金虧損」的容忍度是？",
    answers: [
      { text: "完全不能接受本金虧損", score: 1 },
      { text: "可以接受小幅虧損(5%內)", score: 2 },
      { text: "可以接受中度虧損(5~15%)", score: 4 },
      { text: "可以接受較大虧損換取高報酬", score: 5 },
    ],
  },
  {
    id: 16,
    text: "你投資的主要資金來源是？",
    answers: [
      { text: "退休金或養老金", score: 1 },
      { text: "緊急預備金以外的儲蓄", score: 3 },
      { text: "閒置資金，短期內不會用到", score: 5 },
    ],
  },
  {
    id: 17,
    text: "對於投資相關知識，你願意花多少時間學習？",
    answers: [
      { text: "希望全部交給專家處理", score: 2 },
      { text: "願意花一些時間了解基本概念", score: 3 },
      { text: "願意持續研究市場與產業", score: 5 },
    ],
  },
  {
    id: 18,
    text: "如果同一年內市場修正超過一次，你會？",
    answers: [
      { text: "考慮退出市場", score: 1 },
      { text: "重新評估但傾向繼續持有", score: 3 },
      { text: "視為加碼的機會", score: 5 },
    ],
  },
  {
    id: 19,
    text: "你期待的年化報酬率大概是？",
    answers: [
      { text: "2~4%（接近定存）", score: 1 },
      { text: "5~7%", score: 3 },
      { text: "8~12%", score: 4 },
      { text: "12%以上", score: 5 },
    ],
  },
  {
    id: 20,
    text: "整體來說，你會如何形容自己的投資個性？",
    answers: [
      { text: "保守謹慎，安全第一", score: 1 },
      { text: "穩健務實，平衡風險與報酬", score: 3 },
      { text: "積極進取，願意承擔風險換取成長", score: 5 },
    ],
  },
];

type ResultType = {
  key: "conservative" | "balanced" | "growth" | "aggressive";
  title: string;
  range: string;
  desc: string;
  allocation: { label: string; value: number; color: string }[];
};

const RESULTS: ResultType[] = [
  {
    key: "conservative",
    title: "保守型",
    range: "20 - 40 分",
    desc: "你重視資產的安全與穩定，對虧損的容忍度較低，適合以保本與穩定收益為主的投資組合。",
    allocation: [
      { label: "債券", value: 60, color: "#64748b" },
      { label: "現金", value: 25, color: "#334155" },
      { label: "股票", value: 15, color: "#F5B700" },
    ],
  },
  {
    key: "balanced",
    title: "穩健型",
    range: "41 - 60 分",
    desc: "你希望在風險與報酬之間取得平衡，能接受一定程度的波動，適合股債均衡配置的投資組合。",
    allocation: [
      { label: "股票", value: 45, color: "#F5B700" },
      { label: "債券", value: 40, color: "#64748b" },
      { label: "現金", value: 15, color: "#334155" },
    ],
  },
  {
    key: "growth",
    title: "成長型",
    range: "61 - 80 分",
    desc: "你願意承擔較高波動以追求資產成長，投資期間較長，適合以股票為主、債券為輔的配置。",
    allocation: [
      { label: "股票", value: 70, color: "#F5B700" },
      { label: "債券", value: 22, color: "#64748b" },
      { label: "現金", value: 8, color: "#334155" },
    ],
  },
  {
    key: "aggressive",
    title: "積極型",
    range: "81 - 100 分",
    desc: "你能承受高度波動，追求長期最大化報酬，適合以股票為核心、搭配高成長資產的投資組合。",
    allocation: [
      { label: "股票", value: 85, color: "#F5B700" },
      { label: "債券", value: 10, color: "#64748b" },
      { label: "現金", value: 5, color: "#334155" },
    ],
  },
];

function getResult(totalScore: number): ResultType {
  if (totalScore <= 40) return RESULTS[0];
  if (totalScore <= 60) return RESULTS[1];
  if (totalScore <= 80) return RESULTS[2];
  return RESULTS[3];
}

// ---- localStorage helpers (mirrors clients page) ----
const STORAGE_KEY = "smartmatch_clients";

function loadClients() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveClients(clients: unknown[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function QuizContent() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("clientId");

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>(
    Array(QUESTIONS.length).fill(0)
  );
  const [showResult, setShowResult] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveForm, setSaveForm] = useState({ name: "", notes: "" });
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [clientName, setClientName] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    const clients = loadClients();
    const found = clients.find((c: { id: string; name: string }) => c.id === clientId);
    if (found) setClientName(found.name);
  }, [clientId]);

  const isLastQuestion = step === QUESTIONS.length - 1;
  const currentQuestion = QUESTIONS[step];
  const progress = ((step + 1) / QUESTIONS.length) * 100;
  const totalScore = answers.reduce((sum, s) => sum + s, 0);
  const result = getResult(totalScore);

  function handleAnswer(score: number) {
    const next = [...answers];
    next[step] = score;
    setAnswers(next);

    if (isLastQuestion) {
      const finalScore = next.reduce((sum, s) => sum + s, 0);
      const finalResult = getResult(finalScore);
      if (clientId) {
        const clients = loadClients();
        const updated = clients.map((c: { id: string }) =>
          c.id === clientId
            ? { ...c, personality: finalResult.key, personalityScore: finalScore, updatedAt: new Date().toISOString() }
            : c
        );
        saveClients(updated);
        setSaved(true);
      }
      setShowResult(true);
    } else {
      setStep(step + 1);
    }
  }

  function handleBack() {
    if (step > 0) setStep(step - 1);
  }

  function handleRestart() {
    setStep(0);
    setAnswers(Array(QUESTIONS.length).fill(0));
    setShowResult(false);
    setSaved(false);
    setShowSaveForm(false);
  }

  function handleSaveNewClient() {
    if (!saveForm.name.trim()) return;
    const clients = loadClients();
    if (clients.length >= 5) {
      window.location.href = "/pricing";
      return;
    }
    const now = new Date().toISOString();
    const newClient = {
      id: newId(),
      name: saveForm.name.trim(),
      age: 0, phone: "", email: "",
      riskLevel: "中", investmentGoal: "資產增值",
      personality: result.key,
      personalityScore: totalScore,
      notes: saveForm.notes.trim(),
      createdAt: now, updatedAt: now, meetings: [],
    };
    saveClients([...clients, newClient]);
    setSaved(true);
    setShowSaveForm(false);
  }

  if (showResult) {
    return (
      <main className="min-h-screen bg-[#020817] flex items-center justify-center px-6 pt-32 pb-20 relative overflow-hidden">

      {/* 品牌背景：金融商辦大樓 + 深藍遮罩 */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "brightness(0.15)",
        }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(2,8,23,0.88) 0%, rgba(2,8,23,0.96) 100%)" }} />
      </div>
      {/* DARK NAVBAR */}
      <nav className="fixed top-0 left-0 w-full z-50 bg-[#020817]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <a href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </a>
          <div className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <a href="/quiz" className="text-[#F5B700]">投資人格分析</a>
            <a href="/etf" className="hover:text-white transition-colors">ETF篩選器</a>
            <a href="/funds" className="hover:text-white transition-colors">基金篩選器</a>
            <a href="/compare" className="hover:text-white transition-colors">比較中心</a>
            <a href="/clients" className="hover:text-white transition-colors">客戶管理</a>
            <a href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <a href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</a>
          </div>
        </div>
      </nav>

        <div className="max-w-[760px] w-full relative z-10">

          <div className="text-center mb-12">
            <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-6">SMARTMATCH</div>
            {clientName && <div className="text-[15px] text-slate-400 mb-2">客戶：{clientName}</div>}
            <div className="text-[18px] text-slate-400 mb-3">投資人格分析結果</div>
            <h1 className="text-[64px] font-black text-white leading-tight">{result.title}</h1>
            <div className="text-[16px] text-slate-400 mt-2">總分 {totalScore} 分（{result.range}）</div>
          </div>

          <p className="text-[20px] leading-[1.8] text-slate-400 text-center mb-12">{result.desc}</p>

          <div className="bg-[#0B1220] rounded-[24px] p-10 mb-10">
            <div className="text-white text-[22px] font-bold mb-6">資產配置分析</div>
            <div className="flex h-4 rounded-full overflow-hidden mb-6">
              {result.allocation.map((a) => (
                <div key={a.label} style={{ width: `${a.value}%`, backgroundColor: a.color }} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-4">
              {result.allocation.map((a) => (
                <div key={a.label}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
                    <span className="text-slate-300 text-[15px]">{a.label}</span>
                  </div>
                  <div className="text-white text-[28px] font-bold">{a.value}%</div>
                </div>
              ))}
            </div>
          </div>

          {!saved && !clientId && (
            <div className="border border-[#F5B700]/40 rounded-2xl p-6 mb-8 bg-[#F5B700]/5">
              {!showSaveForm ? (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[16px] font-bold text-white">儲存分析結果</div>
                    <div className="text-[14px] text-slate-400 mt-1">將此分析結果儲存至客戶管理中心</div>
                  </div>
                  <button onClick={() => setShowSaveForm(true)} className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-6 py-3 rounded-lg font-bold text-[15px] transition-colors">
                    儲存為客戶
                  </button>
                </div>
              ) : (
                <div>
                  <div className="text-[16px] font-bold text-white mb-4">建立客戶檔案</div>
                  <div className="flex flex-col gap-3">
                    <input type="text" value={saveForm.name} onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })} placeholder="客戶姓名 *" className="border border-white/20 rounded-lg px-4 py-3 text-[15px] focus:outline-none focus:border-[#F5B700]" />
                    <textarea value={saveForm.notes} onChange={(e) => setSaveForm({ ...saveForm, notes: e.target.value })} placeholder="備註（選填）" rows={2} className="border border-white/20 rounded-lg px-4 py-3 text-[15px] focus:outline-none focus:border-[#F5B700] resize-none" />
                    <div className="flex gap-3">
                      <button onClick={handleSaveNewClient} className="flex-1 bg-[#F5B700] hover:bg-[#e0a800] text-white py-3 rounded-lg font-bold text-[15px] transition-colors">確認儲存</button>
                      <button onClick={() => setShowSaveForm(false)} className="border border-white/20 px-5 py-3 rounded-lg text-slate-400 text-[15px] hover:bg-white/[0.03]">取消</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {saved && (
            <div className="border border-green-200 bg-green-50 rounded-2xl p-5 mb-8 text-center">
              <div className="text-green-600 font-bold text-[16px]">✓ 已儲存至客戶管理中心</div>
              <a href="/clients" className="text-[14px] text-green-600 hover:underline mt-1 block">前往查看 →</a>
            </div>
          )}

          <div className="flex gap-4 justify-center">
            <a href={`/report?type=${result.key}`} className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-10 py-4 rounded-lg font-semibold text-[18px] transition-colors">
              查看分析結果
            </a>
            <button onClick={handleRestart} className="border border-white/20 text-white px-10 py-4 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[18px]">
              重新測驗
            </button>
            <a href="/" className="text-slate-400 hover:text-white transition-colors text-[16px] self-center">
              回到首頁
            </a>
          </div>

        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#020817] flex items-center justify-center px-6 pt-32 pb-20 relative overflow-hidden">

      {/* DARK NAVBAR */}
      <nav className="fixed top-0 left-0 w-full z-50 bg-[#020817]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <a href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </a>
          <div className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <a href="/quiz" className="text-[#F5B700]">投資人格分析</a>
            <a href="/etf" className="hover:text-white transition-colors">ETF篩選器</a>
            <a href="/funds" className="hover:text-white transition-colors">基金篩選器</a>
            <a href="/compare" className="hover:text-white transition-colors">比較中心</a>
            <a href="/clients" className="hover:text-white transition-colors">客戶管理</a>
            <a href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <a href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</a>
          </div>
        </div>
      </nav>

      <div className="max-w-[760px] w-full relative z-10">

        <div className="text-center mb-12">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-4">SMARTMATCH</div>
          {clientName && <div className="text-[14px] text-slate-400 mb-2">客戶：{clientName}</div>}
          <h1 className="text-[36px] font-black text-white">投資人格分析</h1>
        </div>

        <div className="mb-10">
          <div className="flex justify-between text-[13px] mb-3">
            <span className="text-slate-400">完成進度</span>
            <span className="text-[#F5B700] font-semibold">{Math.round(progress)}%</span>
          </div>
          <div className="w-full h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg, #F5B700, #e0a800)"
              }}
            />
          </div>
        </div>

        <div className="mb-6">
          <div className="text-[13px] tracking-[4px] text-[#F5B700] font-semibold mb-4">
            問題 {step + 1} / {QUESTIONS.length}
          </div>
          <h2 className="text-[32px] font-bold text-white leading-snug">{currentQuestion.text}</h2>
        </div>

        <div className="flex flex-col gap-4 mb-10">
          {currentQuestion.answers.map((a, i) => (
            <button
              key={i}
              onClick={() => handleAnswer(a.score)}
              className="group relative text-left px-8 py-6 rounded-2xl border border-white/10 bg-white/[0.04] transition-all duration-200 hover:border-[#F5B700]/60 hover:bg-[#F5B700]/[0.06] hover:shadow-[0_0_30px_rgba(245,183,0,0.15)] hover:scale-[1.01]"
            >
              {/* 左側編號 */}
              <div className="flex items-center gap-5">
                <span className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-[14px] font-bold text-slate-400 group-hover:border-[#F5B700] group-hover:text-[#F5B700] transition-colors shrink-0">
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="text-[18px] text-white/90 font-medium group-hover:text-white transition-colors leading-snug">
                  {a.text}
                </span>
              </div>
              {/* 右側箭頭 */}
              <span className="absolute right-6 top-1/2 -translate-y-1/2 text-white/20 group-hover:text-[#F5B700] transition-colors text-[20px]">→</span>
            </button>
          ))}
        </div>

        {step > 0 && (
          <button onClick={handleBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-[15px] group">
            <span className="group-hover:text-[#F5B700] transition-colors">←</span>
            上一題
          </button>
        )}

      </div>
    </main>
  );
}

export default function QuizPage() {
  return (
    <Suspense fallback={null}>
      <QuizContent />
    </Suspense>
  );
}