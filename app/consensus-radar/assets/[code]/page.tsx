import { notFound } from "next/navigation";
import { AssetConsensus } from "@/components/consensus-radar/AssetConsensus";
import { getAsset } from "@/components/consensus-radar/mockData";
import { PageShell } from "@/components/consensus-radar/ui";

export default async function AssetPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const asset = getAsset(code);
  if (!asset) return notFound();
  return (
    <PageShell>
      <AssetConsensus asset={asset} />
    </PageShell>
  );
}
