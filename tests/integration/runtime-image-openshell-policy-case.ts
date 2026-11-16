import assert from "node:assert/strict";
import { join } from "node:path";
import { OPENSHELL_CODEX_APP_SERVER_POLICY } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import {
  probeOpenShellPeer,
  probeOpenShellPolicy,
} from "../fixtures/runtime-image-startup/openshell-policy.ts";
import {
  bundledExport,
  loadCodexClient,
  loadCodexConfig,
} from "../fixtures/runtime-image-startup/bundled-codex.ts";
import { list, parseJson, record, text } from "../fixtures/runtime-image-startup/wire.ts";
import { renderProbe } from "./runtime-image-startup-support.ts";

export async function verifyOpenShellPolicy(image: string, historicalCodex: boolean) {
  // The bundled resolver must preserve OpenShell isolation for both login modes and the
  // human reviewer, including models without model-backed review support.
  const documented = {
    mode: "guardian",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    transport: "websocket",
    url: "ws://127.0.0.1:1",
    authToken: "synthetic",
  };
  const cases = [
    { documented },
    { documented: { ...documented, approvalPolicy: "never" } },
    { documented: { ...documented, sandbox: "danger-full-access" } },
    { documented: { ...documented, approvalsReviewer: "auto_review" } },
  ].flatMap(({ documented: appServer }) =>
    // The Gateway passes no provider for the documented `codex/<model>` ref; `openai` is a
    // model it can verify for model-backed review.
    [undefined, "openai"].map((modelProvider) => ({
      appServer: { ...appServer, ...OPENSHELL_CODEX_APP_SERVER_POLICY },
      modelProvider,
    })),
  );

  const script = renderProbe(
    probeOpenShellPolicy,
    [
      historicalCodex,
      bundledExport,
      loadCodexClient,
      loadCodexConfig,
      list,
      parseJson,
      record,
      text,
      probeOpenShellPeer,
    ],
    "module",
  );
  const { stdout } = await runDocker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "node",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home/node:uid=1000,gid=1000,mode=700",
    "--mount",
    `type=bind,source=${join(import.meta.dirname, "../fixtures/codex-read-only-requirements.toml")},destination=/etc/codex/requirements.toml,readonly`,
    "--workdir",
    "/app",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    script,
    JSON.stringify(cases),
  ]);
  assert.deepEqual(
    parseJson(stdout),
    cases.map(({ appServer }) => ({
      sandbox: appServer.sandbox,
      approvalsReviewer: "user",
    })),
  );
}
