import type { PostgresPlatformStateOptions } from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EgressRef,
  PreparedTokenRef,
  PreparedTokenRegistration,
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
    if (issuer.tokenKind !== "github_app_installation" && issuer.tokenKind !== "prepared_source") {
      throw new Error("A prepared token issuer must declare a supported token kind.");
    }
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

  async register(
    { kind, source, secret }: PreparedTokenRegistration,
    signal: AbortSignal,
  ): Promise<PreparedTokenRef> {
    const issuer = this.issuer(source.key.provider);
    if (!issuer || issuer.tokenKind !== kind) {
      throw new Error("The registered provider does not support this token kind.");
    }
    await issuer.configure(source, secret, signal);
    return { kind, key: source.key };
  }

  async resolve(reference: PreparedTokenRef, options: TokenResolveOptions) {
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
    const issuer = reference.key && this.issuer(reference.key.provider);
    if (!issuer || issuer.tokenKind !== reference.kind || issuer.shutdownSignal?.aborted) {
      return undefined;
    }
    const timeout = resolutionDeadline(deadline);
    const signals = [caller, timeout.signal];
    if (issuer.shutdownSignal) {
      signals.push(issuer.shutdownSignal);
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
      const selected = issuer.resolve(reference.key, { ...options, signal });
      const token = await Promise.race([stopped, selected]);
      if (!token || signal.aborted) {
        return undefined;
      }
      const now = Date.now();
      const usableUntil = Math.min(Date.parse(token.expiresAt), Date.parse(token.usableUntil));
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
