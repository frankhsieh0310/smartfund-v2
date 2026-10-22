import { notFound } from "next/navigation";
import { PersonProfile } from "@/components/consensus-radar/PersonProfile";
import { getPerson } from "@/components/consensus-radar/mockData";
import { PageShell } from "@/components/consensus-radar/ui";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = getPerson(id);
  if (!person) return notFound();
  return (
    <PageShell>
      <PersonProfile person={person} />
    </PageShell>
  );
}
