import { z } from "zod";
import { AppError } from "@/lib/errors";
import { type Logger, scopedLogger } from "../log";
import { type GcAuth, gcRequest } from "./client";

const log = scopedLogger("gc.identity");

const userSchema = z.object({ id: z.string(), name: z.string().default("") }).passthrough();
const orgSchema = z.object({ id: z.string(), name: z.string().default("") }).passthrough();

export async function getCurrentUser(auth: GcAuth, logger: Logger = log): Promise<{ id: string; name: string }> {
  const { data } = await gcRequest<unknown>(auth, { operation: "gc.usersMe", method: "GET", path: "/api/v2/users/me", log: logger });
  const parsed = userSchema.safeParse(data);
  if (!parsed.success) throw new AppError("GC_LOGIN_FAILED", { detail: "users/me: unexpected response shape" });
  return { id: parsed.data.id, name: parsed.data.name };
}

export async function getOrganization(auth: GcAuth, logger: Logger = log): Promise<{ id: string; name: string }> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.organizationsMe",
    method: "GET",
    path: "/api/v2/organizations/me",
    log: logger,
  });
  const parsed = orgSchema.safeParse(data);
  if (!parsed.success) throw new AppError("GC_REQUEST_REJECTED", { detail: "organizations/me: unexpected response shape" });
  return { id: parsed.data.id, name: parsed.data.name };
}

/** True when the token may list knowledge sources (knowledge:source:view). */
export async function canViewKnowledgeSources(auth: GcAuth, logger: Logger = log): Promise<boolean> {
  try {
    await gcRequest<unknown>(auth, { operation: "gc.knowledgeAccess", method: "GET", path: "/api/v2/knowledge/sources", log: logger });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "GC_PERMISSION_DENIED") return false;
    throw error;
  }
}
