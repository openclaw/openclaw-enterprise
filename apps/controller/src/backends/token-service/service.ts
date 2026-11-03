import type { PostgresPlatformStateOptions } from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EgressRef,
  PreparedTokenIssuer,
  PreparedTokenService,
} from "@openclaw-enterprise/contracts";
import type { TokenIssue } from "./preparation.ts";

type PostgresProof = NonNullable<PostgresPlatformStateOptions["preparedTokenProof"]>;

type Preparation = {
  run(
    id: string,
    bounds: TokenIssue["bounds"],
  ): Promise<"ready" | "committed" | "blocked" | "fenced" | "quarantined">;
};

/**
 * Installation-owned lifecycle service. Each admission owner supplies only its eligible families,
 * input authority and custody. Capture, readiness and use never wake a maintenance pass.
 */
export class TokenService implements PreparedTokenService {
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

  register(issuer: PreparedTokenIssuer, postgresProof?: PostgresProof): void {
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
      const result = await families.prepare(outer, (owner) => {
        const budget = 25_000;
        const signal = AbortSignal.any([outer, AbortSignal.timeout(budget)]);
        return owner.run(randomUUID(), { signal, deadlineMonoMs: performance.now() + budget });
      });
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
