import type { PostgresPlatformStateOptions } from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EgressRef,
  OAuthAccountRef,
  OAuthRefreshTokenRegistration,
  PreparedTokenRegistration,
  PreparedTokenRef,
  OAuthRefreshTokenIssuer,
  OAuthConnectionAccessToken,
  PreparedTokenSelection,
  ResolvedToken,
  TokenResolveOptions,
  PreparedTokenIssuer,
  TokenService as TokenServiceContract,
} from "@openclaw-enterprise/contracts";
import type { TokenIssue } from "./preparation.ts";

type PostgresProof = NonNullable<PostgresPlatformStateOptions["preparedTokenProof"]>;

type Preparation = {
  run(
    id: string,
    bounds: TokenIssue["bounds"],
  ): Promise<"ready" | "committed" | "blocked" | "fenced" | "quarantined">;
};

function hasAccountCoordinates(ref: OAuthAccountRef) {
  return (
    typeof ref.namespaceId === "string" &&
    ref.namespaceId.length > 0 &&
    typeof ref.sourceId === "string" &&
    ref.sourceId.length > 0
  );
}

function resolutionDeadline(deadline: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // A relative timer can wake before the signed wall-clock deadline. Allow its one
  // millisecond of wall-clock precision, while bounding a backwards clock step.
  const latest = performance.now() + (deadline - Date.now()) + 1;
  const remainingMs = () => Math.min(deadline - Date.now(), latest - performance.now());
  const check = () => {
    const remaining = remainingMs();
    if (remaining <= 0) {
      controller.abort();
    } else {
      timer = setTimeout(check, Math.min(Math.ceil(remaining), 2_147_483_647)).unref();
    }
  };
  check();
  return {
    signal: controller.signal,
    expired: () => remainingMs() <= 0,
    clear: () => clearTimeout(timer),
  };
}

/** The same issuance budget applies to scheduled and request-triggered work. */
export function runPreparation(owner: Preparation, outer: AbortSignal) {
  const budget = 25_000;
  return owner.run(randomUUID(), {
    signal: AbortSignal.any([outer, AbortSignal.timeout(budget)]),
    deadlineMonoMs: performance.now() + budget,
  });
}

/**
 * Installation-owned lifecycle service. Each admission owner supplies only its eligible families,
 * input authority and custody. A request can prepare only its authorized registration.
 */
export class TokenService implements TokenServiceContract {
  private readonly issuers = new Map<string, PreparedTokenIssuer | OAuthRefreshTokenIssuer>();
  private readonly proofs = new Map<string, PostgresProof>();

  /** Called inside the platform transaction that authorizes the send. No credential bytes are read. */
  readonly postgresCurrentProof: PostgresProof = (client) => ({
    current: async (source, evidence, authority, lifetime) => {
      const issuer = this.issuer(source.key.provider);
      const proof =
        issuer?.issuerAuthority === authority && this.proofs.get(issuer.provider.id)?.(client);
      return proof ? proof.current(source, evidence, authority, lifetime) : false;
    },
  });

  registerIssuer(issuer: OAuthRefreshTokenIssuer): void;
  registerIssuer(issuer: PreparedTokenIssuer, postgresProof?: PostgresProof): void;
  registerIssuer(
    issuer: PreparedTokenIssuer | OAuthRefreshTokenIssuer,
    postgresProof?: PostgresProof,
  ) {
    let key: string;
    switch (issuer.tokenKind) {
      case "oauth_refresh_token":
        key = issuer.tokenKind;
        break;
      case "github_app_installation":
      case "prepared_source":
        key = `provider/${issuer.provider.id}`;
        break;
      default:
        throw new Error("A token issuer must declare a supported token kind.");
    }
    if (this.issuers.has(key)) {
      throw new Error("A token issuer already owns this registration.");
    }
    this.issuers.set(key, issuer);
    if (postgresProof && issuer.tokenKind !== "oauth_refresh_token") {
      this.proofs.set(issuer.provider.id, postgresProof);
    }
  }

  issuer(kind: OAuthAccountRef["kind"]): OAuthRefreshTokenIssuer | undefined;
  issuer(provider: EgressRef): PreparedTokenIssuer | undefined;
  issuer(target: EgressRef | OAuthAccountRef["kind"]) {
    if (target === "oauth_refresh_token") {
      const issuer = this.issuers.get(target);
      return issuer?.tokenKind === target ? issuer : undefined;
    }
    const issuer = this.issuers.get(`provider/${target.id}`);
    if (
      issuer &&
      issuer.tokenKind !== "oauth_refresh_token" &&
      isDeepStrictEqual(issuer.provider, target)
    ) {
      return issuer;
    }
    return undefined;
  }

