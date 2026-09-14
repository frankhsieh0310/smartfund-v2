import type { User as PrismaUser } from "@prisma/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";

export class AuthenticatedUserConflictError extends Error {}

export type AccountResponse = {
  id: string;
  email: string;
  name: string | null;
  plan: PrismaUser["plan"];
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
    throw new AuthenticatedUserConflictError("Email is already linked to another identity");
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
    // TODO: Replace this temporary account-plan boundary with Entitlement Service output.
    plan: user.plan,
  };
}

export async function getAccountForRequest(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) return null;

  return toAccountResponse(await resolveSmartMatchUser(identity));
}
