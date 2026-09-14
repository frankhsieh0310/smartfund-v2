import Link from "next/link";
import { notFound } from "next/navigation";
import { getIndustryChain } from "@/lib/data-platform/industry-chain/queries";

const stages = ["UPSTREAM", "MIDSTREAM", "DOWNSTREAM", "UNSPECIFIED"] as const;
export default async function IndustryChainPage({ params }: { params: Promise<{ industry: string }> }) {
  const { industry } = await params;
  const chain = await getIndustryChain(decodeURIComponent(industry));
  if (!chain) notFound();
  return <main className="min-h-screen bg-[#07111f] px-6 py-12 text-white"><div className="mx-auto max-w-[1500px]"><Link href="/markets" className="text-sm text-[#F5B700]">← Markets</Link><h1 className="mt-5 text-4xl font-black">{chain.name}</h1><p className="mt-2 text-sm text-slate-400">Official Taiwan industry value chain</p><div className="mt-10 grid gap-5 xl:grid-cols-3">{stages.map((stage) => { const nodes=chain.nodes.filter((node)=>node.stage===stage); if (!nodes.length) return null; return <section key={stage} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="text-sm font-black tracking-wider text-[#F5B700]">{stage}</h2><div className="mt-5 space-y-4">{nodes.map((node)=><article key={node.id} className="rounded-xl border border-white/10 p-4"><h3 className="font-bold">{node.name}</h3><div className="mt-3 flex flex-wrap gap-2">{node.companies.map((company:any)=><Link key={`${node.id}-${company.name}`} href={company.symbol ? `/stocks/${encodeURIComponent(company.symbol)}` : "#"} aria-disabled={!company.symbol} className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-300 hover:text-white">{company.name}</Link>)}</div></article>)}</div></section>; })}</div></div></main>;
}
