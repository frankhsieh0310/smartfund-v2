import { NextResponse } from "next/server";
import { getHomeRankData } from "@/lib/data-platform/web/homePageService";
export const dynamic = "force-dynamic";
export async function GET(){return NextResponse.json(await getHomeRankData(),{headers:{"Cache-Control":"no-store"}})}