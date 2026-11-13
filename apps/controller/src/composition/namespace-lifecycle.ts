import { asRecord } from "@openclaw-enterprise/utils";
import type { ComputeDriver, SandboxDriver } from "@openclaw-enterprise/contracts";
import {
  SandboxNamespaceRefusedError,
  SandboxNamespacePendingError,
  type InstalledDriver,
  type NamespaceLifecycleBinding,
} from "@openclaw-enterprise/occ";

function namespaceFailure(error: unknown): "retryable" | "permanent" | undefined {
  if (error instanceof SandboxNamespacePendingError) {
    return undefined;
  }
  const record = asRecord(error);
  if (
    error instanceof SandboxNamespaceRefusedError ||
    [400, 401, 403, 422].includes(Number(record?.code ?? record?.statusCode))
  ) {
    return "permanent";
  }
  return "retryable";
}

/** Adapt Sandbox operations at composition, leaving OCC independent of runtime placement. */
export function sandboxNamespaceLifecycleBinding(
  compute: ComputeDriver,
  sandbox: SandboxDriver,
  owner: SandboxDriver | InstalledDriver = sandbox,
): NamespaceLifecycleBinding {
  if (
    typeof compute.resolveSandboxNamespaceContext !== "function" ||
    typeof compute.checkNamespaceDeletion !== "function"
  ) {
    throw new Error(
      "The selected Sandbox requires Compute Namespace context and deletion eligibility.",
    );
  }
  const resolve = compute.resolveSandboxNamespaceContext.bind(compute);
  return {
    owner,
    hooks: {
      async ensureNamespace({ namespace, signal }) {
        try {
          await sandbox.ensureNamespace?.(await resolve(namespace, signal));
          return { namespaceId: namespace.id, namespaceReady: true };
        } catch (error) {
          signal.throwIfAborted();
          const failure = namespaceFailure(error);
          const reason =
            error instanceof SandboxNamespaceRefusedError
              ? error.message.replace(/[^A-Za-z0-9._: /@-]/gu, "_").slice(0, 256)
              : "Namespace preparation failed.";
          return {
            namespaceId: namespace.id,
            namespaceReady: false,
            ...(failure === undefined ? {} : { failure, reason }),
          };
        }
      },
      async deleteNamespace({ namespace, signal }) {
        try {
          await sandbox.cleanup(await resolve(namespace, signal));
          return { namespaceId: namespace.id, namespaceDeleted: true };
        } catch (error) {
          signal.throwIfAborted();
          const failure = namespaceFailure(error);
          return {
            namespaceId: namespace.id,
            namespaceDeleted: false,
            ...(failure === undefined ? {} : { failure }),
          };
        }
      },
    },
  };
}
