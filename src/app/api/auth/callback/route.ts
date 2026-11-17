import { NextResponse } from "next/server";
import { isAppError } from "@/lib/errors";
import { publicRoute } from "@/server/api";
import { completeLogin } from "@/server/auth/login";
import { clearedOAuthCookie, cookieNames, sessionCookies } from "@/server/auth/session";

export const GET = publicRoute({ operation: "auth.callback" }, async ({ req, log }) => {
  const params = req.nextUrl.searchParams;
  const fail = (code: string) => {
    const loginPage = new URL("/login", req.nextUrl.origin);
    loginPage.searchParams.set("error", code);
    const response = NextResponse.redirect(loginPage, 303);
    response.cookies.set(clearedOAuthCookie());
    return response;
  };

  const code = params.get("code");
  const state = params.get("state");
  if (params.get("error") || !code || !state) {
    log.info("Sign-in was not completed", { reason: params.get("error")?.slice(0, 60) ?? "missing code" });
    return fail("GC_LOGIN_FAILED");
  }

  try {
    const result = await completeLogin({ code, state, oauthCookie: req.cookies.get(cookieNames().oauth)?.value, origin: req.nextUrl.origin, log });
    const response = NextResponse.redirect(new URL(result.returnTo, req.nextUrl.origin), 303);
    for (const cookie of sessionCookies(result.session)) response.cookies.set(cookie);
    response.cookies.set(clearedOAuthCookie());
    return response;
  } catch (error) {
    if (isAppError(error)) log.info("Sign-in rejected", { code: error.code, detail: error.detail });
    else log.error("Sign-in crashed", { err: error });
    return fail(isAppError(error) ? error.code : "INTERNAL");
  }
});
