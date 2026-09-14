// lib/prisma.ts
// Prisma Client 單例。Next.js 開發模式下 Hot Reload 會重複執行模組，
// 若每次都 new PrismaClient()，會很快耗盡 Supabase 的連線池
// （上次 Fund Master Import 就撞過連線數限制的錯誤）。
// 用 globalThis 快取實例，開發模式下重複使用同一個 client。

import { PrismaClient } from "@prisma/client";
import { accessSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) {
  const compatibleEngine = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
  try { accessSync(compatibleEngine); process.env.PRISMA_QUERY_ENGINE_LIBRARY = compatibleEngine; } catch { /* Prisma surfaces a clear engine error if the validated runtime asset is absent. */ }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
