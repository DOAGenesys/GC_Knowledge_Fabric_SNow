/**
 * Stable error codes shared by the API, the sync engine and the UI.
 * Messages are written for the person using the app; `hint` says what to do next.
 * Technical detail never goes in `message` or `hint`: it lives in `detail`, which is
 * logged (redacted) and only shown in the run's technical details.
 */

import { redactString } from "./redact";

export interface ErrorSpec {
  status: number;
  title: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

const GC_PERMISSIONS_HINT =
  "Give the Genesys Cloud OAuth client a role with: knowledge:source:view, knowledge:synchronization:add, knowledge:synchronization:view, knowledge:synchronization:edit, knowledge:synchronization:upload and knowledge:synchronization:deleteFile.";

export const ERROR_CATALOG = {
  UNAUTHENTICATED: {
    status: 401,
    title: "Signed out",
    message: "Your session has ended. Please sign in again.",
    retryable: false,
  },
  CSRF_FAILED: {
    status: 403,
    title: "Request blocked",
    message: "This request could not be verified.",
    hint: "Refresh the page and try again.",
    retryable: false,
  },
  FORBIDDEN: {
    status: 403,
    title: "Not allowed",
    message: "You don't have access to this.",
    retryable: false,
  },
  ORG_NOT_ALLOWED: {
    status: 403,
    title: "Organization not allowed",
    message: "This app is not enabled for your Genesys Cloud organization.",
    hint: "Ask the app administrator to add your organization ID to APP_ALLOWED_ORG_IDS.",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    title: "Not found",
    message: "We couldn't find what you were looking for.",
    retryable: false,
  },
  VALIDATION: {
    status: 400,
    title: "Check the form",
    message: "Some fields need your attention.",
    retryable: false,
  },
  CONFLICT: {
    status: 409,
    title: "Conflict",
    message: "This change conflicts with the current state.",
    hint: "Refresh the page and try again.",
    retryable: false,
  },
  CONFIG_MISSING: {
    status: 500,
    title: "App not configured",
    message: "The app is missing required configuration.",
    hint: "An administrator must set the required environment variables in Vercel.",
    retryable: false,
  },
  INTERNAL: {
    status: 500,
    title: "Unexpected error",
    message: "Something went wrong on our side.",
    hint: "Try again. If it keeps happening, share the request ID with your administrator.",
    retryable: true,
  },

  GC_LOGIN_FAILED: {
    status: 502,
    title: "Sign-in failed",
    message: "Genesys Cloud sign-in didn't complete.",
    hint: "Check the region and the OAuth client ID, and that the client's redirect URI matches this app.",
    retryable: false,
  },
  GC_KNOWLEDGE_ACCESS_DENIED: {
    status: 403,
    title: "Missing Knowledge permission",
    message: "Your Genesys Cloud user can't view knowledge sources.",
    hint: "Ask an administrator for a role with the knowledge:source:view permission (and knowledge:source:add to create sources).",
    retryable: false,
  },
  GC_CREDENTIALS_MISSING: {
    status: 409,
    title: "Sync credentials missing",
    message: "Genesys Cloud sync credentials are not set up yet.",
    hint: "Open Connections and add a Genesys Cloud OAuth client (Client Credentials) for background syncs.",
    retryable: false,
  },
  GC_ORG_MISMATCH: {
    status: 400,
    title: "Wrong organization",
    message: "These credentials belong to a different Genesys Cloud organization.",
    hint: "Use an OAuth client created in the organization you're signed in to.",
    retryable: false,
  },
  GC_AUTH_FAILED: {
    status: 502,
    title: "Genesys Cloud rejected the credentials",
    message: "Genesys Cloud didn't accept the OAuth client credentials.",
    hint: "Check the client ID and secret in Connections. The client may have been deleted or its secret rotated.",
    retryable: false,
  },
  GC_PERMISSION_DENIED: {
    status: 502,
    title: "Missing Genesys Cloud permissions",
    message: "The Genesys Cloud OAuth client isn't allowed to do this.",
    hint: GC_PERMISSIONS_HINT,
    retryable: false,
  },
  GC_SOURCE_NOT_FOUND: {
    status: 404,
    title: "Knowledge source not found",
    message: "The Genesys Cloud knowledge source no longer exists.",
    hint: "Edit the sync and pick another File Upload source, or create a new one.",
    retryable: false,
  },
  GC_SOURCE_BUSY: {
    status: 409,
    title: "Source busy",
    message: "Another synchronization is still running on this knowledge source.",
    hint: "We'll retry automatically. If it persists, check the source's activity in Genesys Cloud.",
    retryable: true,
  },
  GC_RATE_LIMITED: {
    status: 503,
    title: "Genesys Cloud rate limit",
    message: "Genesys Cloud asked us to slow down.",
    hint: "We'll retry automatically shortly.",
    retryable: true,
  },
  GC_UNAVAILABLE: {
    status: 503,
    title: "Genesys Cloud unavailable",
    message: "Genesys Cloud is temporarily unavailable.",
    hint: "We'll retry automatically.",
    retryable: true,
  },
  GC_REQUEST_REJECTED: {
    status: 502,
    title: "Request rejected",
    message: "Genesys Cloud rejected the request.",
    hint: "See the technical details for the reason.",
    retryable: false,
  },
  GC_SYNC_FAILED: {
    status: 502,
    title: "Synchronization failed",
    message: "Genesys Cloud reported that the synchronization failed.",
    hint: "We'll retry on the next run. If it keeps failing, contact Genesys support with the synchronization ID.",
    retryable: true,
  },
  GC_INGESTION_FAILED: {
    status: 502,
    title: "Processing failed",
    message: "Genesys Cloud received the files but couldn't process them.",
    hint: "We'll retry on the next run. If it keeps failing, contact Genesys support with the synchronization ID.",
    retryable: true,
  },
  GC_OUTCOME_UNKNOWN: {
    status: 502,
    title: "Result unknown",
    message: "We couldn't confirm the result of the last Genesys Cloud request.",
    hint: "The next run reconciles automatically.",
    retryable: true,
  },

  SN_INVALID_URL: {
    status: 400,
    title: "Invalid instance URL",
    message: "That doesn't look like a reachable ServiceNow instance URL.",
    hint: "Use your instance address, for example https://acme.service-now.com.",
    retryable: false,
  },
  SN_AUTH_FAILED: {
    status: 502,
    title: "ServiceNow rejected the credentials",
    message: "ServiceNow didn't accept the connection's credentials.",
    hint: "Update the credentials in Connections. The password or secret may have expired or been rotated.",
    retryable: false,
  },
  SN_PERMISSION_DENIED: {
    status: 502,
    title: "Missing ServiceNow access",
    message: "The ServiceNow account can't read knowledge articles.",
    hint: "Give the integration user the knowledge role (or read access to kb_knowledge and kb_knowledge_base) and access to these knowledge bases.",
    retryable: false,
  },
  SN_NOT_FOUND: {
    status: 502,
    title: "ServiceNow API not found",
    message: "ServiceNow didn't recognize the request.",
    hint: "Check the instance URL and that the Knowledge Management application is active.",
    retryable: false,
  },
  SN_UNREACHABLE: {
    status: 502,
    title: "ServiceNow unreachable",
    message: "We couldn't reach the ServiceNow instance.",
    hint: "Check the instance URL. We'll retry automatically.",
    retryable: true,
  },
  SN_HIBERNATING: {
    status: 502,
    title: "ServiceNow instance asleep",
    message: "The ServiceNow instance returned a web page instead of data.",
    hint: "Developer instances hibernate when idle: wake it at developer.servicenow.com. Also check the instance isn't forcing single sign-on for API calls.",
    retryable: true,
  },
  SN_RATE_LIMITED: {
    status: 503,
    title: "ServiceNow rate limit",
    message: "ServiceNow asked us to slow down.",
    hint: "We'll retry automatically.",
    retryable: true,
  },
  SN_UNAVAILABLE: {
    status: 503,
    title: "ServiceNow unavailable",
    message: "ServiceNow is temporarily unavailable.",
    hint: "We'll retry automatically.",
    retryable: true,
  },
  SN_QUERY_INVALID: {
    status: 400,
    title: "Invalid filter",
    message: "ServiceNow rejected the article filter.",
    hint: "Check the advanced filter (encoded query) in the sync settings.",
    retryable: false,
  },
  SN_BAD_RESPONSE: {
    status: 502,
    title: "Unexpected ServiceNow response",
    message: "ServiceNow returned data we couldn't read.",
    hint: "We'll retry automatically. If it persists, check the instance's REST API configuration.",
    retryable: true,
  },
  SN_TOO_MANY_ARTICLES: {
    status: 400,
    title: "Too many articles",
    message: "These knowledge bases contain more articles than one sync can handle.",
    hint: "Split them across several syncs or narrow the advanced filter.",
    retryable: false,
  },
  SN_NO_ARTICLES: {
    status: 409,
    title: "ServiceNow returned no articles",
    message: "ServiceNow suddenly returned no articles for this sync, so nothing was removed from Genesys Cloud.",
    hint: 'Check that the ServiceNow account can still read these knowledge bases (its roles and each knowledge base\'s "Can read" user criteria). If every article was retired on purpose, delete the sync and its knowledge source.',
    retryable: false,
  },
  KB_NOT_FOUND: {
    status: 404,
    title: "Knowledge base not found",
    message: "One of the selected knowledge bases no longer exists or isn't readable.",
    hint: "Edit the sync and review the selected knowledge bases.",
    retryable: false,
  },

  CONNECTION_IN_USE: {
    status: 409,
    title: "Connection in use",
    message: "This connection is used by one or more syncs.",
    hint: "Delete or move those syncs first.",
    retryable: false,
  },
  SOURCE_ALREADY_USED: {
    status: 409,
    title: "Source already used",
    message: "Another sync already writes to this knowledge source.",
    hint: "Pick a different source or create a new one. Two syncs writing to one source would overwrite each other.",
    retryable: false,
  },
  SYNC_ALREADY_RUNNING: {
    status: 409,
    title: "Already running",
    message: "This sync is already running.",
    retryable: false,
  },
  WORKFLOW_START_FAILED: {
    status: 503,
    title: "Couldn't start",
    message: "The sync couldn't be started.",
    hint: "We'll retry automatically. If it persists, check the Vercel Workflow status.",
    retryable: true,
  },
  WORKFLOW_LOST: {
    status: 500,
    title: "Run interrupted",
    message: "The run stopped unexpectedly.",
    hint: "We'll retry automatically on the next schedule.",
    retryable: true,
  },
  RUN_CANCELLED: {
    status: 409,
    title: "Cancelled",
    message: "The run was cancelled.",
    retryable: false,
  },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

export function errorSpec(code: string): ErrorSpec {
  return isErrorCode(code) ? ERROR_CATALOG[code] : ERROR_CATALOG.INTERNAL;
}

export interface FieldIssue {
  path: string;
  message: string;
}

/** JSON shape of every API error response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    title: string;
    message: string;
    hint?: string;
    fields?: FieldIssue[];
    requestId?: string;
  };
}

export interface AppErrorOptions {
  message?: string;
  hint?: string;
  /** Technical, non-secret context for logs and run details. Never shown as the main message. */
  detail?: string;
  status?: number;
  fields?: FieldIssue[];
  cause?: unknown;
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint?: string;
  readonly detail?: string;
  readonly fields?: FieldIssue[];
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const spec = ERROR_CATALOG[code];
    super(options.message ?? spec.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? spec.status;
    this.hint = options.hint ?? ("hint" in spec ? spec.hint : undefined);
    this.detail = options.detail;
    this.fields = options.fields;
    this.retryable = options.retryable ?? spec.retryable;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        title: ERROR_CATALOG[this.code].title,
        message: redactString(this.message),
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.fields?.length ? { fields: this.fields } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Plain-object form used to pass errors across workflow step boundaries and store them on runs. */
export interface ErrorRecord {
  code: ErrorCode;
  message: string;
  hint?: string;
  detail?: string;
  retryable: boolean;
}

export function toErrorRecord(error: unknown, fallback: ErrorCode = "INTERNAL"): ErrorRecord {
  if (isAppError(error)) {
    return {
      code: error.code,
      message: redactString(error.message),
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.detail ? { detail: redactString(error.detail) } : {}),
      retryable: error.retryable,
    };
  }
  const spec = ERROR_CATALOG[fallback];
  const name = error instanceof Error ? error.name : "Error";
  return {
    code: fallback,
    message: spec.message,
    ...("hint" in spec && spec.hint ? { hint: spec.hint } : {}),
    detail: name,
    retryable: spec.retryable,
  };
}
