import type { PlatformStateStore, PostgresPlatformStateOptions } from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EgressRef,
  OAuthAccountRef,
  OAuthConnectionGrant,
  OAuthConnectionClient,
  OAuthConnectionAccessToken,
  PreparedTokenSelection,
  ResolvedToken,
  SecretDriver,
  EgressSourceKey,
  PreparedTokenSource,
  Secret,
  TokenResolveOptions,
  PreparedTokenIssuer,
  TokenService as TokenServiceContract,
} from "@openclaw-enterprise/contracts";
import { OAuthAccountTokens } from "./oauth-connection.ts";
import type { TokenIssue } from "./preparation.ts";

type PostgresProof = NonNullable<PostgresPlatformStateOptions["preparedTokenProof"]>;

type Preparation = {
  run(
    id: string,
    bounds: TokenIssue["bounds"],
  ): Promise<"ready" | "committed" | "blocked" | "fenced" | "quarantined">;
};

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
  private accounts?: OAuthAccountTokens;

  configureAccounts(
    state: PlatformStateStore,
    secrets: SecretDriver,
    resolveClient: (ref: OAuthAccountRef) => Promise<OAuthConnectionClient>,
  ) {
    this.accounts = new OAuthAccountTokens(state, secrets, resolveClient);
  }

  get supportsAccounts() {
    return this.accounts !== undefined;
  }

  private accountOwner() {
    if (!this.accounts) {
      throw new Error("The Installation has no saved account token owner.");
    }
    return this.accounts;
  }

  accountStatus(ref: OAuthAccountRef, signal: AbortSignal) {
    return this.accountOwner().status(ref, signal);
  }

  maintainAccount(ref: OAuthAccountRef, signal: AbortSignal) {
    return this.accountOwner().maintain(ref, signal);
  }

  retireAccount(ref: OAuthAccountRef, signal: AbortSignal) {
    return this.accountOwner().retire(ref, signal);
  }

  private readonly issuers = new Map<string, PreparedTokenIssuer>();

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

  registerIssuer(issuer: PreparedTokenIssuer, postgresProof?: PostgresProof): void {
    const { id } = issuer.provider;
    if (this.issuers.has(id)) {
      throw new Error("A prepared provider must have exactly one lifecycle owner.");
    }
    this.issuers.set(id, issuer);
    if (postgresProof) {
      this.proofs.set(id, postgresProof);
    }
  }

  issuer(provider: EgressRef): PreparedTokenIssuer | undefined {
    const issuer = this.issuers.get(provider.id);
    return issuer && isDeepStrictEqual(issuer.provider, provider) ? issuer : undefined;
  }

  register(
    registration: { readonly source: PreparedTokenSource; readonly secret: Readonly<Secret> },
    signal: AbortSignal,
  ): Promise<EgressSourceKey>;
  register(
    registration: { readonly account: OAuthAccountRef; readonly grant: OAuthConnectionGrant },
    signal: AbortSignal,
  ): Promise<OAuthAccountRef>;
  async register(
    registration:
      | { readonly source: PreparedTokenSource; readonly secret: Readonly<Secret> }
      | { readonly account: OAuthAccountRef; readonly grant: OAuthConnectionGrant },
    signal: AbortSignal,
  ) {
    if ("account" in registration) {
      return this.accountOwner().register(registration.account, registration.grant, signal);
    }
    const { source, secret } = registration;
    const issuer = this.issuer(source.key.provider);
    if (!issuer) {
      throw new Error("The token issuer for this registration is unavailable.");
    }
    await issuer.configure(source, secret, signal);
    return source.key;
  }

  resolve(
    reference: EgressSourceKey,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined>;
  resolve(
    reference: OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<OAuthConnectionAccessToken | undefined>;
  resolve(
    reference: EgressSourceKey | OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<ResolvedToken | undefined>;
  async resolve(reference: EgressSourceKey | OAuthAccountRef, options: TokenResolveOptions) {
    const { signal: caller, minimumValidityMs } = options;
    const deadline = Date.parse(options.deadlineAt);
    const remaining = deadline - Date.now();
    if (
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      caller.aborted ||
      !Number.isFinite(minimumValidityMs) ||
      minimumValidityMs < 0
    ) {
      return undefined;
    }
    const issuer = "provider" in reference ? this.issuer(reference.provider) : undefined;
    const signals = [caller, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))];
    if (issuer?.shutdownSignal) {
      signals.push(issuer.shutdownSignal);
    }
    const signal = AbortSignal.any(signals);
    if (signal.aborted) {
      return undefined;
    }
    let cancel!: () => void;
    const stopped = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      // Each caller has its own time budget. A provider can finish an already-dispatched
      // renewal after a caller leaves, but a delayed read must never release its bytes.
      const bounded = { ...options, signal };
      const selected =
        "sourceId" in reference
          ? this.accountOwner().resolve(reference, bounded)
          : issuer?.resolve(reference, bounded);
      const token = await Promise.race([stopped, selected]);
      if (!token || signal.aborted) {
        return undefined;
      }
      const now = Date.now();
      const expiresAt = Date.parse(token.expiresAt);
      const usableUntil =
        "usableUntil" in token ? Math.min(expiresAt, Date.parse(token.usableUntil)) : expiresAt;
      return now < deadline && usableUntil > now + minimumValidityMs ? token : undefined;
    } finally {
      signal.removeEventListener("abort", cancel);
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
