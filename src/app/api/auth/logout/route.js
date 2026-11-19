import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { COOKIE_PATH } from "@/shared/utils/basePath";

export async function POST() {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete({ name: "oidc_state", path: COOKIE_PATH });
  cookieStore.delete({ name: "oidc_nonce", path: COOKIE_PATH });
  cookieStore.delete({ name: "oidc_code_verifier", path: COOKIE_PATH });
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
