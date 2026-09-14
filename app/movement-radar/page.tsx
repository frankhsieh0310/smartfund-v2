import { MovementRadar } from "@/components/movement-radar/MovementRadar";

export default function MovementRadarPage() {
  return (
    <main className="min-h-screen bg-[#061728] text-[#f7f3e8]">
      <div className="mx-auto max-w-[1380px] px-10 py-8">
        <MovementRadar />
      </div>
    </main>
  );
}
