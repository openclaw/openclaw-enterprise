import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { openShellSavedAccountPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-saved-account-policy.ts";

const execute = promisify(execFile);

/** The published OpenShell relay terminates the worker TLS connection, requests a
 * credential from OCC and forwards the request to a separately authenticated HTTPS origin. */
export async function verifyNativeBrowserAccountTools({
  install,
  revision,
  origin,
  peer,
  accounts,
  releaseFiles,
  workerConfig,
  withdraw,
}) {
  const archive = process.env.OCC_TEST_BROWSER_ACCOUNT_WORKER;
  const binary = process.env.OCC_TEST_OPENSHELL_BROWSER_ACCOUNT_RELAY;
  assert(
    archive && binary,
    "Supply the patched worker archive and native OpenShell worker-stream test binary.",
  );
  const placement = openShellSavedAccountPolicy(revision, peer.middlewareName, [install]);
  assert(placement);
  const [policyName] = Object.keys(placement.networks);
  const directory = await mkdtemp(join(tmpdir(), "oce-browser-account-worker-"));
  const env = {
    PATH: process.env.PATH,
    NODE_EXTRA_CA_CERTS: origin.tls.caPath,
    NO_PROXY: "*",
    ...placement.environment,
  };
  // These are public selectors. The OAuth token is obtained on each request inside the relay.
  assert(
    Object.values(placement.environment).every((value) => value.startsWith("oce:saved-account:")),
  );
  const native = spawn(
    binary,
    [
      "--exact",
      "l7::relay::request_credential_tests::external_browser_account_worker_stream",
      "--ignored",
      "--nocapture",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(native, "close");
  const lines = createInterface({ input: native.stdout });
  const ready = (async () => {
    for await (const line of lines) {
      if (line === "OCE_BROWSER_ACCOUNT_RELAY_READY") {
        return;
      }
    }
    throw new Error("Native OpenShell relay exited before startup.");
  })();
  // Drain the test runner's stderr. It must not become part of credential-bearing failure reports.
  const relayErrors = [];
  native.stderr.on("data", (chunk) => {
    for (const m of String(chunk).matchAll(
      /OCE_RELAY_REASON=[a-z_0-9]+|UnknownIssuer|InvalidCertificate|BadCertificate|ConnectionRefused|PermissionDenied|invalid L7 policy|TLS handshake/gi,
    ))
      relayErrors.push(m[0]);
  });
  try {
    await origin.workerPort.release();
    const url = new URL(origin.url);
    // The fixture controls the sandbox inventory and signed supervisor identity. The policy and
    // account marker come from the admitted revision and the real OpenShell policy compiler.
    const {
      brokerUrl,
      brokerCaPem,
      audience,
      supervisorToken,
      middlewareName,
      sandboxId,
      sandboxName,
      workspace,
    } = peer;
    native.stdin.end(
      JSON.stringify({
        brokerUrl,
        brokerCaPem,
        audience,
        supervisorToken,
        middlewareName,
        sandboxId,
        sandboxName,
        workspace,
        originHost: url.hostname,
        originPort: Number(url.port),
        originAddress: origin.originAddress,
        ...origin.tls,
        policyName,
        binary: install.binaryPath,
        policy: relayPolicy(placement),
      }),
    );
    await ready;
    await execute("tar", ["-xzf", archive, "-C", directory]);
    const worker = spawn(process.execPath, [join(directory, "worker/call-accounts.mjs")], {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const workerClosed = once(worker, "close");
    const workerErrors = [];
    worker.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (/node host MCP server|^AssertionError|^Error:/.test(line)) {
          // Only classify known fixture failures; never surface HTTP headers or bodies.
          const categories = line.match(
            /HTTP [0-9]{3}|\b[45][0-9][0-9]\b|[A-Z_]{3,}|blocked|private network|internal IP|authentication refused|transport error|worker must project|missing|Invalid managed|disallowed|fetch failed|Unsupported|Cannot find module|certificate|permission denied|not allowed|unexpected response|invalid response|MCP error|SDK error|connection closed|server disconnected|Invalid content.type/g,
          );
          workerErrors.push(...(categories ?? ["unclassified MCP failure"]));
          if (line.startsWith("node host MCP server")) {
            const message = line.split("failed: ")[1] ?? "";
            workerErrors.push(
              message
                .replace(/[A-Za-z0-9._/+:-]{24,}|Bearer +[^ ]+|https?:\/\/[^ ]+/gi, "[redacted]")
                .slice(0, 100),
            );
          }
        }
      }
    });
    const replies = createInterface({ input: worker.stdout });
    try {
      worker.stdin.write(
        JSON.stringify({ plugins: workerConfig, releaseFiles, bindings: accounts }) + "\n",
      );
      for await (const line of replies) {
        if (line === "OCE_BROWSER_ACCOUNTS_VERIFIED") {
          await withdraw();
          worker.stdin.end("withdrawn\n");
        } else if (line.startsWith("{")) {
          const result = JSON.parse(line);
          assert.equal(result.withdrawnDenied, true);
          assert.deepEqual(
            result.verifiedAccounts.map(({ handle, subject }) => [handle, subject]),
            accounts.map(({ handle, expectedSubject }) => [handle, expectedSubject]),
          );
          assert.equal((await workerClosed)[0], 0);
          return result;
        }
      }
      throw new Error(
        "The worker did not verify the selected identities and withdrawal. Worker: " +
          workerErrors.slice(-15).join(" ") +
          "; native: " +
          relayErrors.slice(-8).join(" ") +
          "; last origin methods: " +
          origin.responses.slice(-9).join(","),
      );
    } finally {
      worker.kill();
      replies.close();
    }
  } finally {
    native.kill();
    await closed;
    lines.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// The native test entry point consumes the policy schema's JSON/YAML representation.
// Convert only the protobuf enum, Struct and matcher encodings used by the released MCP route.
function relayPolicy(placement) {
  const network_policies = Object.fromEntries(
    Object.entries(placement.networks).map(([name, network]) => [
      name,
      {
        ...network,
        endpoints: network.endpoints.map(({ ports, enforcement, rules, ...endpoint }) => {
          assert.equal(enforcement, "NETWORK_ENFORCEMENT_MODE_ENFORCE");
          return {
            ...endpoint,
            port: ports[0],
            enforcement: "enforce",
            rules: rules.map(({ allow }) => ({
              allow: allow.params ? { method: allow.method, tool: allow.params.name.glob } : allow,
            })),
          };
        }),
      },
    ]),
  );
  const network_middlewares = Object.fromEntries(
    Object.entries(placement.middlewares).map(([name, middleware]) => [
      name,
      {
        ...middleware,
        config: Object.fromEntries(
          Object.entries(middleware.config.fields).map(([key, value]) => [
            key,
            value.stringValue ?? value.listValue.values.map((item) => item.stringValue),
          ]),
        ),
      },
    ]),
  );
  return { network_policies, network_middlewares };
}
