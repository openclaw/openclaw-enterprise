import type {
  AgentRevision,
  ComputeLifecycleHooks,
  Driver,
  Namespace,
  WorkloadLaunchContext,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { currentComputeAbortSignal } from "./operation-context.ts";

type HookPhase = keyof ComputeLifecycleHooks;
type CleanupPhase = "beforeWorkloadStop" | "beforeNamespaceDelete";

interface SelectedDriver {
  readonly capability: Driver["capability"];
  readonly id: string;
  readonly callbacks: {
    readonly [phase in HookPhase]: ComputeLifecycleHooks[phase];
  };
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const OPAQUE_PLACEHOLDER = /^opaque-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_ENVIRONMENT_NAME =
  /^(?:HOME|PATH|TMPDIR|CODEX_HOME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LOG_FORMAT|RUST_LOG|XDG_.*|OPENCLAW_.*|OTEL_.*|LD_.*|DYLD_.*)$/;
const FALLBACK_SIGNAL = new AbortController().signal;

function validateLaunch({ environment }: WorkloadLaunchContext): void {
  const entries = Object.entries(environment);
  if (
    entries.length > 64 ||
    entries.some(
      ([name, value]) =>
        !ENVIRONMENT_NAME.test(name) ||
        RESERVED_ENVIRONMENT_NAME.test(name) ||
        typeof value !== "string" ||
        !OPAQUE_PLACEHOLDER.test(value),
    )
  ) {
    throw new Error("Unsafe workload launch environment contribution");
  }
}

function hookFailure(phase: HookPhase, owner: SelectedDriver): Error {
  return Object.assign(
    new Error(`Compute lifecycle hook ${phase} failed for ${owner.capability}:${owner.id}`),
    { phase },
  );
}

export class ComputeLifecycleDispatcher {
  readonly #drivers: readonly SelectedDriver[];

  constructor(drivers: readonly Driver[]) {
    this.#drivers = drivers.map(({ capability, id, computeLifecycleHooks: hooks }) => ({
      capability,
      id,
      callbacks: {
        afterNamespacePrepared: hooks?.afterNamespacePrepared?.bind(hooks),
        beforeWorkloadStart: hooks?.beforeWorkloadStart?.bind(hooks),
        beforeWorkloadStop: hooks?.beforeWorkloadStop?.bind(hooks),
        beforeNamespaceDelete: hooks?.beforeNamespaceDelete?.bind(hooks),
      },
    }));
  }

  async afterNamespacePrepared(namespace: Readonly<Namespace>): Promise<void> {
    const preparedNamespace = immutableCopy(namespace);
    const signal = currentComputeAbortSignal() ?? FALLBACK_SIGNAL;
    const completed: SelectedDriver[] = [];

    for (const owner of this.#drivers) {
      const hook = owner.callbacks.afterNamespacePrepared;
      if (hook === undefined) {
        continue;
      }

      try {
        signal.throwIfAborted();
        await hook(preparedNamespace, signal);
        completed.push(owner);
        signal.throwIfAborted();
      } catch {
        await this.#cleanup("beforeNamespaceDelete", preparedNamespace, completed, signal, true);
        throw hookFailure("afterNamespacePrepared", owner);
      }
    }
  }

  async beforeWorkloadStart(
    revision: Readonly<AgentRevision>,
  ): Promise<Readonly<WorkloadLaunchContext>> {
    const preparedRevision = immutableCopy(revision);
    const signal = currentComputeAbortSignal() ?? FALLBACK_SIGNAL;
    const completed: SelectedDriver[] = [];
    const launch: WorkloadLaunchContext = { environment: {} };
    let currentOwner: SelectedDriver | undefined;

    try {
      for (const owner of this.#drivers) {
        const hook = owner.callbacks.beforeWorkloadStart;
        if (hook === undefined) {
          continue;
        }

        currentOwner = owner;
        signal.throwIfAborted();
        await hook(preparedRevision, launch, signal);
        completed.push(owner);
        signal.throwIfAborted();
      }

      validateLaunch(launch);
      return immutableCopy(launch);
    } catch {
      await this.#cleanup("beforeWorkloadStop", preparedRevision, completed, signal, true);
      if (currentOwner === undefined) {
        throw new Error("Compute workload preparation failed");
      }
      throw hookFailure("beforeWorkloadStart", currentOwner);
    }
  }

  async beforeWorkloadStop(
    revision: Readonly<AgentRevision>,
    options?: { readonly cleanup?: boolean },
  ): Promise<void> {
    await this.#cleanup(
      "beforeWorkloadStop",
      immutableCopy(revision),
      this.#drivers,
      currentComputeAbortSignal() ?? FALLBACK_SIGNAL,
      options?.cleanup === true,
    );
  }

  async beforeNamespaceDelete(namespace: Readonly<Namespace>): Promise<void> {
    await this.#cleanup(
      "beforeNamespaceDelete",
      immutableCopy(namespace),
      this.#drivers,
      currentComputeAbortSignal() ?? FALLBACK_SIGNAL,
    );
  }

  async #cleanup(
    phase: CleanupPhase,
    resource: Readonly<AgentRevision> | Readonly<Namespace>,
    drivers: readonly SelectedDriver[],
    signal: AbortSignal,
    recoverCancelled = false,
  ): Promise<void> {
    const cleanupSignal = recoverCancelled && signal.aborted ? AbortSignal.timeout(5_000) : signal;

    for (const owner of [...drivers].reverse()) {
      const hook = owner.callbacks[phase] as
        | ((
            resource: Readonly<AgentRevision> | Readonly<Namespace>,
            signal: AbortSignal,
          ) => Promise<void>)
        | undefined;
      if (hook === undefined) {
        continue;
      }
      cleanupSignal.throwIfAborted();

      try {
        await hook(resource, cleanupSignal);
        cleanupSignal.throwIfAborted();
      } catch {
        throw hookFailure(phase, owner);
      }
    }
  }
}
