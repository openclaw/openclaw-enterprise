import { randomUUID } from "node:crypto";
import { Agent, request } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  requireCurrentBinding,
} from "./manifest.ts";
import { readPrivateFile } from "./private-files.ts";

/** Exactly one HTTPS exchange, with the broker or through the selected OpenShell proxy. */
export async function createDraftPull(args: string[], manifestRoot?: string) {
  const { values: q, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      head: { type: "string" },
      base: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      "operation-id": { type: "string" },
      draft: { type: "boolean" },
    },
  });
  const { head, base, title, body = "", draft } = q;
  if (
    positionals.length !== 1 ||
    positionals[0] !== "pr-create" ||
    !draft ||
    !head ||
    !base ||
    !title
  ) {
    throw new Error("invalid-draft-pull-arguments");
  }
  const operationId = q["operation-id"] ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    throw new Error("invalid-operation-id");
  }
  const { client, bearer, ca, check, openShell } = await transport(head, base, manifestRoot);
  const { gatewayOrigin, repository } = client;
  const bytes = Buffer.from(
    JSON.stringify({
      title,
      head,
      base,
      body,
      draft,
      ...(openShell && { maintainer_can_modify: false }),
    }),
  );
  if (bytes.length > 65536) {
    throw new Error("draft-pull-request-too-large");
  }
  const path = "/repos/" + repository + "/pulls";
  // Record the ID before the first possible send. A failed response may mean a draft was created.
  process.stderr.write(
    (openShell ? "local draft attempt " : "draft pull operation ") + operationId + "\n",
  );
  try {
    check?.();
    // The managed Agent shell reaches the bound broker through its HTTPS proxy. Never use
    // NO_PROXY or retry directly after a proxy failure. TLS authenticates the broker end to end.
    const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
    if (openShell && !proxy) {
      throw new Error("openshell-https-proxy-required");
    }
    const agent = new Agent({
      keepAlive: false,
      ...(proxy ? { proxyEnv: { HTTPS_PROXY: proxy } } : {}),
    });
    const receipt = await new Promise<string>((resolve, reject) => {
      const req = request(
        gatewayOrigin + path,
        {
          method: "POST",
          agent,
          ca,
          rejectUnauthorized: true,
          headers: {
            "content-type": "application/json",
            "content-length": bytes.length,
            ...(openShell
              ? { "user-agent": "openclaw-enterprise", accept: "application/vnd.github+json" }
              : { "x-oce-operation-id": operationId }),
            authorization: "Bearer " + bearer.toString(),
          },
          signal: AbortSignal.timeout(35000),
        },
        async (res) => {
          try {
            let data = "";
            for await (const chunk of res) {
              data += String(chunk);
              if (data.length > (openShell ? 1024 * 1024 : 8192)) {
                throw new Error("unrecognized-receipt");
              }
            }
            const result = JSON.parse(data);
            if (openShell) {
              // OCE authorizes this create once; only GitHub's reply confirms its outcome.
              const { html_url: url, number } = result;
              if (
                res.statusCode !== 201 ||
                result.state !== "open" ||
                result.draft !== true ||
                !Number.isSafeInteger(number) ||
                number < 1 ||
                url !== `https://github.com/${repository}/pull/${number}` ||
                result.head?.ref !== head ||
                result.head?.repo?.full_name !== repository ||
                result.base?.ref !== base ||
                result.base?.repo?.full_name !== repository
              ) {
                throw new Error("github-draft-not-confirmed");
              }
              resolve(JSON.stringify({ url, number, head, base, draft: true }));
              return;
            }
            if (
              res.statusCode === 201 &&
              result.operationId === operationId &&
              result.state === "open" &&
              result.draft === true &&
              result.head?.ref === head &&
              result.base?.ref === base &&
              result.url === "https://github.com/" + repository + "/pull/" + result.number
            ) {
              resolve(JSON.stringify(result));
            } else {
              if (
                [
                  "outcome_unknown",
                  "operation_conflict",
                  "not-submitted",
                  "unsupported-request",
                ].includes(result.error)
              ) {
                process.stderr.write("draft pull " + result.error + "\n");
              }
              reject(new Error("draft-pull-receipt-unavailable"));
            }
          } catch {
            reject(new Error("draft-pull-receipt-unavailable"));
          }
        },
      );
      req.once("error", reject);
      req.end(bytes);
    });
    process.stdout.write(receipt + "\n");
  } finally {
    bearer.fill(0);
  }
}

async function transport(head: string, base: string, manifestRoot?: string) {
  const env = process.env;
  const repository = env.OCE_OPENSHELL_GIT_REPOSITORY;
  if (repository !== undefined) {
    const marker = env.GITHUB_TOKEN ?? "";
    // These are client-side mistake checks, not authorization. Never send an ambient token.
    if (
      !/^[\w-]+\/[\w.-]+$/.test(repository) ||
      env.OCE_OPENSHELL_GIT_PUSH_REF !== "refs/heads/" + head ||
      env.OCE_OPENSHELL_GIT_BASE !== base ||
      env.OCE_OPENSHELL_GIT_API_ORIGIN !== "https://api.github.com" ||
      !/^openshell:resolve:env:s[a-f0-9]{64}_GITHUB_TOKEN$/.test(marker)
    ) {
      throw new Error("openshell-draft-binding-required");
    }
    return {
      client: { gatewayOrigin: "https://api.github.com", repository },
      bearer: Buffer.from(marker),
      ca: undefined,
      check: undefined,
      openShell: true,
    };
  }
  const manifest = await readRuntimeRepositoryManifest(manifestRoot);
  const b =
    inheritedRepositoryBinding(manifest, env) ??
    (manifest.bindings.length === 1 ? manifest.bindings[0] : undefined);
  if (!b) {
    throw new Error("no-single-selected-repository");
  }
  const check = () => requireCurrentBinding(b);
  check();
  const ca = b.configuration.hasPublicCa
    ? await readPrivateFile(join(b.directory, "ca.pem"), 65536)
    : undefined;
  const bearer = await readPrivateFile(join(b.directory, "bearer"), 256);
  return { client: b.client, ca, bearer, check, openShell: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createDraftPull(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Draft not confirmed. Check the pull requests at the repository; do not submit another create.\n",
    );
    process.exitCode = 1;
  });
}
