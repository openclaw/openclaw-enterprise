import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  AuthorizationDeniedError,
  ResourceConflictError,
  type CliDeviceAuthorization,
  type CliDeviceAuthorizationStart,
  type CliSession,
  type CliSessionApprover,
  type CliSessionExchange,
} from "@openclaw-enterprise/occ";
import { AdmissionFailure, type AdmittedSession } from "../admission/admission-verifier.ts";
import { admissionKey, keyedAdmission } from "./admission.ts";

/**
 * RFC-0019 `occ login`: a device authorization (RFC 8628 shape) that the person approves in
 * the console, yielding a CLI session that admits their own Principal and never outlives the
 * approving browser session.
 */
export const CLI_SESSION_HEADER = "x-occ-cli-session";
export const CLI_SESSION_TOKEN_PATTERN = /^occcli_[A-Za-z0-9_-]{43}$/;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NAMESPACE_ID_PATTERN =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLI_SESSION_ID_PATTERN =
  /^cls_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 20 consonants: 8 of them carry about 34 bits, shown as `BCDF-GHJK`. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
/** The polling interval occ is told to use, in seconds. */
export const CLI_POLL_INTERVAL_SECONDS = 5;
export const CLI_VERIFICATION_PATH = "/console/cli-login";

export interface CliSessionSettings {
  /** `auth.cliSessions.enabled`; on by default (RFC-0019 question 4). */
  readonly enabled: boolean;
  /** `auth.cliSessions.maxLifetimeSeconds`: 900 to 28,800, default 28,800. */
  readonly maxLifetimeSeconds: number;
}

export const DEFAULT_CLI_SESSION_SETTINGS: CliSessionSettings = Object.freeze({
  enabled: true,
  maxLifetimeSeconds: 28_800,
});

/** Parses OCC_AUTH_CLI_SESSIONS and OCC_AUTH_CLI_SESSION_MAX_LIFETIME_SECONDS. */
export function cliSessionSettings(
  environment: Readonly<Record<string, string | undefined>>,
): CliSessionSettings {
  const enabled = environment.OCC_AUTH_CLI_SESSIONS?.trim() ?? "";
  if (enabled !== "" && enabled !== "enabled" && enabled !== "disabled") {
    throw new Error("OCC_AUTH_CLI_SESSIONS must be enabled or disabled.");
  }
  const lifetime = environment.OCC_AUTH_CLI_SESSION_MAX_LIFETIME_SECONDS?.trim() ?? "";
  const maxLifetimeSeconds =
    lifetime === "" ? DEFAULT_CLI_SESSION_SETTINGS.maxLifetimeSeconds : Number(lifetime);
  if (
    !/^\d*$/.test(lifetime) ||
    !Number.isSafeInteger(maxLifetimeSeconds) ||
    maxLifetimeSeconds < 900 ||
    maxLifetimeSeconds > 28_800
  ) {
    throw new Error(
      "OCC_AUTH_CLI_SESSION_MAX_LIFETIME_SECONDS must be an integer from 900 to 28800.",
    );
  }
  return Object.freeze({ enabled: enabled !== "disabled", maxLifetimeSeconds });
}

/** The persistence a CLI sign-in needs; PostgresCliSessions implements it. */
export interface CliSessionStore {
  start(input: CliDeviceAuthorizationStart): Promise<{ id: string; expiresAt: Date }>;
  lookup(userCodeHash: string): Promise<CliDeviceAuthorization | undefined>;
  decide(
    userCodeHash: string,
    decision: "approve" | "deny",
    approver: CliSessionApprover,
    requestId?: string,
  ): Promise<CliDeviceAuthorization | undefined>;
  exchange(
    deviceCodeHash: string,
    issue: { readonly tokenHash: string; readonly maxLifetimeSeconds: number },
    requestId?: string,
  ): Promise<CliSessionExchange>;
  verify(tokenHash: string): Promise<CliSession | undefined>;
  list(userId: string): Promise<CliSession[]>;
  revoke(
    userId: string,
    sessionId: string,
    reason: "logout" | "console",
    requestId?: string,
  ): Promise<boolean>;
  sweep(limit?: number): Promise<{ authorizations: number; sessions: number }>;
}

