import { ASSETS, OPINIONS, type Opinion, getAsset, getPerson } from "./mockData";
import { AssetChip, ClickableCard, DirectionTag, Eyebrow, FlipTag, MockDisclaimer, Note, PersonIdentity, Row, SectionTitle, relativeTimeZh } from "./ui";

// 大佬雷達首頁 V1 — Mobile-first（App 內頁面），單欄，全部 mock data，未接任何後端。三個固定區塊：
//   1. 今天誰改變看法？（最多 3 張直式卡，翻轉優先，不足時補重大方向延續）
//   2. 今天大家在看什麼？（最多 5 個單列共識項目）
//   3. 最新重要觀點（最多 5 張單欄卡，與 1 不重複，不一定翻轉）
export function ConsensusRadarHome() {
  const seenPersons = new Set<string>();
  const showEnglishOnce = (personId: string) => {
    if (seenPersons.has(personId)) return false;
    seenPersons.add(personId);
    return true;
  };

  const now = Date.now();
  const isToday = (iso: string) => now - new Date(iso).getTime() < 24 * 60 * 60 * 1000;
  const sorted = [...OPINIONS].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  // 1. 今天誰改變看法：今天的翻轉優先；不足 3 則用今天「非中性」的重大方向延續補滿。
  const todaysFlips = sorted.filter((o) => o.isFlip && isToday(o.publishedAt));
  const todaysStrongContinuations = sorted.filter((o) => !o.isFlip && o.direction !== "NEUTRAL" && isToday(o.publishedAt));
  const changeCards: Opinion[] = [...todaysFlips];
  for (const o of todaysStrongContinuations) {
    if (changeCards.length >= 3) break;
    if (!changeCards.some((c) => c.id === o.id)) changeCards.push(o);
  }
  const sectionA = changeCards.slice(0, 3);
  const sectionAIds = new Set(sectionA.map((o) => o.id));

  // 2. 今天大家在看什麼：依今天提及次數排序，取前 5 檔，附多/中/空與近 7 天淨變化。
  const todaysOpinions = sorted.filter((o) => isToday(o.publishedAt));
  const mentionCount = new Map<string, number>();
  for (const o of todaysOpinions) for (const code of o.assetCodes) mentionCount.set(code, (mentionCount.get(code) ?? 0) + 1);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const hotAssets = [...mentionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code]) => {
      const assetOpinions = sorted.filter((o) => o.assetCodes.includes(code));
      const latestByPerson = new Map<string, Opinion>();
      for (const o of assetOpinions) if (!latestByPerson.has(o.personId)) latestByPerson.set(o.personId, o);
      const stances = [...latestByPerson.values()];
      const bullish = stances.filter((o) => o.direction === "BULLISH").length;
      const neutral = stances.filter((o) => o.direction === "NEUTRAL").length;
      const bearish = stances.filter((o) => o.direction === "BEARISH").length;
      const last7 = assetOpinions.filter((o) => new Date(o.publishedAt).getTime() >= sevenDaysAgo && o.isFlip);
      const net = last7.filter((o) => o.direction === "BULLISH").length - last7.filter((o) => o.direction === "BEARISH").length;
      const changeLabel = net > 0 ? `近7天 +${net} 轉多` : net < 0 ? `近7天 ${net} 轉空` : "近7天持平";
      return { asset: getAsset(code)!, bullish, neutral, bearish, changeLabel };
    });

  // 3. 最新重要觀點：排除已出現在 1 的那幾則，取最新 5 則（不限翻轉）。
  const sectionC = sorted.filter((o) => !sectionAIds.has(o.id)).slice(0, 5);

  return (
    <div>
      <Eyebrow>大佬雷達</Eyebrow>
      <h1 className="mt-1 text-[22px] font-black leading-tight">今日市場重要觀點</h1>
      <p className="mt-1.5 text-[12.5px] leading-5 text-slate-400">追蹤關鍵人物與機構最新看法、方向變化與市場共識</p>
      <MockDisclaimer />

      <SectionTitle right="查看全部 >">今天誰改變看法？</SectionTitle>
      {sectionA.length === 0 ? (
        <Note>今天目前還沒有明顯的方向改變。</Note>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sectionA.map((o) => {
            const person = getPerson(o.personId)!;
            const asset = getAsset(o.assetCodes[0])!;
            return (
              <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-3.5">
                <PersonIdentity person={person} showEnglish={showEnglishOnce(person.id)} />
                <div className="mt-2.5 flex items-center justify-between">
                  <AssetChip code={asset.code} nameZh={asset.nameZh} />
                  <div className="flex items-center gap-2">
                    <DirectionTag direction={o.direction} />
                    {o.isFlip ? <FlipTag /> : null}
                  </div>
                </div>
                <p className="mt-2 text-[13px] leading-5 text-slate-300">{o.reason}</p>
                <p className="mt-2.5 border-t border-white/[0.06] pt-2 text-[11px] text-slate-500">
                  {relativeTimeZh(o.publishedAt)}｜{o.sourceLabel}
                </p>
              </ClickableCard>
            );
          })}
        </div>
      )}

      <SectionTitle right="查看全部 >">今天大家在看什麼？</SectionTitle>
      {hotAssets.length === 0 ? (
        <Note>今天目前還沒有標的被多次談論。</Note>
      ) : (
        <CompactList>
          {hotAssets.map(({ asset, bullish, neutral, bearish, changeLabel }) => (
            <ClickableCard key={asset.code} href={`/consensus-radar/assets/${asset.code}`} className="rounded-none">
              <Row>
                <div className="flex items-center justify-between gap-2">
                  <AssetChip code={asset.code} nameZh={asset.nameZh} />
                  <span className="shrink-0 text-[11.5px] text-slate-400">
                    <span className="text-emerald-300">多{bullish}</span>・<span className="text-slate-400">中{neutral}</span>・
                    <span className="text-rose-300">空{bearish}</span>
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{changeLabel}</p>
              </Row>
            </ClickableCard>
          ))}
        </CompactList>
      )}

      <SectionTitle right="查看全部 >">最新重要觀點</SectionTitle>
      {sectionC.length === 0 ? (
        <Note>目前沒有更多觀點。</Note>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sectionC.map((o) => {
            const person = getPerson(o.personId)!;
            const asset = getAsset(o.assetCodes[0])!;
            return (
              <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <PersonIdentity person={person} showEnglish={showEnglishOnce(person.id)} />
                  <DirectionTag direction={o.direction} />
                </div>
                <div className="mt-2">
                  <AssetChip code={asset.code} nameZh={asset.nameZh} />
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-slate-300">{o.reason}</p>
                <p className="mt-2 border-t border-white/[0.06] pt-2 text-[11px] text-slate-500">
                  {relativeTimeZh(o.publishedAt)}｜{o.sourceLabel}
                </p>
              </ClickableCard>
            );
          })}
        </div>
      )}

      <p className="mt-5 text-[11px] text-slate-600">共追蹤 {ASSETS.length} 檔標的。</p>
    </div>
  );
}

// 第二區用「無縫列表」而非個別卡片間距，視覺上更緊湊。
function CompactList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-[14px] divide-y divide-white/[0.05]">{children}</div>;
}
