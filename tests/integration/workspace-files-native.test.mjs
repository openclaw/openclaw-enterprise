import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  createAdmittedRuntimeImageConfiguration,
  execute,
  image,
  runDocker,
} from "../helpers/runtime-image-startup.mjs";

const envoyImage = process.env.OCC_TEST_WORKSPACE_ENVOY_IMAGE;
const selected = image !== undefined || envoyImage !== undefined;
const options = selected
  ? { timeout: 180_000 }
  : { skip: "Set OCC_TEST_RUNTIME_IMAGE and OCC_TEST_WORKSPACE_ENVOY_IMAGE to prepared images." };

function envoyConfiguration() {
  return {
    static_resources: {
      listeners: [
        {
          name: "workspace-wss",
          address: { socket_address: { address: "0.0.0.0", port_value: 8443 } },
          filter_chains: [
            {
              transport_socket: {
                name: "envoy.transport_sockets.tls",
                typed_config: {
                  "@type":
                    "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
                  common_tls_context: {
                    tls_certificates: [
                      {
                        certificate_chain: { filename: "/etc/envoy/cert.pem" },
                        private_key: { filename: "/etc/envoy/key.pem" },
                      },
                    ],
                  },
                },
              },
              filters: [
                {
                  name: "envoy.filters.network.http_connection_manager",
                  typed_config: {
                    "@type":
                      "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
                    stat_prefix: "workspace",
                    upgrade_configs: [{ upgrade_type: "websocket" }],
                    route_config: {
                      name: "native-route",
                      virtual_hosts: [
                        {
                          name: "native",
                          domains: ["*"],
                          routes: [
                            { match: { prefix: "/" }, route: { cluster: "native", timeout: "0s" } },
                          ],
                          request_headers_to_add: Object.entries({
                            "x-forwarded-for": "203.0.113.10",
                            "x-real-ip": "203.0.113.10",
                            "x-forwarded-proto": "https",
                            "x-forwarded-host": "localhost",
                          }).map(([key, value]) => ({
                            header: { key, value },
                            append_action: "OVERWRITE_IF_EXISTS_OR_ADD",
                          })),
                        },
                      ],
                    },
                    http_filters: [
                      {
                        name: "envoy.filters.http.router",
                        typed_config: {
                          "@type":
                            "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      clusters: [
        {
          name: "native",
          connect_timeout: "2s",
          type: "STRICT_DNS",
          dns_refresh_rate: "0.1s",
          load_assignment: {
            cluster_name: "native",
            endpoints: [
              {
                lb_endpoints: [
                  {
                    endpoint: {
                      address: {
                        socket_address: { address: "workspace-native", port_value: 18800 },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

async function ready(container) {
  try {
    await runDocker([
      "exec",
      container,
      "node",
      "-e",
      `fetch("http://127.0.0.1:18800/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));`,
    ]);
    return true;
  } catch {
    return false;
  }
}

test(
  "native workspace files follow a sole roster through OCC and preserve explicit targets and grants",
  options,
  async (t) => {
    assert.ok(image, "OCC_TEST_RUNTIME_IMAGE is required when native workspace proof is selected.");
    assert.ok(envoyImage, "OCC_TEST_WORKSPACE_ENVOY_IMAGE must identify a prepared Envoy image.");
    const directory = await mkdtemp(join(tmpdir(), "oce-native-workspace-"));
    const owner = `oce-native-workspace-${randomUUID()}`;
    const network = `${owner}-network`;
    const native = `${owner}-gateway`;
    const envoy = `${owner}-envoy`;
    const containers = new Set();
    t.after(async () => {
      for (const name of containers) {
        await runDocker(["rm", "--force", "--volumes", name]);
      }
      await runDocker(["network", "rm", network]);
      await rm(directory, { recursive: true, force: true });
    });
    await runDocker(["network", "create", "--label", `oce.workspace-proof=${owner}`, network]);
    const [networkDetails] = JSON.parse((await runDocker(["network", "inspect", network])).stdout);
    await execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    // The host directory stays private; only these owned leaf files enter containers.
    await chmod(join(directory, "key.pem"), 0o644);
    await writeFile(join(directory, "envoy.json"), JSON.stringify(envoyConfiguration()));
    const mounts = (files, target) =>
      files.flatMap((file) => [
        "--mount",
        `type=bind,src=${join(directory, file)},dst=${target}/${file},readonly`,
      ]);
    await runDocker([
      "run",
      "--detach",
      "--pull=never",
      "--name",
      envoy,
      "--label",
      `oce.workspace-proof=${owner}`,
      "--network",
      network,
      "--publish",
      "127.0.0.1::8443",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:uid=1000,gid=1000,mode=1777",
      ...mounts(["envoy.json", "cert.pem", "key.pem"], "/etc/envoy"),
      envoyImage,
      "-c",
      "/etc/envoy/envoy.json",
      "--log-level",
      "error",
      "--concurrency",
      "1",
    ]);
    containers.add(envoy);
    const port = Number(
      (await runDocker(["port", envoy, "8443/tcp"])).stdout.trim().split(":").at(-1),
    );
    const cases = [
      {
        entries: { researcher: { workspace: "/home/node/workspace" } },
        explicitAgentId: "researcher",
      },
      { entries: { main: { workspace: "/home/node/workspace" } } },
      {
        ownership: "explicit",
        entries: {
          helper: { workspace: "/home/node/helper-workspace" },
          main: { workspace: "/home/node/workspace" },
        },
      },
    ];
    for (const [index, roster] of cases.entries()) {
      const configuration = structuredClone(createAdmittedRuntimeImageConfiguration("openclaw"));
      const { explicitAgentId, ...agents } = roster;
      configuration.agents = { ...configuration.agents, ...agents };
      configuration.gateway = {
        ...configuration.gateway,
        bind: "lan",
        trustedProxies: [networkDetails.IPAM.Config[0].Subnet],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-api-key",
            allowUsers: ["proof-admin", "proof-read", "proof-write"],
            requiredHeaders: [],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes: [] },
          },
          identityScopes: {
            "proof-admin": ["operator.admin"],
            "proof-read": ["operator.read"],
            "proof-write": ["operator.write"],
          },
        },
      };
      configuration.models.providers.openai.baseUrl = "http://127.0.0.1:18880/v1";
      configuration.models.providers.openai.apiKey = randomUUID();
      await writeFile(join(directory, "config.json"), JSON.stringify(configuration));
      await writeFile(join(directory, "api-key"), "proof-admin", { mode: 0o600 });
      const provider = `let modelCalls=0;require("node:http").createServer((q,r)=>{if(q.method==="POST")modelCalls++;r.end(JSON.stringify(q.url==="/counter"?{modelCalls}:{data:[]}));}).listen(18880,"127.0.0.1");\n`;
      await runDocker([
        "run",
        "--detach",
        "--pull=never",
        "--name",
        native,
        "--label",
        `oce.workspace-proof=${owner}`,
        "--network",
        network,
        "--network-alias",
        "workspace-native",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/home/node:uid=1000,gid=1000,mode=700",
        "--tmpfs",
        "/tmp:uid=1000,gid=1000,mode=1777",
        ...mounts(["config.json"], "/etc/openclaw"),
        "--env",
        "HOME=/home/node",
        "--env",
        "OPENCLAW_STATE_DIR=/home/node/.openclaw",
        "--env",
        "OPENCLAW_CONFIG_PATH=/etc/openclaw/config.json",
        "--env",
        "OPENCLAW_GATEWAY_PORT=18800",
        "--env",
        "OPENCLAW_NO_AUTO_UPDATE=1",
        "--entrypoint",
        "node",
        image,
        "-e",
        ...nodeProgramArguments(provider + GATEWAY_RUNTIME_ENTRYPOINT),
      ]);
      containers.add(native);
      try {
        let available = false;
        for (let attempt = 0; attempt < 60 && !available; attempt++) {
          available = await ready(native);
          if (!available) {
            await delay(250);
          }
        }
        assert.equal(available, true, "Actual native Gateway never became ready.");
        await mkdir(join(directory, "client-home"), { recursive: true });
        // A fresh Node process loads only this test CA before the production WSS client starts.
        const child = execute(
          process.execPath,
          ["tests/fixtures/gateway-routing/workspace-native-probe.mjs"],
          {
            env: {
              PATH: process.env.PATH,
              HOME: join(directory, "client-home"),
              NODE_EXTRA_CA_CERTS: join(directory, "cert.pem"),
              OCC_WORKSPACE_PROOF_KEY_PATH: join(directory, "api-key"),
              OCC_WORKSPACE_PROOF_ENDPOINT: `wss://127.0.0.1:${port}`,
            },
            timeout: 60_000,
          },
        );
        const content = `Owned native workspace ${index}: exact text.\n`;
        child.child.stdin.end(
          JSON.stringify({ agents: configuration.agents, explicitAgentId, content }),
        );
        const result = await child;
        assert.deepEqual(JSON.parse(result.stdout), {
          apiWrite: 200,
          apiRead: 200,
          scopeControls: true,
        });
        // Independently inspect the actual native disk; no fixture returns file RPC answers.
        const stored = await runDocker([
          "exec",
          native,
          "node",
          "-e",
          `process.stdout.write(require("node:fs").readFileSync("/home/node/workspace/USER.md","utf8"));`,
        ]);
        assert.equal(stored.stdout, content);
        const counter = await runDocker([
          "exec",
          native,
          "node",
          "-e",
          `fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));`,
        ]);
        assert.equal(Number(counter.stdout.trim()), 0);
        t.diagnostic(
          JSON.stringify({ roster: index, apiRoundTrip: true, diskReadback: true, modelCalls: 0 }),
        );
      } finally {
        await runDocker(["rm", "--force", "--volumes", native]);
        containers.delete(native);
      }
    }
  },
);
