import Link from "next/link";

export default function NotFound() {
  return <main className="flex min-h-screen items-center justify-center bg-[#040a18] px-6 text-center text-white"><div><p className="text-xs font-bold tracking-[0.24em] text-[#F5B700]">FUND NOT FOUND</p><h1 className="mt-4 text-3xl font-black">找不到此基金</h1><p className="mt-3 text-sm text-slate-400">請確認基金代碼、ISIN 或識別碼是否正確。</p><Link href="/funds" className="mt-7 inline-flex rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/[0.06]">返回基金列表</Link></div></main>;
}
