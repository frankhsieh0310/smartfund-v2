import { FUND_HOLDERS, type Asset, getPerson, opinionsForAsset } from "./mockData";
import { Card, ClickableCard, DirectionTag, Eyebrow, FlipTag, MockDisclaimer, Note, PersonIdentity, Row, SectionTitle, relativeTimeZh } from "./ui";

// 標的共識頁 V1：多/中/空、近 7 天變化、最近轉多/轉空、最新觀點、持有該標的的基金/ETF。
// 不做複雜 chart，全部文字與簡單數字呈現。全部 mock data。
export function AssetConsensus({ asset }: { asset: Asset }) {
  const opinions = opinionsForAsset(asset.code); // 新到舊

  // 多/中/空：每位人物只取對這個標的的最新一筆觀點。
  const latestByPerson = new Map<string, (typeof opinions)[number]>();
  for (const o of opinions) {
    if (!latestByPerson.has(o.personId)) latestByPerson.set(o.personId, o);
  }
  const stances = [...latestByPerson.values()];
  const bullish = stances.filter((o) => o.direction === "BULLISH").length;
  const neutral = stances.filter((o) => o.direction === "NEUTRAL").length;
  const bearish = stances.filter((o) => o.direction === "BEARISH").length;

  // 近 7 天變化：每天有幾則新觀點、方向分布，純文字列表，不用圖表。
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last7Days = opinions.filter((o) => new Date(o.publishedAt).getTime() >= sevenDaysAgo);
  const byDay = new Map<string, { bullish: number; neutral: number; bearish: number }>();
  for (const o of last7Days) {
    const day = new Date(o.publishedAt).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { bullish: 0, neutral: 0, bearish: 0 };
    if (o.direction === "BULLISH") bucket.bullish++;
    else if (o.direction === "BEARISH") bucket.bearish++;
    else bucket.neutral++;
    byDay.set(day, bucket);
  }
  const dayRows = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const recentFlips = opinions.filter((o) => o.isFlip);
  const fundHolders = FUND_HOLDERS[asset.code] ?? [];

  return (
    <div>
      <Eyebrow>大佬雷達・標的共識</Eyebrow>
      <h1 className="mt-2 text-[26px] font-black">
        {asset.nameZh}
        <span className="ml-2 text-[14px] font-normal text-slate-500">{asset.code}</span>
      </h1>
      <MockDisclaimer />

      <SectionTitle>多／中／空</SectionTitle>
      {stances.length === 0 ? (
        <Note>目前沒有收錄到針對這個標的的觀點。</Note>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-4 text-center">
            <p className="text-[22px] font-black text-emerald-300">{bullish}</p>
            <p className="mt-1 text-[12px] text-slate-500">偏多人數</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-[22px] font-black text-slate-200">{neutral}</p>
            <p className="mt-1 text-[12px] text-slate-500">中性人數</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-[22px] font-black text-rose-300">{bearish}</p>
            <p className="mt-1 text-[12px] text-slate-500">偏空人數</p>
          </Card>
        </div>
      )}

      <SectionTitle>近 7 天變化</SectionTitle>
      {dayRows.length === 0 ? (
        <Note>近 7 天內沒有新觀點。</Note>
      ) : (
        <Card>
          {dayRows.map(([day, b]) => (
            <Row key={day} className="flex items-center justify-between">
              <span className="text-slate-300">{day}</span>
              <span className="text-[12px] text-slate-500">
                偏多 {b.bullish}・中性 {b.neutral}・偏空 {b.bearish}
              </span>
            </Row>
          ))}
        </Card>
      )}

      <SectionTitle>最近轉多／轉空</SectionTitle>
      {recentFlips.length === 0 ? (
        <Note>最近沒有人針對這個標的翻轉方向。</Note>
      ) : (
        <div className="flex flex-col gap-3">
          {recentFlips.map((o) => {
            const person = getPerson(o.personId)!;
            return (
              <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <PersonIdentity person={person} showEnglish />
                  <div className="flex shrink-0 items-center gap-2">
                    <DirectionTag direction={o.direction} />
                    <FlipTag />
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">{relativeTimeZh(o.publishedAt)}</p>
              </ClickableCard>
            );
          })}
        </div>
      )}

      <SectionTitle>最新觀點</SectionTitle>
      <div className="flex flex-col gap-3">
        {opinions.map((o) => {
          const person = getPerson(o.personId)!;
          return (
            <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <PersonIdentity person={person} showEnglish />
                <DirectionTag direction={o.direction} />
              </div>
              <p className="mt-2 text-[13px] leading-5 text-slate-300">{o.reason}</p>
              <p className="mt-2 border-t border-white/[0.06] pt-2 text-[11px] text-slate-500">
                {relativeTimeZh(o.publishedAt)}｜{o.sourceLabel}
              </p>
            </ClickableCard>
          );
        })}
      </div>

      <SectionTitle>哪些基金／ETF持有該標的</SectionTitle>
      {fundHolders.length === 0 ? (
        <Note>目前沒有收錄持有這個標的的基金／ETF。</Note>
      ) : (
        <div className="flex flex-wrap gap-2">
          {fundHolders.map((f) => (
            <span key={f} className="rounded-lg bg-[#0c2137] px-3 py-1.5 text-[12px] text-slate-300">
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
