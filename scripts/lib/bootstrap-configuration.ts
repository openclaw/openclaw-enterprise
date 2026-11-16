// The initialization Job's settings, read before it opens the database.
// scripts/bootstrap-installation.mjs reads them from process.env; tests call
// bootstrapConfiguration in process with their own environment.
import {
  deriveSharedCookieDomain,
  isDevelopmentBrowserOrigin,
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
  validateAuthSecret,
  validHttpBaseURL,
} from "../../apps/controller/src/auth/configuration.ts";
import type { ControllerAuthOptions } from "../../apps/controller/src/auth/index.ts";

type BootstrapMode = ControllerAuthOptions["mode"];
type BootstrapEnvironment = Readonly<NodeJS.ProcessEnv>;

interface BootstrapConfiguration {
  readonly mode: BootstrapMode;
  readonly databaseUrl: string;
  readonly auth: Pick<ControllerAuthOptions, "secret" | "baseURL" | "agentDomain">;
  readonly adminEmail: string;
}

const DEFAULT_DEV_ADMIN_EMAIL = "admin@openclaw.local";

export function required(env: BootstrapEnvironment, name: string): string {
  return optional(env, name);
}

export function optional(env: BootstrapEnvironment, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function normalizeEmail(raw: string, name: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`${name} must contain a valid administrator email.`);
  }
  return email;
}

function authBaseURL(raw: string, mode: BootstrapMode): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must contain an absolute URL.");
  }
  refuseWrittenUserinfo("OCC_AUTH_BASE_URL", raw);
  refuseRewrittenIpv4Host("OCC_AUTH_BASE_URL", raw, parsed);
  const baseURL = parsed.toString().replace(/\/$/, "");
  // The auth stack rejects the same values; check here so the already-bootstrapped path,
  // which never loads it, still fails the Job on them.
  if (!validHttpBaseURL(baseURL)) {
    throw new Error("OCC_AUTH_BASE_URL must be an absolute HTTP origin URL.");
  }
  if (mode === "development" && !isDevelopmentBrowserOrigin(baseURL)) {
    throw new Error("Development OCC_AUTH_BASE_URL must identify an HTTPS localhost subdomain.");
  }
  return baseURL;
}

export function bootstrapFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/installation[ _]name breaks the Name rule/i.test(message)) {
    return "INSTALLATION_NAME_INVALID";
  }
  if (/OCC_AUTH_SECRET/.test(message)) {
    return "AUTH_SECRET_INVALID";
  }
  if (
    /OCC_AUTH_BASE_URL|OCC_AGENT_NATIVE_ADMIN_DOMAIN|OCC_AUTH_COOKIE_DOMAIN|OCC_DEVELOPMENT_AUTH_COOKIE_DOMAIN|Shared session cookies|Console and Agent hostnames|loopback host|loopback HTTP\(S\) URL/.test(
      message,
    )
  ) {
    return "AUTH_BASE_URL_INVALID";
  }
  if (/OCC_DATABASE_URL|PostgreSQL database|PostgreSQL connection URL/.test(message)) {
    return "DATABASE_CONFIGURATION_INVALID";
  }
  if (/commit outcome is unknown/i.test(message)) {
    return "COMMIT_OUTCOME_UNKNOWN";
  }
  if (/platform persistence repository|ECONNREFUSED|ECONNRESET|connect /i.test(message)) {
    return "PERSISTENCE_UNAVAILABLE";
  }
  return "BOOTSTRAP_FAILED";
}

/** The Job's auth, database and administrator settings in `mode`, read from `env`. */
export function bootstrapConfiguration(
  mode: BootstrapMode,
  env: BootstrapEnvironment,
): BootstrapConfiguration {
  const secret = optional(
    env,
    "OCC_AUTH_SECRET",
    mode === "development" ? "openclaw-development-auth-secret-minimum-32-bytes" : undefined,
  );
  const baseURL = authBaseURL(required(env, "OCC_AUTH_BASE_URL"), mode);
  for (const removed of ["OCC_AUTH_COOKIE_DOMAIN", "OCC_DEVELOPMENT_AUTH_COOKIE_DOMAIN"]) {
    if (Object.hasOwn(env, removed)) {
      throw new Error(
        `${removed} has been removed; cookie scope is derived from Console and Agent hostnames.`,
      );
    }
  }
  const agentDomain = required(env, "OCC_AGENT_NATIVE_ADMIN_DOMAIN");
  deriveSharedCookieDomain(baseURL, agentDomain);
  validateAuthSecret(secret);

  const databaseUrl = required(env, "OCC_DATABASE_URL");
  const adminEmail =
    mode === "production"
      ? normalizeEmail(required(env, "OCC_BOOTSTRAP_ADMIN_EMAIL"), "OCC_BOOTSTRAP_ADMIN_EMAIL")
      : normalizeEmail(
          optional(env, "OPENCLAW_DEV_EMAIL", DEFAULT_DEV_ADMIN_EMAIL),
          "OPENCLAW_DEV_EMAIL",
        );
  return { mode, databaseUrl, auth: { secret, baseURL, agentDomain }, adminEmail };
}