  register(
    registration: OAuthRefreshTokenRegistration,
    signal: AbortSignal,
  ): Promise<OAuthAccountRef>;
  register(registration: PreparedTokenRegistration, signal: AbortSignal): Promise<PreparedTokenRef>;
  async register(
    registration: PreparedTokenRegistration | OAuthRefreshTokenRegistration,
    signal: AbortSignal,
  ) {
    switch (registration.kind) {
      case "oauth_refresh_token": {
        if (
          !hasAccountCoordinates(registration) ||
          !registration.approval?.connectionTemplateId ||
          !Number.isSafeInteger(registration.approval.connectionTemplateVersion) ||
          !registration.approval.oauthClientId ||
          !registration.grant
        ) {
          throw new Error(
            "OAuth token registration requires an account, approved template and grant.",
          );
        }
        const issuer = this.issuer(registration.kind);
        if (!issuer) {
          throw new Error("The Installation has no saved account token owner.");
        }
        return issuer.register(registration, signal);
      }
      case "github_app_installation":
      case "prepared_source": {
        const { kind, source, secret } = registration;
        if (!source?.key?.provider || !secret) {
          throw new Error("Prepared token registration requires a source and issuer Secret.");
        }
        const issuer = this.issuer(source.key.provider);
        if (!issuer || issuer.tokenKind !== kind) {
          throw new Error("The registered provider does not support this token kind.");
        }
        await issuer.configure(source, secret, signal);
        return { kind, key: source.key };
      }
      default:
        throw new Error("Unknown token registration kind.");
    }
  }

  resolve(
    reference: OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<OAuthConnectionAccessToken | undefined>;
  resolve(
    reference: PreparedTokenRef,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined>;
  resolve(
    reference: PreparedTokenRef | OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<ResolvedToken | undefined>;
  async resolve(reference: PreparedTokenRef | OAuthAccountRef, options: TokenResolveOptions) {
    const { signal: caller, minimumValidityMs } = options;
    const deadline = Date.parse(options.deadlineAt);
    if (
      !(deadline > Date.now()) ||
      caller.aborted ||
      !Number.isFinite(minimumValidityMs) ||
      minimumValidityMs < 0
    ) {
      return undefined;
    }
    let read: (
      options: TokenResolveOptions,
    ) => Promise<PreparedTokenSelection | OAuthConnectionAccessToken | undefined>;
    let shutdownSignal: AbortSignal | undefined;
    switch (reference.kind) {
      case "oauth_refresh_token": {
        if (!hasAccountCoordinates(reference)) {
          return undefined;
        }
        const issuer = this.issuer(reference.kind);
        if (!issuer) {
          return undefined;
        }
        read = (bounded) => issuer.resolve(reference, bounded);
        break;
      }
      case "github_app_installation":
      case "prepared_source": {
        const issuer = reference.key?.provider && this.issuer(reference.key.provider);
        if (!issuer || issuer.tokenKind !== reference.kind || issuer.shutdownSignal?.aborted) {
          return undefined;
        }
        shutdownSignal = issuer.shutdownSignal;
        read = (bounded) => issuer.resolve(reference.key, bounded);
        break;
      }
      default:
        return undefined;
    }
    const timeout = resolutionDeadline(deadline);
    const signals = [caller, timeout.signal];
    if (shutdownSignal) {
      signals.push(shutdownSignal);
    }
    const signal = AbortSignal.any(signals);
    let cancel!: () => void;
    const stopped = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) {
        return undefined;
      }
      // Each caller has its own time budget. A provider can finish an already-dispatched
      // renewal after a caller leaves, but a delayed read must never release its bytes.
      const token = await Promise.race([stopped, read({ ...options, signal })]);
      if (!token || signal.aborted) {
        return undefined;
      }
      const now = Date.now();
      const expiresAt = Date.parse(token.expiresAt);
      const usableUntil =
        "usableUntil" in token ? Math.min(expiresAt, Date.parse(token.usableUntil)) : expiresAt;
      return !timeout.expired() && usableUntil > now + minimumValidityMs ? token : undefined;
    } finally {
      signal.removeEventListener("abort", cancel);
      timeout.clear();
    }
  }

  /** One serialized discovery, retirement and preparation loop for an independently owned set. */
  ownFamilies(families: {
    discover?(signal: AbortSignal): Promise<void>;
    retire(signal: AbortSignal): Promise<unknown>;
    prepare(
      signal: AbortSignal,
      run: (preparation: Preparation) => ReturnType<Preparation["run"]>,
    ): Promise<void | string>;
    /** Called with the pass's error so an owner can name a known refusal. Map it to a fixed
     * code and reason; never log the error or its message. */
    failed(error: unknown): void;
  }) {
    const stop = new AbortController();
    let running: Promise<string | void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let started = false;

    async function pass(outer: AbortSignal) {
      outer.throwIfAborted();
      await families.discover?.(outer);
      const retirement = await families.retire(outer);
      outer.throwIfAborted();
      const result = await families.prepare(outer, (owner) => runPreparation(owner, outer));
      return result ?? (typeof retirement === "string" ? retirement : undefined);
    }
    function maintain(signal = stop.signal) {
      return (running ??= pass(AbortSignal.any([signal, stop.signal])).finally(() => {
        running = undefined;
      }));
    }
    async function tick() {
      let delay = 5_000;
      try {
        const result = await maintain();
        if (result && !["idle", "issuer-mismatch", "blocked", "quarantined"].includes(result)) {
          delay = 100;
        }
      } catch (error) {
        if (!stop.signal.aborted) {
          families.failed(error);
        }
      } finally {
        if (!stop.signal.aborted) {
          timer = setTimeout(() => void tick(), delay);
        }
      }
    }
    return {
      maintain,
      start() {
        if (!started) {
          started = true;
          void tick();
        }
      },
      async close() {
        stop.abort();
        clearTimeout(timer);
        await running?.catch(() => undefined);
      },
    };
  }
}
