import type { SessionInfo } from "@/lib/api-types";
import { sessionRoute } from "@/server/api";
import { appVersion } from "@/server/env";
import { countConnections } from "@/server/repo/connections";
import { countSyncs } from "@/server/repo/syncs";
import { getGcCredentialsStatus } from "@/server/services/genesys";

export const GET = sessionRoute({ operation: "session.get" }, async ({ session }): Promise<SessionInfo> => {
  const [connections, credentials, syncs] = await Promise.all([
    countConnections(session.orgId),
    getGcCredentialsStatus(session.orgId),
    countSyncs(session.orgId),
  ]);
  return {
    user: { id: session.userId, name: session.userName },
    org: { id: session.orgId, name: session.orgName, region: session.region },
    setup: { connections, gcCredentials: credentials.status, syncs },
    version: appVersion(),
  };
});
