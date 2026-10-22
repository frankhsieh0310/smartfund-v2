import { ASSETS, type Person, getAsset, opinionsForPerson } from "./mockData";
import { AssetChip, Card, ClickableCard, DirectionTag, Eyebrow, FlipTag, MockDisclaimer, Note, Row, SectionTitle, relativeTimeZh } from "./ui";

// 人物頁 V1：中文姓名＋英文姓名、公司／機構、職稱、目前觀點、最近是否翻轉、觀點時間軸、原始來源。
// 不放人物照片、不放 Q 版、不做人物百科介紹。全部 mock data。
export function PersonProfile({ person }: { person: Person }) {
  const opinions = opinionsForPerson(person.id); // 已依時間新到舊排序

  // 目前觀點：每個標的只取該人物最新一筆。
  const currentStanceByAsset = new Map<string, (typeof opinions)[number]>();
  for (const o of opinions) {
    for (const code of o.assetCodes) {
      if (!currentStanceByAsset.has(code)) currentStanceByAsset.set(code, o);
    }
  }
  const currentStances = [...currentStanceByAsset.values()];
  const latestFlip = opinions.find((o) => o.isFlip);

  return (
    <div>
      <Eyebrow>大佬雷達・人物</Eyebrow>
      <h1 className="mt-2 text-[26px] font-black text-[#f7f3e8]">
        {person.nameZh}
        <span className="ml-2 text-[14px] font-normal text-slate-500">{person.nameEn}</span>
      </h1>
      <p className="mt-1 text-[13px] text-slate-400">{person.org}・{person.title}</p>
      <MockDisclaimer />

      <SectionTitle>目前觀點</SectionTitle>
      {currentStances.length === 0 ? (
        <Note>目前沒有收錄到這位人物的觀點。</Note>
      ) : (
        <Card>
          {currentStances.map((o) => {
            const asset = getAsset(o.assetCodes[0])!;
            return (
              <Row key={asset.code}>
                <div className="flex flex-wrap items-center gap-3">
                  <AssetChip code={asset.code} nameZh={asset.nameZh} href={`/consensus-radar/assets/${asset.code}`} />
                  <DirectionTag direction={o.direction} />
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-slate-300">{o.reason}</p>
              </Row>
            );
          })}
        </Card>
      )}

      <SectionTitle>最近是否翻轉</SectionTitle>
      {latestFlip ? (
        <Note>
          有。最近一次翻轉是針對 {getAsset(latestFlip.assetCodes[0])?.nameZh}，於 {relativeTimeZh(latestFlip.publishedAt)}
          轉為「{latestFlip.direction === "BULLISH" ? "偏多" : latestFlip.direction === "BEARISH" ? "偏空" : "中性"}」，理由：{latestFlip.reason}
        </Note>
      ) : (
        <Note>目前收錄的發言中，沒有觀察到明確翻轉。</Note>
      )}

      <SectionTitle>觀點時間軸</SectionTitle>
      <div className="flex flex-col gap-3">
        {opinions.map((o) => {
          const asset = getAsset(o.assetCodes[0])!;
          return (
            <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-500">{relativeTimeZh(o.publishedAt)}</span>
                <AssetChip code={asset.code} nameZh={asset.nameZh} />
                <DirectionTag direction={o.direction} />
                {o.isFlip ? <FlipTag /> : null}
              </div>
              <p className="mt-1.5 text-[13px] leading-5 text-slate-300">{o.reason}</p>
              <p className="mt-2 border-t border-white/[0.06] pt-2 text-[11px] text-slate-500">原始來源：{o.sourceLabel}</p>
            </ClickableCard>
          );
        })}
      </div>

      <p className="mt-5 text-[11px] leading-5 text-slate-600">追蹤標的共 {ASSETS.length} 項。</p>
    </div>
  );
}
