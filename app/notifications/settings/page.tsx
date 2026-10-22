'use client';
import {useEffect,useState} from 'react';

type Kind='STOCK'|'ETF'|'FUND'|'PERSON';
type Asset={canonicalId:string;displayName:string;symbolOrCode:string};
type Rule={id:string;assetType:string;canonicalAssetId:string;status:string};
type Settings={enabled:boolean;preferences:{flip:boolean;watchlist_only:boolean;people:string[]};symbols:string[];people:{id:string;name:string}[]};
const labels:Record<Kind,string>={STOCK:'股票',ETF:'ETF',FUND:'基金',PERSON:'大佬／重要人物'};
async function call(path:string,body?:unknown,method='POST') {
  const response=await fetch(path,{method:body===undefined?'GET':method,cache:'no-store',credentials:'include',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const payload=await response.json();if(!response.ok)throw Error(response.status===401?'LOGIN':'REQUEST_FAILED');return payload;
}
export default function NotificationSettingsPage(){
  const [iid,setIid]=useState(''),[kind,setKind]=useState<Kind>('STOCK');
  const [settings,setSettings]=useState<Settings|null>(null),[people,setPeople]=useState<string[]>([]),[enabled,setEnabled]=useState(false);
  const [login,setLogin]=useState(false),[rules,setRules]=useState<Rule[]>([]),[text,setText]=useState(''),[assets,setAssets]=useState<Asset[]>([]),[selected,setSelected]=useState<Asset|null>(null);
  const [threshold,setThreshold]=useState(''),[operator,setOperator]=useState('ABOVE'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const id=params.get('installation_id')??localStorage.getItem('smc_iid')??`smc_${crypto.randomUUID().replaceAll('-','')}`;
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(id)){setError('通知設定連結無效');return;}
    const requested=params.get('type');if(requested&&requested in labels)setKind(requested as Kind);
    localStorage.setItem('smc_iid',id);setIid(id);let active=true;
    call(`/api/consensus/push/register?installation_id=${encodeURIComponent(id)}`).then((p:Settings)=>{if(active){setSettings(p);setPeople(p.preferences.people);setEnabled(p.enabled);}}).catch(()=>{if(active)setError('通知設定暫時無法取得，請稍後再試。');});
    call('/api/alerts').then(p=>{if(active)setRules(p.data);}).catch(e=>{if(active){if(e.message==='LOGIN')setLogin(true);else setError('通知設定暫時無法取得，請稍後再試。');}});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    setSelected(null);setAssets([]);if(kind==='PERSON'||text.trim().length<2)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>{fetch(`/api/search?q=${encodeURIComponent(text.trim())}&type=${kind}&limit=10`,{signal:controller.signal}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(p=>setAssets(p.data??[])).catch(e=>{if(e.name!=='AbortError')setError('搜尋暫時無法取得，請稍後再試。');});},300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[text,kind]);
  const linkInstallation=async(next:Settings)=>{await call('/api/consensus/push/register',{installation_id:iid,platform:'web',notifications_enabled:next.enabled,preferences:next.preferences,symbols:next.symbols});setSettings(next);};
  const save=async()=>{
    if(!settings||busy)return;setBusy(true);setError('');setNotice('');
    try{
      if(kind==='PERSON'){
        if(enabled&&!people.length)throw Error('PERSON_REQUIRED');
        await linkInstallation({...settings,enabled,preferences:{...settings.preferences,flip:true,watchlist_only:true,people}});
      }else{
        if(!selected||!Number.isFinite(Number(threshold))||threshold.trim()==='')throw Error('VALUE_REQUIRED');
        await linkInstallation(settings);
        await call('/api/alerts',{ruleFamily:kind==='FUND'?'ETF_FUND':'PRICE_VALUE',frequency:'RECURRING',cadence:'DAILY',deliveryChannels:['IN_APP'],parameters:{logic:'AND',conditions:[{id:'value',assetId:selected.canonicalId,assetType:kind,metric:kind==='FUND'?'NAV':'PRICE',operator,threshold:Number(threshold)}]}});
        setRules((await call('/api/alerts')).data);
      }
      setNotice('通知設定已儲存，可返回 App 通知中心。');
    }catch(e){const message=e instanceof Error?e.message:'';setError(message==='PERSON_REQUIRED'?'請選擇至少一位重要人物。':message==='VALUE_REQUIRED'?'請選擇商品並輸入有效數值。':message==='LOGIN'?'請先登入再設定股票、ETF 或基金通知。':'通知設定未儲存，請稍後再試。');}
    finally{setBusy(false);}
  };
  const toggleRule=async(rule:Rule)=>{setBusy(true);setError('');try{await call('/api/alerts',{id:rule.id,action:rule.status==='PAUSED'?'RESUME':'PAUSE'},'PATCH');setRules((await call('/api/alerts')).data);}catch{setError('通知設定未儲存，請稍後再試。');}finally{setBusy(false);}};
  return <main className="mx-auto min-h-screen max-w-2xl bg-slate-950 p-6 text-slate-100">
    <a href="https://tw-industry-radar.vercel.app" className="text-amber-300">返回 SmartMatch App</a><h1 className="my-5 text-2xl font-bold">設定我的通知</h1>
    <p className="mb-5 text-sm text-slate-300">收藏資料與通知設定分開保存。只提供已有後端支援的通知。</p>
    <div className="flex flex-wrap gap-2" aria-label="通知商品類型">{(Object.keys(labels) as Kind[]).map(k=><button key={k} onClick={()=>{setKind(k);setText('');setNotice('');}} aria-pressed={kind===k} className={`rounded border p-2 ${kind===k?'border-amber-300 text-amber-300':'border-slate-600'}`}>{labels[k]}</button>)}</div>
    {error&&<p role="alert" className="my-4 text-red-300">{error}</p>}{notice&&<p role="status" className="my-4 text-emerald-300">{notice}</p>}
    {!settings?<p className="my-4">載入通知設定中…</p>:kind==='PERSON'?<section className="my-5 space-y-3">
      <p>重要人物對股票的觀點翻多／翻空時通知；不包含未支援的持股異動通知。</p>
      <label className="block"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> 啟用觀點翻轉通知</label>
      <div className="grid grid-cols-2 gap-3">{settings.people.map(p=><label key={p.id}><input type="checkbox" checked={people.includes(p.id)} onChange={e=>setPeople(v=>e.target.checked?[...v,p.id]:v.filter(id=>id!==p.id))}/> {p.name}</label>)}</div>
      <button disabled={busy} onClick={save} className="rounded bg-amber-300 px-5 py-2 text-slate-950 disabled:opacity-50">{busy?'儲存中…':'儲存通知設定'}</button>
    </section>:login?<section className="my-6"><p>股票、ETF、基金通知使用你的既有 SmartMatch 帳號。</p><a className="mt-4 inline-block rounded bg-amber-300 p-3 text-slate-950" href={`/auth/login?next=${encodeURIComponent(`/notifications/settings?installation_id=${iid}&type=${kind}`)}`}>登入並設定我的通知</a></section>:<section className="my-5 space-y-4">
      <label className="block">搜尋{labels[kind]}<input className="mt-2 block w-full rounded border border-slate-600 bg-slate-900 p-2" value={text} onChange={e=>setText(e.target.value)} placeholder="輸入代碼或名稱"/></label>
      {assets.map(a=><button key={a.canonicalId} aria-pressed={selected?.canonicalId===a.canonicalId} className={`block w-full rounded border p-2 text-left ${selected?.canonicalId===a.canonicalId?'border-amber-300':'border-slate-600'}`} onClick={()=>setSelected(a)}>{a.symbolOrCode} {a.displayName}</button>)}
      <label className="block">{kind==='FUND'?'淨值':'價格'}條件 <select className="rounded bg-slate-800 p-2" value={operator} onChange={e=>setOperator(e.target.value)}><option value="ABOVE">高於</option><option value="BELOW">低於</option></select></label>
      <label className="block">設定數值<input type="number" step="any" value={threshold} onChange={e=>setThreshold(e.target.value)} className="ml-3 rounded border border-slate-600 bg-slate-900 p-2"/></label>
      <p className="text-sm text-slate-300">使用既有警示引擎檢查；符合條件時顯示於通知中心。</p>
      <button disabled={busy||!selected} onClick={save} className="rounded bg-amber-300 px-5 py-2 text-slate-950 disabled:opacity-50">{busy?'儲存中…':'儲存通知設定'}</button>
    </section>}
    {rules.length>0&&<section className="mt-8"><h2 className="text-lg font-bold">已設定商品通知</h2>{rules.map(r=><div key={r.id} className="my-3 flex items-center gap-4 border-b border-slate-700 pb-3"><span>{labels[r.assetType as Kind]??r.assetType} {r.canonicalAssetId}</span><button disabled={busy} onClick={()=>toggleRule(r)} className="ml-auto text-amber-300">{r.status==='PAUSED'?'恢復通知':'暫停通知'}</button></div>)}</section>}
  </main>;
}
