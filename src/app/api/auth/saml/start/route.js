import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { buildSamlAuthorizeUrl, getSamlBaseUrl, isSamlConfigured } from "@/lib/auth/saml.js";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { COOKIE_PATH, withBasePath } from "@/shared/utils/basePath";

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    if (!isSamlConfigured(settings)) {
      return NextResponse.redirect(new URL(withBasePath("/login?error=saml_not_configured"), origin));
    }

    const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings);

    const cookieStore = await cookies();
    cookieStore.set("saml_state", requestId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      path: COOKIE_PATH,
      maxAge: 10 * 60,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.redirect(
      new URL(withBasePath(`/login?error=${encodeURIComponent(error.message || "saml_start_failed")}`), origin)
    );
  }
}
