import type { User as PrismaUser } from "@prisma/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";
import { getAccessTier, getTrialEndsAt, type AccessTier } from "@/lib/payments/plans";
import { deleteUserDataCascade } from "@/lib/auth/deleteUserCascade";

export class AuthenticatedUserConflictError extends Error {}

export type AccountResponse = {
  id: string;
  email: string;
  name: string | null;
  plan: PrismaUser["plan"];
  accessTier: AccessTier;
  trialEndsAt: string;
};

function displayNameFrom(identity: SupabaseUser) {
  const candidate = identity.user_metadata?.display_name
    ?? identity.user_metadata?.full_name
    ?? identity.user_metadata?.name;

  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export async function resolveSmartMatchUser(identity: SupabaseUser) {
  const existing = await prisma.user.findUnique({
    where: { supabaseId: identity.id },
  });
  if (existing) return existing;

  if (!identity.email) {
    throw new AuthenticatedUserConflictError("Authenticated identity has no email");
  }

  const emailOwner = await prisma.user.findUnique({
    where: { email: identity.email },
  });
  if (emailOwner) {
    // 2026-11-12 使用者回報核實+核准修正：台股拼圖跟全球投資夥伴共用同一個Supabase登入帳號，
    // 使用者在台股拼圖刪除帳號會把共用登入帳號（auth.users）整個刪掉，但全球投資夥伴自己這張
    // users表完全沒有FK/trigger連到auth.users（VERIFIED查過production），資料不會被自動清掉。
    // 之後用同一信箱重新註冊會拿到一個全新的auth.users.id，原本這裡的判斷邏輯會查到舊的email
    // 列、直接丟衝突錯誤卡住登入——改成先確認舊列的supabase_id對應的登入帳號是否真的還存在：
    // 真的還存在（例如帳號被盜用/異常情況）才維持原本丟錯誤擋下來；查無對應登入帳號（已刪除、
    // 純殘留）就把舊資料整個清掉（deleteUserDataCascade，跟每日殘留清理排程同一套邏輯），當成
    // 全新會員建立，不讓使用者卡死在「這個信箱已經連結到別的身分」的錯誤。
    const oldIdentityStillExists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = $1::uuid) exists`,
      emailOwner.supabaseId,
    );
    if (oldIdentityStillExists[0]?.exists) {
      throw new AuthenticatedUserConflictError("Email is already linked to another identity");
    }
    await deleteUserDataCascade(emailOwner.id);
  }

  return prisma.user.upsert({
    where: { supabaseId: identity.id },
    update: {},
    create: {
        supabaseId: identity.id,
        email: identity.email,
        displayName: displayNameFrom(identity),
    },
  });
}

function toAccountResponse(user: PrismaUser): AccountResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.displayName,
    plan: user.plan,
    accessTier: getAccessTier(user),
    trialEndsAt: getTrialEndsAt(user.createdAt).toISOString(),
  };
}

export async function getAccountForRequest(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) return null;

  return toAccountResponse(await resolveSmartMatchUser(identity));
}
