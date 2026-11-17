import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { regionLabel } from "@/lib/regions";
import { requirePageSession } from "@/server/auth/server-session";
import { appVersion } from "@/server/env";

export default async function SignedInLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession();
  return (
    <AppShell user={{ name: session.userName }} org={{ name: session.orgName, region: regionLabel(session.region) }} version={appVersion()}>
      {children}
    </AppShell>
  );
}
