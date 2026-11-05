// The initialization Job's settings, read before it opens the database.
// scripts/bootstrap-installation.mjs reads them from process.env; tests call
// bootstrapConfiguration in process with their own environment.
import {
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
  validHttpBaseURL,
} from "../../apps/controller/src/auth/configuration.ts";

const DEFAULT_BETTER_AUTH_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_DEV_ADMIN_EMAIL = "admin@openclaw.local";

export function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

export function optional(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function normalizeEmail(raw, name) {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`${name} must contain a valid administrator email.`);
  }
  return email;
}

function authBaseURL(raw, mode) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must contain an absolute URL.");
  }
  refuseWrittenUserinfo("OCC_AUTH_BASE_URL", raw);
  // Before the loopback exception: Node rewrites 127.1, 0177.0.0.1 and
  // 192.168.010.001, and the rewritten host must not become the published origin.
  refuseRewrittenIpv4Host("OCC_AUTH_BASE_URL", raw, parsed);
  if (
    mode === "production" &&
    parsed.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("OCC_AUTH_BASE_URL must be HTTPS except for loopback development tests.");
  }
  if (
    mode === "development" &&
    ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Development OCC_AUTH_BASE_URL must identify a loopback HTTP(S) URL.");
  }
  const baseURL = parsed.toString().replace(/\/$/, "");
  // The auth stack rejects the same values; check here so the already-bootstrapped path,
  // which never loads it, still fails the Job on them.
  if (!validHttpBaseURL(baseURL)) {
    throw new Error("OCC_AUTH_BASE_URL must be an absolute HTTP origin URL.");
  }
  return baseURL;
}

export function bootstrapFailureCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (/installation[ _]name breaks the Name rule/i.test(message)) {
    return "INSTALLATION_NAME_INVALID";
  }
  if (/OCC_AUTH_SECRET/.test(message)) {
    return "AUTH_SECRET_INVALID";
  }
  if (/OCC_AUTH_BASE_URL|loopback host|loopback HTTP\(S\) URL/.test(message)) {
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
export function bootstrapConfiguration(mode, env) {
  const authConfig = {
    secret: optional(
      env,
      "OCC_AUTH_SECRET",
      mode === "development" ? "openclaw-development-auth-secret-minimum-32-bytes" : undefined,
    ),
    baseURL: authBaseURL(
      optional(
        env,
        "OCC_AUTH_BASE_URL",
        mode === "development" ? DEFAULT_BETTER_AUTH_BASE_URL : undefined,
      ),
      mode,
    ),
  };
  if (authConfig.secret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
  }

  if (mode === "production") {
    return {
      mode,
      databaseUrl: required(env, "OCC_DATABASE_URL"),
      auth: authConfig,
      adminEmail: normalizeEmail(
        required(env, "OCC_BOOTSTRAP_ADMIN_EMAIL"),
        "OCC_BOOTSTRAP_ADMIN_EMAIL",
      ),
    };
  }

  return {
    mode,
    databaseUrl: required(env, "OCC_DATABASE_URL"),
    auth: authConfig,
    adminEmail: normalizeEmail(
      optional(env, "OPENCLAW_DEV_EMAIL", DEFAULT_DEV_ADMIN_EMAIL),
      "OPENCLAW_DEV_EMAIL",
    ),
  };
}
