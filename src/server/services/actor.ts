import type { Logger } from "../log";

/** Who is acting, for authorization scoping and audit fields. */
export interface ActorContext {
  orgId: string;
  userId: string;
  userName: string;
  log: Logger;
}
