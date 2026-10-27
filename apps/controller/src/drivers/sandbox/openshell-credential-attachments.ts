import { CredentialSourceRevisionError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  ownedBy,
  sourceBaseUrl,
  type OpenShellCredentialProfiles,
} from "../../backends/openshell-credential-profiles.ts";
import { normalizeOpenAiBaseUrl } from "../openai-endpoint.ts";
import {
  CODEX_OAUTH_TYPE,
  CODEX_ACCESS_TOKEN_ENV,
  codexAccountMetadata,
} from "../credential-refresh/codex-device-authorization.ts";
import type {
  CredentialAttachmentStatus,
  CredentialSourceAttachment,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import { confirmSandboxAbsent, gatewayIdentityRefusal } from "./openshell-gateway-client.ts";

/** The paired Sandbox uses its Workspace identity to prepare, observe and revoke provider attachments. */
export function openShellCredentialAttachments(
  gateway: Pick<OpenShellGateway, "clientForNamespace" | "placement">,
  profiles?: OpenShellCredentialProfiles,
): NonNullable<SandboxDriver["credentialAttachments"]> {
  return {
    async prepare(context) {
      if (profiles === undefined) {
        throw new Error("The OpenShell Sandbox has no credential source profiles configured.");
      }
      const workspace = openShellWorkspaceName(context.namespace);
      const client = gateway.clientForNamespace(context.namespace.name);
      const attachments: CredentialSourceAttachment[] = [];
      const environment = new Set<string>();
      for (const source of context.sources) {
        if (source.driverId !== profiles.id || source.namespaceId !== context.namespace.id) {
          throw new ScopeViolationError("The credential source is not owned by this gateway.");
        }
        const type = profiles.sourceType(source.type);
        if (type.catalog.type === "openai") {
          if (
            (context.revision.harness.id !== "codex" &&
              context.revision.harness.id !== "openclaw") ||
            context.revision.harness.mode !== "dedicated"
          ) {
            throw new ScopeViolationError(
              "OpenShell OpenAI-compatible credential sources require a dedicated Harness.",
            );
          }
          if (context.revision.harness.id === "openclaw") {
            const providers = asRecord(asRecord(context.revision.configuration?.models)?.providers);
            const provider = asRecord(providers?.openai);
            const catalog = provider?.models;
            const endpoint = sourceBaseUrl(source.config);
            if (
              !Array.isArray(catalog) ||
              catalog.length === 0 ||
              catalog.some((model) => {
                const written = asRecord(model)?.baseUrl ?? provider?.baseUrl;
                return typeof written !== "string" || normalizeOpenAiBaseUrl(written) !== endpoint;
              })
            ) {
              throw new ScopeViolationError(
                "Dedicated native OpenClaw model endpoints must match the bound credential source endpoint.",
              );
            }
          }
        }
        // Two sources cannot place their placeholders in the same Sandbox variable.
        for (const name of Object.values(type.credentials(source.config))) {
          if (environment.has(name)) {
            throw new CredentialSourceRevisionError(
              "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
              "Two credential sources bound to the revision use the same environment variable.",
            );
          }
          environment.add(name);
        }
        const name = openShellProviderName(source.id);
        const provider = await client.getProvider(workspace, name, context.signal);
        if (provider === undefined || !ownedBy(provider, source.id)) {
          throw new Error("The OpenShell provider for a bound credential source is unavailable.");
        }
        // Each deployment applies the current binary lists to the profiles it attaches. OpenShell
        // composes Sandbox policy from the stored profile, so attached Sandboxes narrow too.
        await profiles.ensure(
          client,
          workspace,
          type,
          source.id,
          source.config,
          gateway.placement(context.namespace.name),
          context.signal,
        );
        attachments.push(
          Object.freeze({
            sourceId: source.id,
            ref: name,
            ...(source.type === CODEX_OAUTH_TYPE
              ? {
                  externalChatgptAuth: {
                    ...codexAccountMetadata(provider.config),
                    accessTokenPlaceholder: `openshell:resolve:env:${CODEX_ACCESS_TOKEN_ENV}`,
                  },
                }
              : {}),
          }),
        );
      }
      return Object.freeze(attachments);
    },
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
