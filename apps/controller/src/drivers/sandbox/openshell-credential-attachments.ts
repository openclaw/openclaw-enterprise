import type { CredentialAttachmentStatus, SandboxDriver } from "@openclaw-enterprise/contracts";
import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import { confirmSandboxAbsent, gatewayIdentityRefusal } from "./openshell-gateway-client.ts";

/** The paired Sandbox uses its Workspace identity to observe and revoke provider attachments. */
export function openShellCredentialAttachments(
  gateway: Pick<OpenShellGateway, "clientForNamespace">,
): NonNullable<SandboxDriver["credentialAttachments"]> {
  return {
    async status(context) {
      if (context.sandbox === undefined) {
        throw new Error("OpenShell attachment status requires the provisioned Sandbox.");
      }
      const workspace = openShellWorkspaceName(context.namespace);
      const client = gateway.clientForNamespace(context.namespace.name);
      const statuses: CredentialAttachmentStatus[] = [];
      for (const source of context.sources) {
        const status = await client.getSandboxProviderStatus(
          workspace,
          context.sandbox.resourceName,
          openShellProviderName(source.id),
          context.signal,
        );
        statuses.push(
          Object.freeze({
            sourceId: source.id,
            state: attachmentState(status.state),
            ...(status.reason === undefined ? {} : { reason: status.reason }),
          }),
        );
      }
      return Object.freeze(statuses);
    },

    /**
     * Detaches the source's provider from the revision's Sandbox. Only a REVOKED receipt reports
     * `revoked`: the Sandbox's placeholders then stop resolving, even in running processes. A
     * missing Sandbox reports `absent` only once GetWorkspace proves this identity still sees the
     * Workspace and a second GetSandbox still finds none: GetSandbox and DetachSandboxProvider
     * answer NOT_FOUND alike for a Sandbox that is gone and for one the identity may not see
     * (finding 1676), and `absent` settles the withdrawal while a hidden Sandbox would keep
     * resolving the credential. A Sandbox the second read finds (a role restored between the
     * reads, finding 1692) is detached instead; a detach that misses it again is unconfirmed, and
     * the worker retries. A refusal fails with `SANDBOX_GATEWAY_UNAUTHORIZED`, which the worker
     * records as the withdrawal's reason and fails it with; a replay tries again once the
     * identity's role is restored.
     */
    async withdraw(context) {
      const workspace = openShellWorkspaceName(context.namespace);
      const client = gateway.clientForNamespace(context.namespace.name);
      const provider = openShellProviderName(context.sourceId);
      const sandbox = context.sandbox.resourceName;
      const unconfirmed = `the credential of Sandbox ${sandbox} cannot be confirmed withdrawn`;
      const refused = gatewayIdentityRefusal(workspace, unconfirmed);
      const read = () => client.getSandbox({ name: sandbox, workspace }, context.signal);
      const listsProvider = (record: { readonly spec?: { readonly providers?: unknown } }) => {
        const providers = record.spec?.providers;
        return Array.isArray(providers) && providers.includes(provider);
      };
      // Detach is idempotent; a replay after an uncertain detach still returns a receipt.
      const detach = () =>
        refused(() => client.detachSandboxProvider(workspace, sandbox, provider, context.signal));
      const settle = async (receiptId: string | undefined): Promise<CredentialAttachmentStatus> => {
        const status = await refused(() =>
          client.getSandboxProviderStatus(workspace, sandbox, provider, context.signal, receiptId),
        );
        const state = attachmentState(status.state);
        return Object.freeze({
          sourceId: context.sourceId,
          state: state === "revoked" ? "revoked" : "pending",
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        });
      };
      const absent = async (): Promise<CredentialAttachmentStatus> => {
        const restored = await confirmSandboxAbsent(
          client,
          workspace,
          context.signal,
          refused,
          () => new Error(`OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`),
          read,
        );
        if (restored === undefined) {
          // A missing Sandbox has no placeholders left to resolve, once it is confirmed missing.
          return Object.freeze({ sourceId: context.sourceId, state: "absent" });
        }
        if (context.recheck === true && !listsProvider(restored)) {
          return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
        }
        const detached = await detach();
        if (detached === undefined) {
          throw new Error(
            `OpenShell GetSandbox finds Sandbox ${sandbox} but DetachSandboxProvider did not, so ${unconfirmed}.`,
          );
        }
        return settle(detached.receiptId);
      };
      if (context.recheck === true) {
        // A recorded revocation needs a new detach only if the Sandbox lists the provider again,
        // for example after a create that OpenShell accepted before the withdrawal landed after it.
        const existing = await refused(read);
        if (existing === undefined) {
          return absent();
        }
        if (!listsProvider(existing)) {
          return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
        }
      }
      const detached = await detach();
      return detached === undefined ? absent() : settle(detached.receiptId);
    },
  };
}

function attachmentState(state: string): CredentialAttachmentStatus["state"] {
  switch (state) {
    case "PROVIDER_READINESS_STATE_READY":
      return "ready";
    case "PROVIDER_READINESS_STATE_WITHHELD":
      return "withheld";
    case "PROVIDER_READINESS_STATE_REVOKED":
      return "revoked";
    case "PROVIDER_READINESS_STATE_FAILED":
      return "failed";
    default:
      return "pending";
  }
}