export function hashCliCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateUserCode(): string {
  let code = "";
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The canonical form of a typed user code: letters upper-cased, one hyphen or space between
 * the halves tolerated. Undefined for anything else, so a malformed code spends budget
 * without a lookup.
 */
export function normalizeUserCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16) {
    return undefined;
  }
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== USER_CODE_LENGTH) {
    return undefined;
  }
  for (const letter of compact) {
    if (!USER_CODE_ALPHABET.includes(letter)) {
      return undefined;
    }
  }
  return compact;
}

/** `undefined` when absent; `null` when malformed or repeated (Node joins with ", "). */
export function cliSessionHeader(headers: Headers): string | null | undefined {
  const value = headers.get(CLI_SESSION_HEADER);
  if (value === null) {
    return undefined;
  }
  return CLI_SESSION_TOKEN_PATTERN.test(value) ? value : null;
}

/** A refusal whose status, code and message the caller may see. */
class CliRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const browserOnly = () =>
  new CliRefusal(403, "FORBIDDEN", "This operation requires a signed-in browser session.");

/**
 * Failed user-code entries (lookup and decide share it): 5 per minute keyed on both the
 * account and the client address. Only wrong or malformed codes spend; a full table of
 * current entries refuses instead of evicting someone else's budget.
 */
class WrongCodeBudget {
  readonly #entries = new Map<string, { windowStart: number; failures: number }>();
  readonly #perMinute: number;
  readonly #capacity: number;

  constructor(perMinute: number, capacity: number) {
    this.#perMinute = perMinute;
    this.#capacity = capacity;
  }

  /** Seconds until the most exhausted key resets, or undefined while every key has budget. */
  refused(keys: readonly string[], now: number): number | undefined {
    let resetAt: number | undefined;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (
        entry !== undefined &&
        now - entry.windowStart < 60_000 &&
        entry.failures >= this.#perMinute
      ) {
        resetAt = Math.max(resetAt ?? 0, entry.windowStart + 60_000);
      }
    }
    return resetAt === undefined ? undefined : Math.max(1, Math.ceil((resetAt - now) / 1000));
  }

  spend(keys: readonly string[], now: number): boolean {
    for (const key of keys) {
      let entry = this.#entries.get(key);
      if (entry === undefined || now - entry.windowStart >= 60_000) {
        if (entry === undefined && this.#entries.size >= this.#capacity) {
          for (const [candidate, value] of this.#entries) {
            if (now - value.windowStart >= 60_000) {
              this.#entries.delete(candidate);
              break;
            }
          }
          if (this.#entries.size >= this.#capacity) {
            return false;
          }
        }
        entry = { windowStart: now, failures: 0 };
        this.#entries.set(key, entry);
      }
      entry.failures += 1;
    }
    return true;
  }
}

/** What the controller's auth module supplies to the CLI sign-in routes. */
export interface CliSignInDependencies {
  readonly store: CliSessionStore;
  readonly settings: CliSessionSettings;
  /** The client address for rate limits and the approval page (see client-address.ts). */
  readonly clientAddressOf: (request: FastifyRequest) => string;
  /**
   * The current browser session: the configured Origin when `requireOrigin`, a mandatory
   * matching x-occ-session-key and a valid session cookie; throws AdmissionFailure otherwise.
   */
  readonly browserSession: (
    request: FastifyRequest,
    requireOrigin: boolean,
  ) => Promise<AdmittedSession>;
}

