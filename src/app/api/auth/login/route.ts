import { NextResponse } from "next/server";
import { isAppError } from "@/lib/errors";
import { publicRoute } from "@/server/api";
import { beginLogin, loginQuerySchema } from "@/server/auth/login";

export const GET = publicRoute({ operation: "auth.login" }, async ({ req, log }) => {
  const parsed = loginQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  const loginPage = new URL("/login", req.nextUrl.origin);
  if (!parsed.success) {
    loginPage.searchParams.set("error", "VALIDATION");
    return NextResponse.redirect(loginPage, 303);
  }
  try {
    const { redirectUrl, cookie } = beginLogin({ ...parsed.data, origin: req.nextUrl.origin });
    const response = NextResponse.redirect(redirectUrl, 303);
    response.cookies.set(cookie);
    log.debug("Redirecting to Genesys Cloud sign-in", { region: parsed.data.region });
    return response;
  } catch (error) {
    loginPage.searchParams.set("error", isAppError(error) ? error.code : "INTERNAL");
    return NextResponse.redirect(loginPage, 303);
  }
});
