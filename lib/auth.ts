import "server-only";
import { cache } from "react";
import { isConfigured, serverSupabase } from "./supabase-server";

export type Account = {
  id: string;
  email: string;
  displayName: string;
  role: "player" | "admin";
  tenantId?: string;
  tenants?: {id: string; name: string; role: string}[];
  isSuperAdmin?: boolean;
  tenantName?: string;
};

export const getAccount = cache(
  async (): Promise<{ account: Account | null; problem?: string }> => {
    if (!isConfigured())
      return {
        account: null,
        problem: "Account service is not configured yet.",
      };
    const db = await serverSupabase();
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    if (error || !user) return { account: null };
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("display_name,role,active")
      .eq("id", user.id)
      .single();
    if (profileError)
      return {
        account: null,
        problem:
          "Your account profile is not ready. Please contact the venue administrator.",
      };
    if (!profile?.active || !user.email_confirmed_at)
      return {
        account: null,
        problem: "This account is inactive or its email has not been verified.",
      };
    if (profile.role !== "player" && profile.role !== "admin")
      return { account: null, problem: "Account role is not valid." };
    return {
      account: {
        id: user.id,
        email: user.email!,
        displayName: profile.display_name,
        role: profile.role,
      },
    };
  },
);