export interface CliSignIn {
  readonly enabled: boolean;
  start(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  token(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  lookup(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  decide(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  list(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  revoke(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  current(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  logout(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** The CLI session a well-formed token names while it authenticates. */
  verify(token: string): Promise<CliSession | undefined>;
  sweep(): Promise<void>;
}

function body(request: FastifyRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
}

function publicSession(session: CliSession) {
  return {
    id: session.id,
    clientLabel: session.clientLabel,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ...(session.namespaceId === undefined ? {} : { namespaceId: session.namespaceId }),
  };
}

export function createCliSignIn(dependencies: CliSignInDependencies): CliSignIn {
  const { store, settings } = dependencies;
  // Unauthenticated start: 30 per minute per client address.
  const starts = keyedAdmission({ perMinute: 30, concurrent: 4 }, { concurrent: 64 });
  // Polling at the advertised interval is 12 per minute per device code; this bounds an
  // address polling many codes at once.
  const polls = keyedAdmission({ perMinute: 240, concurrent: 8 }, { concurrent: 128 });
  const wrongCodes = new WrongCodeBudget(5, 4096);
  // Last poll per device-code hash, for slow_down. Bounded: the oldest entries go first.
  const lastPoll = new Map<string, number>();

  async function send(
    request: FastifyRequest,
    reply: FastifyReply,
    run: () => Promise<{ readonly status?: number; readonly data: unknown }>,
  ): Promise<void> {
    reply.header("cache-control", "no-store");
    try {
      if (!settings.enabled) {
        throw new CliRefusal(404, "NOT_FOUND", "CLI sign-in is not enabled on this controller.");
      }
      const result = await run();
      reply
        .status(result.status ?? 200)
        .send({ data: result.data, meta: { requestId: request.id } });
    } catch (error) {
      const refusal =
        error instanceof CliRefusal
          ? error
          : error instanceof AdmissionFailure
            ? new CliRefusal(
                error.status,
                error.code,
                error.status === 401
                  ? "A valid signed-in browser session is required."
                  : "The browser origin is not trusted.",
              )
            : isTooManyRequests(error)
              ? new CliRefusal(429, "RATE_LIMITED", "Too many requests. Try again later.", 60)
              : error instanceof AuthorizationDeniedError
                ? new CliRefusal(403, "FORBIDDEN", "The account has no Principal.")
                : new CliRefusal(
                    503,
                    "DEPENDENCY_UNAVAILABLE",
                    "A required platform dependency is unavailable.",
                  );
      if (refusal.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(refusal.retryAfterSeconds));
      }
      reply.status(refusal.status).send({
        error: { code: refusal.code, message: refusal.message },
        meta: { requestId: request.id },
      });
    }
  }

  function refuseCliCredentials(request: FastifyRequest): void {
    // A copied CLI token or key must not approve, list or revoke on the person's behalf.
    if (
      request.headers[CLI_SESSION_HEADER] !== undefined ||
      request.headers["x-api-key"] !== undefined
    ) {
      throw browserOnly();
    }
  }

  async function cliCaller(request: FastifyRequest): Promise<CliSession> {
    const headers = new Headers();
    const value = request.headers[CLI_SESSION_HEADER];
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(CLI_SESSION_HEADER, entry);
    }
    if (request.headers["x-api-key"] !== undefined || request.headers.authorization !== undefined) {
      throw new CliRefusal(401, "UNAUTHENTICATED", "Send exactly one credential.");
    }
    const token = cliSessionHeader(headers);
    const session =
      typeof token === "string" ? await store.verify(hashCliCredential(token)) : undefined;
    if (session === undefined) {
      throw new CliRefusal(401, "UNAUTHENTICATED", "A valid CLI session is required.");
    }
    return session;
  }

  function codeKeys(request: FastifyRequest, userId: string): string[] {
    return [admissionKey("ip", dependencies.clientAddressOf(request)), `account:${userId}`];
  }

  /** Normalizes the typed code under the shared wrong-code budget. */
  function typedCode(request: FastifyRequest, userId: string): string | undefined {
    const keys = codeKeys(request, userId);
    const retryAfter = wrongCodes.refused(keys, performance.now());
    if (retryAfter !== undefined) {
      throw new CliRefusal(
        429,
        "RATE_LIMITED",
        "Too many wrong codes. Try again later.",
        retryAfter,
      );
    }
    return normalizeUserCode(body(request).userCode);
  }

  function wrongCode(request: FastifyRequest, userId: string): CliRefusal {
    if (!wrongCodes.spend(codeKeys(request, userId), performance.now())) {
      return new CliRefusal(429, "RATE_LIMITED", "Too many wrong codes. Try again later.", 60);
    }
    return new CliRefusal(
      404,
      "NOT_FOUND",
      "No pending sign-in request has this code. Check the code shown by occ login; it expires after 10 minutes.",
    );
  }

  function sessionExpiry(browser: AdmittedSession): string {
    const capped = Date.now() + settings.maxLifetimeSeconds * 1000;
    return new Date(Math.min(new Date(browser.expiresAt).getTime(), capped)).toISOString();
  }

  function pendingView(
    request: FastifyRequest,
    found: CliDeviceAuthorization,
    browser: AdmittedSession,
  ) {
    return {
      clientLabel: found.clientLabel,
      requesterAddress: found.requesterAddress,
      sameAddress: found.requesterAddress === dependencies.clientAddressOf(request),
      ...(found.namespaceId === undefined ? {} : { namespaceId: found.namespaceId }),
      codeExpiresAt: found.expiresAt.toISOString(),
      sessionExpiresAt: sessionExpiry(browser),
    };
  }

  return {
    enabled: settings.enabled,
    async start(request, reply) {
      await send(request, reply, async () => {
        const input = body(request);
        const clientLabel = input.clientLabel;
        const namespaceId = input.namespaceId;
        if (typeof clientLabel !== "string" || !/^[\x20-\x7e]{1,64}$/.test(clientLabel)) {
          throw new CliRefusal(
            400,
            "INVALID_REQUEST",
            "clientLabel must be 1 to 64 printable ASCII characters.",
          );
        }
        if (
          namespaceId !== undefined &&
          (typeof namespaceId !== "string" || !NAMESPACE_ID_PATTERN.test(namespaceId))
        ) {
          throw new CliRefusal(400, "INVALID_REQUEST", "namespaceId must be a Namespace ID.");
        }
        const address = dependencies.clientAddressOf(request);
        return starts.admit([admissionKey("ip", address)], async () => {
          const deviceCode = randomBytes(32).toString("base64url");
          // A user-code collision among pending authorizations is retried once.
          for (let attempt = 0; ; attempt += 1) {
            const userCode = generateUserCode();
            try {
              const started = await store.start({
                deviceCodeHash: hashCliCredential(deviceCode),
                userCodeHash: hashCliCredential(normalizeUserCode(userCode)!),
                clientLabel,
                requesterAddress: address.slice(0, 64) || "unknown",
                ...(typeof namespaceId === "string" ? { namespaceId } : {}),
              });
              return {
                status: 201,
                data: {
                  deviceCode,
                  userCode,
                  verificationUri: CLI_VERIFICATION_PATH,
                  interval: CLI_POLL_INTERVAL_SECONDS,
                  expiresIn: Math.max(
                    1,
                    Math.round((started.expiresAt.getTime() - Date.now()) / 1000),
                  ),
                },
              };
            } catch (error) {
              if (attempt > 0 || !(error instanceof ResourceConflictError)) {
                throw error;
              }
            }
          }
        });
      });
    },
    async token(request, reply) {
      await send(request, reply, async () => {
        const deviceCode = body(request).deviceCode;
        if (typeof deviceCode !== "string" || !DEVICE_CODE_PATTERN.test(deviceCode)) {
          throw new CliRefusal(400, "INVALID_REQUEST", "deviceCode is malformed.");
        }
        const deviceCodeHash = hashCliCredential(deviceCode);
        const now = performance.now();
        const previous = lastPoll.get(deviceCodeHash);
        lastPoll.delete(deviceCodeHash);
        lastPoll.set(deviceCodeHash, now);
        if (lastPoll.size > 4096) {
          lastPoll.delete(lastPoll.keys().next().value!);
        }
        // RFC 8628 slow_down, with a second of slack for timer jitter.
        if (previous !== undefined && now - previous < (CLI_POLL_INTERVAL_SECONDS - 1) * 1000) {
          throw new CliRefusal(
            400,
            "SLOW_DOWN",
            "Polling too fast; wait 5 seconds longer between requests.",
          );
        }
        const token = `occcli_${randomBytes(32).toString("base64url")}`;
        const result = await polls.admit(
          [admissionKey("ip", dependencies.clientAddressOf(request))],
          () =>
            store.exchange(
              deviceCodeHash,
              {
                tokenHash: hashCliCredential(token),
                maxLifetimeSeconds: settings.maxLifetimeSeconds,
              },
              request.id,
            ),
        );
        switch (result.status) {
          case "pending":
            throw new CliRefusal(
              400,
              "AUTHORIZATION_PENDING",
              "Waiting for approval in the console.",
            );
          case "denied":
            throw new CliRefusal(
              400,
              "ACCESS_DENIED",
              "The sign-in request was denied in the console.",
            );
          case "expired":
            throw new CliRefusal(
              400,
              "EXPIRED_TOKEN",
              "The sign-in request expired, was already used or lost its approving browser session. Run occ login again.",
            );
          case "limit":
            throw new CliRefusal(
              409,
              "CLI_SESSION_LIMIT",
              "The approving browser session already holds 10 CLI sessions. Revoke one in the console, or sign in to the console again.",
            );
          case "issued":
            lastPoll.delete(deviceCodeHash);
            return {
              data: {
                token,
                session: publicSession(result.session),
                user: {
                  id: result.session.userId,
                  email: result.session.email,
                  name: result.session.name,
                },
              },
            };
          default:
            return result satisfies never;
        }
      });
    },
    async lookup(request, reply) {
      await send(request, reply, async () => {
        refuseCliCredentials(request);
        const browser = await dependencies.browserSession(request, true);
        const code = typedCode(request, browser.userId);
        const found = code === undefined ? undefined : await store.lookup(hashCliCredential(code));
        if (found === undefined) {
          throw wrongCode(request, browser.userId);
        }
        return { data: pendingView(request, found, browser) };
      });
    },
    async decide(request, reply) {
      await send(request, reply, async () => {
        refuseCliCredentials(request);
        const browser = await dependencies.browserSession(request, true);
        const decision = body(request).decision;
        if (decision !== "approve" && decision !== "deny") {
          throw new CliRefusal(400, "INVALID_REQUEST", "decision must be approve or deny.");
        }
        const code = typedCode(request, browser.userId);
        const decided =
          code === undefined
            ? undefined
            : await store.decide(
                hashCliCredential(code),
                decision,
                { userId: browser.userId, sessionId: browser.id },
                request.id,
              );
        if (decided === undefined) {
          throw wrongCode(request, browser.userId);
        }
        return {
          data: {
            decision,
            ...(decision === "approve" ? { sessionExpiresAt: sessionExpiry(browser) } : {}),
          },
        };
      });
    },
    async list(request, reply) {
      await send(request, reply, async () => {
        refuseCliCredentials(request);
        const browser = await dependencies.browserSession(request, false);
        return { data: (await store.list(browser.userId)).map(publicSession) };
      });
    },
    async revoke(request, reply) {
      await send(request, reply, async () => {
        refuseCliCredentials(request);
        const browser = await dependencies.browserSession(request, true);
        const { cliSessionId } = request.params as { cliSessionId?: unknown };
        if (typeof cliSessionId !== "string" || !CLI_SESSION_ID_PATTERN.test(cliSessionId)) {
          throw new CliRefusal(400, "INVALID_REQUEST", "The CLI session ID is malformed.");
        }
        if (!(await store.revoke(browser.userId, cliSessionId, "console", request.id))) {
          throw new CliRefusal(404, "NOT_FOUND", "The CLI session was not found.");
        }
        return { data: { id: cliSessionId, revoked: true } };
      });
    },
    async current(request, reply) {
      await send(request, reply, async () => {
        const session = await cliCaller(request);
        return {
          data: {
            ...publicSession(session),
            user: { id: session.userId, email: session.email, name: session.name },
          },
        };
      });
    },
    async logout(request, reply) {
      await send(request, reply, async () => {
        const session = await cliCaller(request);
        // A concurrent revoke may win; either way the session no longer authenticates.
        await store.revoke(session.userId, session.id, "logout", request.id);
        return { data: { id: session.id, revoked: true } };
      });
    },
    async verify(token) {
      if (!settings.enabled || !CLI_SESSION_TOKEN_PATTERN.test(token)) {
        return undefined;
      }
      return store.verify(hashCliCredential(token));
    },
    async sweep() {
      await store.sweep();
    },
  };
}

function isTooManyRequests(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; status?: unknown } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate.statusCode === 429 || candidate.status === "TOO_MANY_REQUESTS")
  );
}
