import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api";
import { clearedSessionCookies, isSameOrigin, requestHost } from "@/server/auth/session";

export const POST = publicRoute({ operation: "auth.logout" }, async ({ req }) => {
  if (!isSameOrigin(req.headers.get("origin"), requestHost(req.headers))) return NextResponse.json({ ok: false }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  for (const cookie of clearedSessionCookies()) response.cookies.set(cookie);
  return response;
});
