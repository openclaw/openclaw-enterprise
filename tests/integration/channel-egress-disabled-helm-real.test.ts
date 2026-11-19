import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { postgresImage } from "../../scripts/ci/fixture-support-images.ts";
import { createUpgradeResponseProxy } from "../helpers/channel-upgrade-response-proxy.ts";
import { availablePort } from "../helpers/available-port.ts";
import { installProductionHelmControlPlane } from "../helpers/production-helm-real.ts";
import { runFixtureCommand, type FixtureRun } from "../helpers/production-rehearsal-custody.ts";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";

const selected = process.env.OCC_TEST_CHANNEL_EGRESS_UPGRADE === "1";
test(
  "one-off upgrades an actual disabled Helm installation without Envoy or Agent transitions",
  {
    skip: selected ? false : "Select the explicit channel-egress-upgrade QA scenario.",
    timeout: 900_000,
  },
  async (t) => {
    const selection = {
      kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG!,
      kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT!,
    };
    await validateExplicitK3dLoopbackContext(selection);
    const controller = process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE!;
    const sourceController = process.env.OCC_TEST_CHANNEL_EGRESS_SOURCE_CONTROLLER_IMAGE!;
    const sourceChart = process.env.OCC_TEST_CHANNEL_EGRESS_SOURCE_CHART!;
    const runtime = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE!;
    for (const image of [controller, sourceController, runtime]) {
      assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/);
    }
    assert.ok(sourceChart);
    const suffix = randomBytes(5).toString("hex");
    const namespace = `oce-channel-off-${suffix}`;
    const release = `channel-off-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "oce-channel-off-"));
    const secrets: string[] = [];
    const secret = () => {
      const value = randomBytes(32).toString("hex");
      secrets.push(value);
      return value;
    };
    const run: FixtureRun = (command, args, options = {}) =>
      runFixtureCommand(
        command,
        args,
        { ...options, protectedInput: options.input !== undefined },
        (value) =>
          secrets.reduce((text, item) => text.replaceAll(item, "[REDACTED]"), String(value)),
        true,
      );
    const kube = createKubernetesClient({ selection });
    const { kubectl, resource, waitFor } = kube;
    const helmTarget = [
      "--kubeconfig",
      selection.kubeconfigPath,
      "--kube-context",
      selection.kubernetesContext,
      "--namespace",
      namespace,
    ];
    t.after(async () => {
      for (const name of [release, `${release}-postgres`]) {
        await run("helm", ["uninstall", name, ...helmTarget, "--ignore-not-found"], {
          allowFailure: true,
        });
      }
      await kubectl(
        "delete",
        "namespace",
        namespace,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=120s",
      );
      await rm(directory, { recursive: true, force: true });
    });
    await kubectl("create", "namespace", namespace);
    const configuration = createKubernetesInstallationConfiguration({
      authentication: { mode: "inCluster" },
      platformNamespace: namespace,
      gatewayImage: runtime,
      codexImage: runtime,
      cluster: `channel-off-${suffix}`,
    });
    const sourceCidrs = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS;
    assert.ok(sourceCidrs);
    Object.assign(configuration.drivers.compute.configuration.network, {
      pluginStatusProxySourceCidrs: sourceCidrs.split(","),
    });
    const controlPlane = await installProductionHelmControlPlane({
      selection,
      namespace,
      release,
      directory,
      suffix,
      configuration,
      images: {
        controller: sourceController,
        postgres: process.env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE ?? postgresImage,
      },
      chartDirectory: sourceChart,
      slackProxy: { enabled: false },
      authBaseURL: "https://console.example.invalid",
      agentNativeAdminDomain: "agents.example.invalid",
      installationName: `Disabled channel proof ${suffix}`,
      bootstrapCredentials: "existing",
      apiClients: [{ namespace, podLabels: { app: "channel-off-operator" } }],
      run,
      kubernetes: kube,
      createSecretValue: secret,
      record: () => {},
    });
    assert.ok(controlPlane.serviceKey);
    secrets.push(controlPlane.serviceKey);
    // This peer is admitted by the chart's real API ingress policy. It forwards
    // bytes to the actual API; no API responses or lifecycle decisions are mocked.
    await run("kubectl", kube.kubectlArguments(["create", "-f", "-"]), {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "operator", namespace, labels: { app: "channel-off-operator" } },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "operator",
              image: controller,
              command: [
                "node",
                "-e",
                "const h=require('http');h.createServer((q,s)=>{const r=h.request({hostname:process.env.UPSTREAM,port:8080,path:q.url,method:q.method,headers:q.headers},p=>{s.writeHead(p.statusCode,p.headers);p.pipe(s)});r.on('error',()=>{s.writeHead(502);s.end()});q.pipe(r)}).listen(8080,'0.0.0.0')",
              ],
              env: [{ name: "UPSTREAM", value: `openclaw-enterprise-api.${namespace}.svc` }],
              readinessProbe: { tcpSocket: { port: 8080 } },
            },
          ],
        },
      }),
    });
    await kubectl(
      "wait",
      "pod/operator",
      "--namespace",
      namespace,
      "--for=condition=Ready",
      "--timeout=120s",
    );
    const port = await availablePort();
    const forward = spawn(
      "kubectl",
      kube.kubectlArguments([
        "port-forward",
        "pod/operator",
        "--namespace",
        namespace,
        `${port}:8080`,
        "--address=127.0.0.1",
      ]),
      { stdio: "ignore" },
    );
    t.after(async () => {
      forward.kill("SIGTERM");
      if (forward.exitCode === null) {
        await new Promise<void>((resolve) => forward.once("exit", () => resolve()));
      }
    });
    const url = `http://127.0.0.1:${port}`;
    const request = async (path: string) => {
      const response = await fetch(url + path, {
        headers: { "x-api-key": controlPlane.serviceKey },
      });
      assert.equal(response.status, 200);
      return asRecord(asRecord(await response.json())?.data)!;
    };
    await waitFor("the real disabled installation API", async () => {
      try {
        return (await fetch(url + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const certPath = join(directory, "operator.crt");
    const keyPath = join(directory, "operator.key");
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    const tlsKey = await readFile(keyPath, "utf8");
    secrets.push(tlsKey);
    const tls = await createUpgradeResponseProxy({
      upstream: url,
      key: tlsKey,
      cert: await readFile(certPath, "utf8"),
    });
    t.after(() => tls.close());
    const installation = await request("/installation");
    await kubectl(
      "annotate",
      "secret/occ-installation-startup",
      "--namespace",
      namespace,
      `openclaw.dev/installation-id=${String(installation.id)}`,
    );
    const liveSecret = asRecord(await resource("secret", "occ-installation-startup", namespace))!;
    const installationFile = join(directory, "installation.json");
    await writeFile(
      installationFile,
      Buffer.from(String(asRecord(liveSecret.data)!["installation.yaml"]), "base64"),
      { mode: 0o600 },
    );
    const key = join(directory, "key.json");
    await writeFile(key, JSON.stringify({ data: { key: controlPlane.serviceKey } }), {
      mode: 0o600,
    });
    const candidate = join(directory, "candidate");
    await run("scripts/upgrade-channel-egress", [
      "prepare",
      "--namespace",
      namespace,
      "--release",
      release,
      "--values",
      join(directory, "values.json"),
      "--installation",
      installationFile,
      "--out-dir",
      candidate,
    ]);
    const occ = join(directory, "occ");
    await run("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);
    const evidence = join(directory, "evidence");
    const before = JSON.parse(await kubectl("get", "gateways", "--all-namespaces", "-o", "json"));
    await run(
      "scripts/upgrade-channel-egress",
      [
        "run",
        ...["--kubeconfig", selection.kubeconfigPath, "--context", selection.kubernetesContext],
        "--namespace",
        namespace,
        "--release",
        release,
        "--values",
        join(directory, "values.json"),
        "--installation",
        installationFile,
        "--candidate-values",
        join(candidate, "values.yaml"),
        "--candidate-installation",
        join(candidate, "installation.yaml"),
        "--controller-image",
        controller,
        "--source-revision",
        (await run("git", ["rev-parse", "HEAD"])).trim(),
        "--evidence-dir",
        evidence,
        "--occ",
        occ,
      ],
      {
        env: {
          ...process.env,
          OCC_URL: tls.url,
          OCC_CA_BUNDLE: certPath,
          OCC_SERVICE_KEY_FILE: key,
          KUBERC: "off",
        },
        timeout: 600_000,
      },
    );
    assert.equal((await request("/installation")).id, installation.id);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "values.json"), "utf8")).channelEgress,
      { enabled: false },
    );
    await assert.rejects(readFile(join(evidence, "channel-agent-operations.json")), {
      code: "ENOENT",
    });
    const after = JSON.parse(await kubectl("get", "gateways", "--all-namespaces", "-o", "json"));
    const identities = (list: { items: { metadata: { uid: string } }[] }) =>
      list.items.map((item) => item.metadata.uid).sort();
    assert.deepEqual(identities(after), identities(before));
    await readFile(join(evidence, "completed"));
  },
);
