import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { TestContext } from "node:test";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  openShellGitMiddleware,
  type OpenShellGitRuntime,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { listen } from "./listen.mjs";
import { temporaryDirectory } from "./temporary-directory.ts";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";

type GitPreparation = Awaited<ReturnType<OpenShellGitRuntime["prepare"]>>;
type LaunchSpec = {
  command: readonly string[];
  environment: Record<string, string>;
};

export async function verifyOpenShellGrantGitLauncher(
  t: TestContext,
  provision: (git: GitPreparation, program: string) => Promise<LaunchSpec>,
) {
  const tls = await harnessTlsFixture(t);
  const requests: [string | undefined, string | undefined][] = [];
  const origin = createServer(tls, (request, response) => {
    requests.push([request.url, request.headers.authorization]);
    response.writeHead(302, { location: "/example/redirected.git/info/refs" });
    response.end();
  });
  const port = await listen(t, origin);
  const base = `https://localhost:${port}`;
  const repository = `${base}/example/project.git`;
  const neighbor = `${base}/example/project.git-neighbor`;
  // The Driver receives a selected route and a program in place of the Harness.
  // Its actual launcher runs first, then real Git contacts the controlled origin.
  const spec = await provision(
    {
      provider: "fixture-grant-provider",
      grantRepositoryUrl: repository,
      readOnlyPaths: [],
      middlewares: openShellGitMiddleware("oce-prepared-git", "fixture-binding"),
      environment: [
        { name: "GIT_CONFIG_COUNT", value: "4" },
        { name: "GIT_CONFIG_KEY_0", value: "credential.helper" },
        { name: "GIT_CONFIG_VALUE_0", value: "" },
        { name: "GIT_CONFIG_KEY_1", value: "http.followRedirects" },
        { name: "GIT_CONFIG_VALUE_1", value: "false" },
        { name: "GIT_CONFIG_KEY_2", value: "http.sslVerify" },
        { name: "GIT_CONFIG_VALUE_2", value: "true" },
        { name: "GIT_CONFIG_KEY_3", value: "safe.directory" },
        { name: "GIT_CONFIG_VALUE_3", value: "/sandbox/enterprise" },
      ],
    },
    `const { spawnSync } = require("node:child_process");
    for (const remote of ${JSON.stringify([repository, neighbor])}) {
      const { error, status } = spawnSync("git", ["ls-remote", remote], { stdio: "ignore" });
      if (error || status !== 128) process.exit(1);
    }
    const { error, status } = spawnSync("git", ["config", "--get-urlmatch", "http.extraHeader",
      "https://api.github.com/example/project.git"], { stdio: "ignore" });
    if (error || status !== 1) process.exit(1);`,
  );
  assert.equal(spec.environment.GITHUB_TOKEN, undefined);
  assert.equal(spec.environment.GIT_CONFIG_VALUE_4, undefined);
  const cwd = await temporaryDirectory(t, "openshell-grant-git-launch-");
  const launch = (handle: string | undefined) => {
    const options = {
      cwd,
      env: cleanEnvironment({
        ...spec.environment,
        HOME: cwd,
        PATH: process.env.PATH,
        GIT_SSL_CAINFO: tls.rootCertificatePath,
        GITHUB_TOKEN: handle,
      }),
      timeout: 5_000,
      allowFailure: true,
      signal: t.signal,
    };
    return run(
      process.execPath,
      ["-e", ...spec.command.slice(RUNTIME_WRAPPER_COMMAND.length)],
      options,
    );
  };
  for (const handle of [undefined, "raw-credential-fixture"]) {
    const refused = await launch(handle);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /OpenShell Git credential placeholder is unavailable/);
    assert.deepEqual(requests, []);
  }
  const handle = "openshell:resolve:env:g" + "ab".repeat(32) + "_GITHUB_TOKEN";
  const launched = await launch(handle);
  assert.equal(launched.code, 0, launched.stderr);
  assert.deepEqual(requests, [
    [
      "/example/project.git/info/refs?service=git-upload-pack",
      "Basic " + Buffer.from("x-access-token:" + handle).toString("base64"),
    ],
    ["/example/project.git-neighbor/info/refs?service=git-upload-pack", undefined],
  ]);
}
