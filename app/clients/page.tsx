"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type PersonalityType = "conservative" | "balanced" | "growth" | "aggressive";

const PERSONALITY_LABELS: Record<PersonalityType, string> = {
  conservative: "保守型",
  balanced: "穩健型",
  growth: "成長型",
  aggressive: "積極型",
};

const PERSONALITY_COLORS: Record<PersonalityType, string> = {
  conservative: "#64748b",
  balanced: "#3b82f6",
  growth: "#16a34a",
  aggressive: "#dc2626",
};

export type RiskLevel = "低" | "中低" | "中" | "中高" | "高";
export type InvestmentGoal = "退休規劃" | "資產增值" | "子女教育" | "現金流" | "其他";

export type Client = {
  id: string;
  name: string;
  age: number;
  phone: string;
  email: string;
  riskLevel: RiskLevel;
  investmentGoal: InvestmentGoal;
  personality: PersonalityType | null;
  personalityScore: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  meetings: Meeting[];
};

export type Meeting = {
  id: string;
  date: string;
  content: string;
};

const STORAGE_KEY = "smartmatch_clients";
const FREE_LIMIT = 5;

function loadClients(): Client[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveClients(clients: Client[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_FORM = {
  name: "",
  age: "",
  phone: "",
  email: "",
  riskLevel: "中" as RiskLevel,
  investmentGoal: "資產增值" as InvestmentGoal,
  notes: "",
};

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meetingInput, setMeetingInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setClients(loadClients());
  }, []);

  const filtered = clients.filter(
    (c) =>
      c.name.includes(search) ||
      c.phone.includes(search) ||
      c.email.includes(search)
  );

  const selectedClient = clients.find((c) => c.id === selectedId) ?? null;
  const isAtLimit = clients.length >= FREE_LIMIT;

  function handleSubmit() {
    if (!form.name.trim()) return;

    const now = new Date().toISOString();
    let updated: Client[];

    if (editingId) {
      updated = clients.map((c) =>
        c.id === editingId
          ? {
              ...c,
              name: form.name.trim(),
              age: Number(form.age) || 0,
              phone: form.phone.trim(),
              email: form.email.trim(),
              riskLevel: form.riskLevel,
              investmentGoal: form.investmentGoal,
              notes: form.notes.trim(),
              updatedAt: now,
            }
          : c
      );
    } else {
      const newClient: Client = {
        id: newId(),
        name: form.name.trim(),
        age: Number(form.age) || 0,
        phone: form.phone.trim(),
        email: form.email.trim(),
        riskLevel: form.riskLevel,
        investmentGoal: form.investmentGoal,
        personality: null,
        personalityScore: null,
        notes: form.notes.trim(),
        createdAt: now,
        updatedAt: now,
        meetings: [],
      };
      updated = [...clients, newClient];
    }

    saveClients(updated);
    setClients(updated);
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function handleEdit(client: Client) {
    setForm({
      name: client.name,
      age: String(client.age || ""),
      phone: client.phone,
      email: client.email,
      riskLevel: client.riskLevel,
      investmentGoal: client.investmentGoal,
      notes: client.notes,
    });
    setEditingId(client.id);
    setShowForm(true);
  }

  function handleDelete(id: string) {
    if (!confirm("確定要刪除這位客戶嗎？")) return;
    const updated = clients.filter((c) => c.id !== id);
    saveClients(updated);
    setClients(updated);
    if (selectedId === id) setSelectedId(null);
  }

  function handleAddMeeting() {
    if (!meetingInput.trim() || !selectedId) return;
    const updated = clients.map((c) =>
      c.id === selectedId
        ? {
            ...c,
            meetings: [
              ...c.meetings,
              {
                id: newId(),
                date: new Date().toLocaleDateString("zh-TW"),
                content: meetingInput.trim(),
              },
            ],
            updatedAt: new Date().toISOString(),
          }
        : c
    );
    saveClients(updated);
    setClients(updated);
    setMeetingInput("");
  }

  function handleDeleteMeeting(clientId: string, meetingId: string) {
    const updated = clients.map((c) =>
      c.id === clientId
        ? { ...c, meetings: c.meetings.filter((m) => m.id !== meetingId) }
        : c
    );
    saveClients(updated);
    setClients(updated);
  }

  return (
    <main className="min-h-screen bg-[#0a0f1e] px-6 pt-32 pb-20">

      {/* DARK NAVBAR */}
      <nav className="fixed top-0 left-0 w-full z-50 bg-[#0a0f1e]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <a href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </a>
          <div className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <a href="/quiz" className="hover:text-white transition-colors">投資人格分析</a>
            <a href="/etf" className="hover:text-white transition-colors">ETF篩選器</a>
            <a href="/funds" className="hover:text-white transition-colors">基金篩選器</a>
            <a href="/compare" className="hover:text-white transition-colors">比較中心</a>
            <a href="/clients" className="hover:text-white transition-colors">客戶管理</a>
            <a href="/pricing" className="text-[#F5B700] hover:text-[#e0a800] transition-colors">方案</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <a href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</a>
          </div>
        </div>
      </nav>

      <div className="max-w-[1280px] mx-auto">

        {/* HEADER */}
        <div className="flex items-end justify-between mb-10">
          <div>
            <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-4">
              SMARTMATCH
            </div>
            <h1 className="text-[44px] font-black text-white">
              客戶管理
            </h1>
            <p className="text-[16px] text-slate-400 mt-2">
              共 {clients.length} 位客戶
              {isAtLimit && (
                <a href="/pricing" className="ml-3 text-[#F5B700] font-semibold hover:underline">
                  免費版已達上限（{FREE_LIMIT}位）→ 升級方案
                </a>
              )}
            </p>
          </div>

          <div className="flex gap-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋客戶姓名、電話、Email"
              className="border border-white/20 rounded-lg px-4 py-2.5 text-[15px] w-[280px] focus:outline-none focus:border-[#F5B700]"
            />
            <button
              onClick={() => {
                if (isAtLimit) {
                  window.location.href = "/pricing";
                  return;
                }
                setForm(EMPTY_FORM);
                setEditingId(null);
                setShowForm(true);
              }}
              className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-6 py-2.5 rounded-lg font-bold text-[15px] transition-colors"
            >
              ＋ 新增客戶
            </button>
          </div>
        </div>

        {/* MODAL FORM */}
        {showForm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4">
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-8 w-full max-w-[560px] shadow-2xl">
              <h2 className="text-[24px] font-bold text-white mb-6">
                {editingId ? "編輯客戶" : "新增客戶"}
              </h2>

              <div className="flex flex-col gap-4">

                <div className="grid grid-cols-2 gap-4">
                  <Field label="姓名 *">
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="例如：王小明"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="年齡">
                    <input
                      type="number"
                      value={form.age}
                      onChange={(e) => setForm({ ...form, age: e.target.value })}
                      placeholder="例如：45"
                      className={inputCls}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="電話">
                    <input
                      type="text"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      placeholder="0912-345-678"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder="example@mail.com"
                      className={inputCls}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="風險承受度">
                    <select
                      value={form.riskLevel}
                      onChange={(e) => setForm({ ...form, riskLevel: e.target.value as RiskLevel })}
                      className={inputCls}
                    >
                      {(["低", "中低", "中", "中高", "高"] as RiskLevel[]).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="投資目標">
                    <select
                      value={form.investmentGoal}
                      onChange={(e) => setForm({ ...form, investmentGoal: e.target.value as InvestmentGoal })}
                      className={inputCls}
                    >
                      {(["退休規劃", "資產增值", "子女教育", "現金流", "其他"] as InvestmentGoal[]).map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label="備註">
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="客戶偏好、特殊需求等備註..."
                    rows={3}
                    className={`${inputCls} resize-none`}
                  />
                </Field>

              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={handleSubmit}
                  className="flex-1 bg-[#F5B700] hover:bg-[#e0a800] text-white py-3 rounded-lg font-bold text-[16px] transition-colors"
                >
                  {editingId ? "儲存變更" : "建立客戶"}
                </button>
                <button
                  onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="border border-white/20 text-slate-400 px-6 py-3 rounded-lg font-semibold text-[16px] hover:bg-white/[0.03] transition-colors"
                >
                  取消
                </button>
              </div>

            </div>
          </div>
        )}

        <div className="grid grid-cols-[380px_1fr] gap-8">

          {/* CLIENT LIST */}
          <div className="flex flex-col gap-3">
            {filtered.length === 0 && (
              <div className="text-center text-slate-400 py-16 border border-white/10 rounded-2xl">
                {search ? "找不到符合的客戶" : "尚未建立任何客戶"}
              </div>
            )}

            {filtered.map((client) => (
              <div
                key={client.id}
                onClick={() => setSelectedId(client.id)}
                className={`border rounded-2xl p-5 cursor-pointer transition-all ${
                  selectedId === client.id
                    ? "border-[#F5B700] bg-[#F5B700]/5"
                    : "border-white/10 hover:border-white/20"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[18px] font-bold text-white">
                      {client.name}
                    </div>
                    <div className="text-[14px] text-slate-400 mt-1">
                      {client.age ? `${client.age}歲・` : ""}{client.investmentGoal}
                    </div>
                  </div>

                  {client.personality ? (
                    <span
                      className="text-[12px] font-bold px-2.5 py-1 rounded-full text-white"
                      style={{ backgroundColor: PERSONALITY_COLORS[client.personality] }}
                    >
                      {PERSONALITY_LABELS[client.personality]}
                    </span>
                  ) : (
                    <span className="text-[12px] text-slate-400 border border-white/10 px-2.5 py-1 rounded-full">
                      未測驗
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 mt-3">
                  <span className="text-[13px] text-slate-400">
                    風險：{client.riskLevel}
                  </span>
                  {client.phone && (
                    <span className="text-[13px] text-slate-400">
                      {client.phone}
                    </span>
                  )}
                </div>

                <div className="text-[12px] text-slate-300 mt-2">
                  建立 {new Date(client.createdAt).toLocaleDateString("zh-TW")}
                </div>
              </div>
            ))}
          </div>

          {/* CLIENT DETAIL */}
          <div>
            {selectedClient ? (
              <div className="border border-white/10 rounded-2xl p-8">

                <div className="flex items-start justify-between mb-6">
                  <div>
                    <h2 className="text-[32px] font-black text-white">
                      {selectedClient.name}
                    </h2>
                    <p className="text-[15px] text-slate-400 mt-1">
                      {selectedClient.age ? `${selectedClient.age}歲・` : ""}
                      {selectedClient.investmentGoal}・
                      風險承受度：{selectedClient.riskLevel}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEdit(selectedClient)}
                      className="border border-white/20 text-slate-400 px-4 py-2 rounded-lg text-[14px] hover:bg-white/[0.03] transition-colors"
                    >
                      編輯
                    </button>
                    <button
                      onClick={() => handleDelete(selectedClient.id)}
                      className="border border-red-200 text-red-500 px-4 py-2 rounded-lg text-[14px] hover:bg-red-50 transition-colors"
                    >
                      刪除
                    </button>
                  </div>
                </div>

                {/* Contact */}
                {(selectedClient.phone || selectedClient.email) && (
                  <div className="bg-white/[0.03] rounded-xl p-4 mb-6 flex gap-6">
                    {selectedClient.phone && (
                      <div>
                        <div className="text-[12px] text-slate-400 mb-0.5">電話</div>
                        <div className="text-[15px] text-white">{selectedClient.phone}</div>
                      </div>
                    )}
                    {selectedClient.email && (
                      <div>
                        <div className="text-[12px] text-slate-400 mb-0.5">Email</div>
                        <div className="text-[15px] text-white">{selectedClient.email}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Personality Analysis */}
                <div className="bg-[#0B1220] rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-white text-[18px] font-bold">
                      投資人格分析
                    </div>
                    <Link
                      href={`/quiz?clientId=${selectedClient.id}`}
                      className="bg-[#F5B700] hover:bg-[#e0a800] text-white px-4 py-2 rounded-lg text-[14px] font-bold transition-colors"
                    >
                      {selectedClient.personality ? "重新測驗" : "開始測驗"}
                    </Link>
                  </div>

                  {selectedClient.personality ? (
                    <div className="flex items-center gap-4">
                      <span
                        className="text-white text-[28px] font-black px-4 py-2 rounded-xl"
                        style={{ backgroundColor: PERSONALITY_COLORS[selectedClient.personality] }}
                      >
                        {PERSONALITY_LABELS[selectedClient.personality]}
                      </span>
                      {selectedClient.personalityScore && (
                        <div>
                          <div className="text-slate-400 text-[13px]">測驗分數</div>
                          <div className="text-white text-[22px] font-bold">
                            {selectedClient.personalityScore} 分
                          </div>
                        </div>
                      )}
                      <div className="ml-auto flex items-center gap-3">
                        <Link
                          href={`/report?type=${selectedClient.personality}&client=${encodeURIComponent(selectedClient.name)}`}
                          className="text-[#F5B700] text-[14px] hover:underline"
                        >
                          查看分析結果 →
                        </Link>
                        <button
                          onClick={() => {
                            const url = `/report?type=${selectedClient.personality}&client=${encodeURIComponent(selectedClient.name)}`;
                            const win = window.open(url, "_blank");
                            if (win) {
                              win.addEventListener("load", () => {
                                setTimeout(() => win.print(), 800);
                              });
                            }
                          }}
                          className="bg-[#0B1220] hover:bg-slate-700 text-white text-[13px] px-3 py-1.5 rounded-lg font-semibold transition-colors"
                        >
                          ⬇ 匯出PDF
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-slate-400 text-[15px]">
                      尚未進行投資人格分析，點選右側「開始測驗」
                    </p>
                  )}
                </div>

                {/* Notes */}
                {selectedClient.notes && (
                  <div className="border border-white/10 rounded-xl p-5 mb-6">
                    <div className="text-[14px] font-semibold text-slate-400 mb-2">備註</div>
                    <p className="text-[15px] text-white whitespace-pre-wrap">
                      {selectedClient.notes}
                    </p>
                  </div>
                )}

                {/* Meeting Records */}
                <div>
                  <div className="text-[18px] font-bold text-white mb-4">
                    會議紀錄
                    <span className="text-[14px] font-normal text-slate-400 ml-2">
                      （{selectedClient.meetings.length} 筆）
                    </span>
                  </div>

                  <div className="flex gap-3 mb-4">
                    <textarea
                      value={meetingInput}
                      onChange={(e) => setMeetingInput(e.target.value)}
                      placeholder="記錄今日與客戶的討論重點、關切事項..."
                      rows={2}
                      className="flex-1 border border-white/20 rounded-lg px-4 py-3 text-[15px] focus:outline-none focus:border-[#F5B700] resize-none"
                    />
                    <button
                      onClick={handleAddMeeting}
                      className="bg-[#0B1220] hover:bg-slate-800 text-white px-5 py-3 rounded-lg font-semibold text-[14px] transition-colors self-end"
                    >
                      新增紀錄
                    </button>
                  </div>

                  <div className="flex flex-col gap-3">
                    {[...selectedClient.meetings].reverse().map((m) => (
                      <div
                        key={m.id}
                        className="border border-white/10 rounded-xl p-4 flex items-start justify-between gap-4"
                      >
                        <div>
                          <div className="text-[13px] text-slate-400 mb-1">{m.date}</div>
                          <p className="text-[15px] text-white whitespace-pre-wrap">
                            {m.content}
                          </p>
                        </div>
                        <button
                          onClick={() => handleDeleteMeeting(selectedClient.id, m.id)}
                          className="text-slate-300 hover:text-red-400 text-[13px] shrink-0 transition-colors"
                        >
                          刪除
                        </button>
                      </div>
                    ))}

                    {selectedClient.meetings.length === 0 && (
                      <p className="text-slate-400 text-[15px] text-center py-6">
                        尚無會議紀錄
                      </p>
                    )}
                  </div>
                </div>

              </div>
            ) : (
              <div className="border border-white/10 rounded-2xl flex items-center justify-center h-[400px] text-slate-400 text-[16px]">
                ← 點選左側客戶查看詳細資料
              </div>
            )}
          </div>

        </div>

        <div className="flex justify-center mt-12">
          <Link
            href="/"
            className="border border-white/20 text-white px-10 py-4 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[18px]"
          >
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}

const inputCls =
  "w-full border border-white/20 rounded-lg px-4 py-2.5 text-[15px] text-white focus:outline-none focus:border-[#F5B700]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[13px] font-semibold text-slate-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}