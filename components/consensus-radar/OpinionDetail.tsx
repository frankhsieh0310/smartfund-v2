import { FUND_HOLDERS, DIRECTION_LABEL, type Opinion, getAsset, getPerson, opinionsForPerson, previousOpinionForSameAsset } from "./mockData";
import { AssetChip, Card, ClickableCard, DirectionTag, Eyebrow, FlipTag, MockDisclaimer, Note, PersonIdentity, SectionTitle, relativeTimeZh } from "./ui";

// 觀點詳情頁 V1：人物/機構、公司/職稱、標的、現在方向、上次方向、是否翻轉、核心理由、時間、來源、
// 原始來源連結位置、SmartMatch 相關基金/ETF 入口。全部 mock data。
export function OpinionDetail({ opinion }: { opinion: Opinion }) {
  const person = getPerson(opinion.personId)!;
  const assets = opinion.assetCodes.map((c) => getAsset(c)!);
  const primaryAsset = assets[0];
  const previous = previousOpinionForSameAsset(opinion);
  const fundHolders = FUND_HOLDERS[primaryAsset.code] ?? [];
  const otherOpinions = opinionsForPerson(person.id).filter((o) => o.id !== opinion.id).slice(0, 4);

  return (
    <div>
      <Eyebrow>大佬雷達・觀點詳情</Eyebrow>
      <MockDisclaimer />

      <Card className="mt-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PersonIdentity person={person} showEnglish href={`/consensus-radar/people/${person.id}`} size="lg" />
          <div className="text-right">
            <p className="text-[11px] text-slate-500">現在方向</p>
            <DirectionTag direction={opinion.direction} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {assets.map((a) => (
            <AssetChip key={a.code} code={a.code} nameZh={a.nameZh} href={`/consensus-radar/assets/${a.code}`} />
          ))}
        </div>

        <p className="mt-4 text-[15px] leading-7 text-slate-200">{opinion.reason}</p>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.08] pt-4 text-[12px] sm:grid-cols-4">
          <div>
            <p className="text-slate-500">上次方向</p>
            <p className="mt-0.5 font-semibold text-slate-300">{previous ? DIRECTION_LABEL[previous.direction] : "無先前紀錄"}</p>
          </div>
          <div>
            <p className="text-slate-500">是否翻轉</p>
            <p className="mt-0.5 font-semibold text-slate-300">{opinion.isFlip ? <FlipTag /> : "否"}</p>
          </div>
          <div>
            <p className="text-slate-500">時間</p>
            <p className="mt-0.5 font-semibold text-slate-300">{relativeTimeZh(opinion.publishedAt)}</p>
          </div>
          <div>
            <p className="text-slate-500">來源</p>
            <p className="mt-0.5 font-semibold text-slate-300">{opinion.sourceLabel}</p>
          </div>
        </div>

        {/* 原始來源連結位置 — V1 為版位預留，mock 階段無真實外部連結可接。 */}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-[#0a1d30] px-3 py-2.5 text-[12px]">
          <span className="text-slate-500">原始來源連結</span>
          <span className="text-slate-600">（版位預留，待接上真實來源後開放）</span>
        </div>
      </Card>

      <SectionTitle>SmartMatch 相關基金／ETF</SectionTitle>
      {fundHolders.length === 0 ? (
        <Note>目前沒有收錄持有 {primaryAsset.nameZh} 的基金／ETF。</Note>
      ) : (
        <div className="flex flex-wrap gap-2">
          {fundHolders.map((f) => (
            <span key={f} className="rounded-lg bg-[#0c2137] px-3 py-1.5 text-[12px] text-slate-300">
              {f}
            </span>
          ))}
        </div>
      )}

      <SectionTitle>{person.nameZh}的其他近期觀點</SectionTitle>
      {otherOpinions.length === 0 ? (
        <Note>目前沒有收錄這位人物的其他觀點。</Note>
      ) : (
        <div className="flex flex-col gap-3">
          {otherOpinions.map((o) => {
            const a = getAsset(o.assetCodes[0])!;
            return (
              <ClickableCard key={o.id} href={`/consensus-radar/opinions/${o.id}`} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <AssetChip code={a.code} nameZh={a.nameZh} />
                  <DirectionTag direction={o.direction} />
                  {o.isFlip ? <FlipTag /> : null}
                  <span className="text-[11px] text-slate-500">{relativeTimeZh(o.publishedAt)}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-slate-300">{o.reason}</p>
              </ClickableCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
