"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { HomeRankData, HomeRankGroup, HomeRankItem } from "@/lib/web/home-ranking-types";

type MarketKey="STOCK"|"ETF"|"FUND"|"INDEX"|"MACRO"|"COMMODITY"|"CRYPTO";
const STORAGE_KEY="smartmatch-home-market-focus";
const DEFAULT_MARKETS:MarketKey[]=["STOCK","ETF","FUND"];
const OPTIONS:Array<{key:MarketKey;label:string;implemented:boolean}>=[
 {key:"STOCK",label:"台股",implemented:true},{key:"ETF",label:"ETF",implemented:true},{key:"FUND",label:"基金",implemented:true},
 {key:"INDEX",label:"指數",implemented:false},{key:"MACRO",label:"總體經濟",implemented:false},{key:"COMMODITY",label:"大宗商品",implemented:false},{key:"CRYPTO",label:"虛擬貨幣",implemented:false},
];

const number=(value:number|null)=>value==null?"—":new Intl.NumberFormat("zh-TW",{maximumFractionDigits:2}).format(value);
const metric=(item:HomeRankItem)=>item.metric==null?"—":`${item.metric>0?"+":""}${item.metric.toFixed(1)}%`;
const dateZh=(value:string|null)=>value?value.slice(0,10).replaceAll("-","/"):"未提供";

function RankRow({item}:{item:HomeRankItem}){const positive=(item.metric??0)>=0;return <Link href={item.href} className="grid h-[25px] grid-cols-[minmax(0,1fr)_104px_54px] items-center gap-2 text-[12px] hover:bg-white/[0.025]"><strong className="min-w-0 truncate text-[13px] text-[#f7f5ef]">{item.name}</strong><span className="text-right tabular-nums text-slate-200">{number(item.value)}</span><b className={`text-right tabular-nums ${positive?"text-emerald-400":"text-rose-400"}`}>{metric(item)}</b></Link>}

function FocusCard({kind,group}:{kind:MarketKey;group:HomeRankGroup}){const isFund=kind==="FUND";const href=kind==="STOCK"?"/search?type=STOCK":kind==="ETF"?"/etf":"/fund";return <article className="h-[190px] overflow-hidden rounded-[12px] border border-white/[0.12] bg-[linear-gradient(145deg,rgba(22,40,57,.94),rgba(12,28,43,.96))] px-4 py-3"><div className="flex items-start justify-between"><div className="min-w-0"><h3 className="truncate text-[16px] font-black"><span className={`mr-2 ${kind==="STOCK"?"text-sky-400":kind==="ETF"?"text-emerald-400":"text-violet-400"}`}>♕</span>{isFund?"基金近1年績效前五大":group.label}</h3>{isFund?<p className="mt-0.5 pl-7 text-[11px] text-slate-400">資料截至 {dateZh(group.asOfDate)}<span className="mx-1">・</span>納入 {new Intl.NumberFormat("zh-TW").format(group.comparableCount??0)} 檔</p>:<p className="mt-0.5 pl-7 text-[11px] text-slate-400">資料截至 {dateZh(group.asOfDate)}</p>}</div><Link href={href} className="shrink-0 pt-0.5 text-[11px] text-slate-400 hover:text-[#f5b700]">查看全部 →</Link></div><div className="mt-2 border-t border-white/[0.08] pt-1">{group.items.slice(0,5).map((item)=><RankRow key={item.id} item={item}/>)}</div></article>}

export function HomeRankingPanels({data}:{data:HomeRankData}){
 const groups=useMemo<Record<"STOCK"|"ETF"|"FUND",HomeRankGroup>>(()=>({STOCK:data.stocks.primary,ETF:data.etfs.primary,FUND:data.funds.primary}),[data]);
 const actuallyAvailable=useMemo(()=>new Set<MarketKey>(DEFAULT_MARKETS.filter(key=>groups[key].items.length>0)),[groups]);
 const [selected,setSelected]=useState<MarketKey[]>(DEFAULT_MARKETS);
 const [notice,setNotice]=useState("");
 useEffect(()=>{try{const raw=localStorage.getItem(STORAGE_KEY);if(!raw)return;const parsed=JSON.parse(raw) as MarketKey[];const valid=parsed.filter(key=>actuallyAvailable.has(key)).slice(0,5);if(valid.length)Promise.resolve().then(()=>setSelected(valid))}catch{/* keep defaults */}},[actuallyAvailable]);
 const visible=selected.filter(key=>actuallyAvailable.has(key));
 const toggle=(key:MarketKey)=>{if(!actuallyAvailable.has(key))return;setSelected(current=>{if(current.includes(key)){if(current.length===1){setNotice("至少需顯示 1 個市場");return current}const next=current.filter(value=>value!==key);localStorage.setItem(STORAGE_KEY,JSON.stringify(next));setNotice("");return next}if(current.length>=5){setNotice("最多可顯示 5 個市場");return current}const next=[...current,key];localStorage.setItem(STORAGE_KEY,JSON.stringify(next));setNotice("");return next})};
 const grid=visible.length===1?"grid-cols-1":visible.length===2?"grid-cols-1 md:grid-cols-2":"grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
 return <div><div className="mb-2 flex items-center justify-between"><h2 className="text-[25px] font-black">我的排行榜</h2><details className="relative"><summary className="cursor-pointer list-none rounded-lg border border-[#b58c4a] px-3 py-1.5 text-[12px] font-bold text-[#e9bb62]">切換市場</summary><div className="absolute right-0 top-10 z-40 w-56 rounded-xl border border-[#3b5870] bg-[#0a2033] p-3 shadow-2xl">{OPTIONS.map(option=>{const enabled=option.implemented&&actuallyAvailable.has(option.key);return <label key={option.key} className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[13px] ${enabled?"cursor-pointer hover:bg-white/5":"cursor-not-allowed text-slate-500"}`}><span className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(option.key)} disabled={!enabled} onChange={()=>toggle(option.key)} className="accent-[#e7b75e]"/>{option.label}</span>{!enabled?<small>資料準備中</small>:null}</label>})}{notice?<p className="mt-2 border-t border-white/10 pt-2 text-[12px] text-[#f0bf65]">{notice}</p>:null}</div></details></div><div className={`grid gap-5 ${grid}`}>{visible.map(key=><FocusCard key={key} kind={key} group={groups[key]}/>)}</div></div>
}

export function HomeRankingLoader(){const [data,setData]=useState<HomeRankData|null>(null);const [failed,setFailed]=useState(false);useEffect(()=>{const controller=new AbortController();fetch("/api/home-rankings",{cache:"no-store",signal:controller.signal}).then(r=>r.ok?r.json():Promise.reject()).then(setData).catch(error=>{if(error?.name!=="AbortError")setFailed(true)});return()=>controller.abort()},[]);if(failed)return null;return data?<HomeRankingPanels data={data}/>:<div><h2 className="mb-2 text-[25px] font-black">我的排行榜</h2><div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">{DEFAULT_MARKETS.map(key=><div key={key} className="h-[190px] animate-pulse rounded-[12px] border border-white/[0.08] bg-[#0c1c2b]"/>)}</div></div>}
