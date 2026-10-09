import { notFound } from "next/navigation";
import { OpinionDetail } from "@/components/consensus-radar/OpinionDetail";
import { getOpinion } from "@/components/consensus-radar/mockData";
import { PageShell } from "@/components/consensus-radar/ui";

export default async function OpinionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opinion = getOpinion(id);
  if (!opinion) return notFound();
  return (
    <PageShell>
      <OpinionDetail opinion={opinion} />
    </PageShell>
  );
}
