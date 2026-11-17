import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { allowedOrgIds } from "../env";
import { cookieNames, readSession, type Session } from "./session";

/** Session for Server Components and layouts. */
export async function getServerSession(): Promise<Session | null> {
  const store = await cookies();
  const session = readSession(store.get(cookieNames().session)?.value);
  if (!session) return null;
  const allowed = allowedOrgIds();
  if (allowed && !allowed.has(session.orgId.toLowerCase())) return null;
  return session;
}

/**
 * Session for signed-in pages. Redirects to the sign-in page with a reason, which also keeps the
 * proxy from bouncing a signed-in-but-not-allowed user straight back here.
 */
export async function requirePageSession(): Promise<Session> {
  const store = await cookies();
  const session = readSession(store.get(cookieNames().session)?.value);
  if (!session) redirect("/login?error=UNAUTHENTICATED");
  const allowed = allowedOrgIds();
  if (allowed && !allowed.has(session.orgId.toLowerCase())) redirect("/login?error=ORG_NOT_ALLOWED");
  return session;
}
