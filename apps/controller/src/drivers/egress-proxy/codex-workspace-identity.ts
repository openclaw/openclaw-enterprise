import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
  verifiedSourceIdentityMatches,
  type CredentialProxyDriver,
  type CredentialProviderDefinition,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import {
  createCodexWorkspacePatProvider,
  type CodexWorkspaceAuthority,
} from "./codex-workspace-provider.ts";

const issuer = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
const origin = "https://chatgpt.com";

/** Reads only OCC-owned evidence, never source configuration or workload metadata. */
const authority: CodexWorkspaceAuthority = {
  workspaceForSource(source) {
    const admitted = source.egress;
    if (
      source.type !== "codex-pat" ||
      admitted?.adoption !== "live" ||
      admitted.key.namespaceId !== source.namespaceId ||
      admitted.key.source.id !== source.id ||
      !verifiedSourceIdentityMatches(admitted) ||
      admitted.verifiedIdentity!.issuer !== issuer ||
      admitted.verifiedIdentity!.origin !== origin
    ) {
      return undefined;
    }
    return admitted.verifiedIdentity!.subject;
  },
};

const verifySource: NonNullable<CredentialProviderDefinition["verifySource"]> = async (
  material,
  lifetime,
) => {
  const remaining = Date.parse(lifetime.deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || lifetime.signal.aborted) {
    throw new Error("Workspace identity verification expired.");
  }
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.ceil(remaining))]);
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      // Deployment-owned Node trust roots apply. No URL, redirect, proxy, or TLS override
      // comes from a source, Agent, provider reply, or credential contents.
      const outgoing = request(
        issuer,
        {
          method: "GET",
          signal,
          rejectUnauthorized: true,
          checkServerIdentity,
          headers: { authorization: `Bearer ${material.value}`, accept: "application/json" },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
              response.headers["content-type"] ?? "",
            ) ||
            response.headers.location !== undefined ||
            response.headers["content-encoding"] !== undefined
          ) {
            response.destroy();
            reject(new Error("Invalid identity response."));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              response.destroy(new Error("Identity response exceeds limit."));
            } else {
              chunks.push(chunk);
            }
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.rawTrailers.length || !response.complete) {
              reject(new Error("Invalid identity framing."));
            } else {
              resolve(Buffer.concat(chunks));
            }
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    signal.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body = asRecord(parseUnambiguousJson(text));
    const subject = body?.chatgpt_account_id;
    if (
      typeof subject !== "string" ||
      subject.trim() !== subject ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(subject) ||
      body?.chatgpt_account_is_fedramp !== false ||
      [
        material.value,
        encodeURIComponent(material.value),
        Buffer.from(material.value).toString("base64"),
        Buffer.from(material.value).toString("base64url"),
      ].some((value) => subject.includes(value))
    ) {
      throw new Error("Invalid identity scope.");
    }
    // The standard (non-FedRAMP) identity contract fixes the backend; response URLs
    // do not select an audience. Discard all other identity fields, including PII.
    return { issuer, subject, origin };
  } catch {
    // Transport/parser errors can contain response details; expose no cause or payload.
    throw new Error("Workspace identity verification failed.");
  }
};

export const verifiedCodexWorkspaceProvider: CredentialProviderDefinition = Object.freeze({
  ...createCodexWorkspacePatProvider(authority),
  verifySource,
});

/** Used by external Installation composition only when this exact profile is reported.
 * The package retains responsibility for sender qualification and assertAvailable evidence. */
export function bindVerifiedCodexWorkspaceSource(
  proxy: CredentialProxyDriver,
): CredentialProxyDriver {
  const provider = verifiedCodexWorkspaceProvider;
  if (!proxy.sourceControl.providers.some((entry) => isDeepStrictEqual(entry.ref, provider.ref))) {
    return proxy;
  }
  const providers = proxy.sourceControl.providers.map((entry) => {
    if (!isDeepStrictEqual(entry.ref, provider.ref)) {
      return entry;
    }
    if (entry.sourceType.type !== "codex-pat" || entry.sourceOwnership !== "proxy") {
      throw new Error("The reported workspace provider has invalid ownership.");
    }
    return provider;
  });
  const control = proxy.sourceControl;
  // Keep lifecycle methods bound to the package instance, including private fields.
  return {
    id: proxy.id,
    capability: proxy.capability,
    implementation: proxy.implementation,
    ...(proxy.computeLifecycleHooks && { computeLifecycleHooks: proxy.computeLifecycleHooks }),
    sourceControl: Object.freeze({
      backend: control.backend,
      sender: control.sender,
      resolver: control.resolver,
      providers: Object.freeze(providers),
      assertAvailable: control.assertAvailable.bind(control),
    }),
    ...(proxy.policyReduction && { policyReduction: proxy.policyReduction }),
    ...(proxy.bindExchange && { bindExchange: proxy.bindExchange.bind(proxy) }),
    ...(proxy.bindRepositoryGit && { bindRepositoryGit: proxy.bindRepositoryGit.bind(proxy) }),
    configureRevision: proxy.configureRevision.bind(proxy),
    wiringStatus: proxy.wiringStatus.bind(proxy),
    verifyInstallation: proxy.verifyInstallation.bind(proxy),
    removeRevision: proxy.removeRevision.bind(proxy),
  };
}
