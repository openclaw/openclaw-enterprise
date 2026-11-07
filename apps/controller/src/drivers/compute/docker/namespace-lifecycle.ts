import { isDeepStrictEqual } from "node:util";
import type {
  NamespaceLifecycleCheckpoint,
  NamespaceLifecycleContext,
} from "@openclaw-enterprise/contracts";

export class DockerNamespaceLifecycleRefused extends Error {}

interface DockerNamespaceBinding {
  readonly engineId: string;
  readonly socketPath: string;
  readonly networkName: string;
}

interface DockerNamespaceData extends Record<string, unknown> {
  readonly version: 1;
  readonly binding: DockerNamespaceBinding;
  readonly nonce: string;
  readonly creation: "not-attempted" | "attempted" | "refused";
  readonly networkId?: string;
}

export function requireDockerLifecycle(
  lifecycle: NamespaceLifecycleContext,
  target: "ready" | "deleted",
): void {
  if (
    lifecycle === undefined ||
    lifecycle.target !== target ||
    typeof lifecycle.read !== "function" ||
    typeof lifecycle.checkpoint !== "function"
  ) {
    throw new DockerNamespaceLifecycleRefused("Namespace lifecycle authority is required.");
  }
  lifecycle.signal.throwIfAborted();
}

export function emptyDockerLifecycle(checkpoint: NamespaceLifecycleCheckpoint): boolean {
  if (Object.keys(checkpoint.data).length !== 0) {
    return false;
  }
  if (checkpoint.revision !== 0) {
    throw new DockerNamespaceLifecycleRefused("The Namespace lifecycle intent is missing.");
  }
  return true;
}

export function fullDockerNetworkId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** Docker owns its Engine selector, creation uncertainty and immutable network identity. */
export class DockerNamespaceJournal {
  readonly lifecycle: NamespaceLifecycleContext;
  private readonly binding: DockerNamespaceBinding;

  private constructor(lifecycle: NamespaceLifecycleContext, binding: DockerNamespaceBinding) {
    this.lifecycle = lifecycle;
    this.binding = binding;
  }

  static async open(
    lifecycle: NamespaceLifecycleContext,
    binding: DockerNamespaceBinding,
    nonce: string,
  ): Promise<DockerNamespaceJournal> {
    const journal = new DockerNamespaceJournal(lifecycle, binding);
    const current = await lifecycle.read();
    if (emptyDockerLifecycle(current)) {
      await lifecycle.checkpoint(current.revision, {
        version: 1,
        binding,
        nonce,
        creation: "not-attempted",
      });
    }
    await journal.read();
    return journal;
  }

  async read(): Promise<{ readonly revision: number; readonly data: DockerNamespaceData }> {
    this.lifecycle.signal.throwIfAborted();
    const current = await this.lifecycle.read();
    const data = current.data;
    if (
      data.version !== 1 ||
      !isDeepStrictEqual(data.binding, this.binding) ||
      typeof data.nonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(data.nonce) ||
      !["not-attempted", "attempted", "refused"].includes(String(data.creation)) ||
      (data.networkId !== undefined &&
        (!fullDockerNetworkId(data.networkId) || data.creation !== "attempted"))
    ) {
      throw new DockerNamespaceLifecycleRefused(
        "The Docker Namespace lifecycle binding is unsupported or changed.",
      );
    }
    return { revision: current.revision, data: data as DockerNamespaceData };
  }

  async save(
    change: Pick<DockerNamespaceData, "creation"> & { networkId?: string },
  ): Promise<void> {
    const current = await this.read();
    await this.lifecycle.checkpoint(current.revision, { ...current.data, ...change });
  }
}
