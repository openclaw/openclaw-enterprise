import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as requestHTTPS } from "node:https";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  explicitK3dSelection,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { prepareProductionHelmControlPlane } from "../helpers/production-helm-real.ts";
import type { FixtureRun } from "../helpers/production-rehearsal-custody.ts";
import { runFixtureCommand } from "../helpers/production-rehearsal-custody.ts";
import { findChartJob } from "../helpers/production-chart-resource.ts";
import { parseProductionChart, renderProductionChart } from "../helpers/production-chart.ts";

function heldResponse() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

const selected = process.env.OCC_TEST_PRODUCTION_OBSERVABILITY === "1";
test(
  "production installation receipts survive interruption before and after Job capture",
  {
    skip: selected
      ? false
      : "requires the prepared k3d-observability controller and PostgreSQL images",
    timeout: 900_000,
  },
  async (t) => {
    const selectionInput = explicitK3dSelection();
    await validateExplicitK3dLoopbackContext(selectionInput);
    const { kubeconfigPath, kubernetesContext } = selectionInput;
    assert.ok(kubeconfigPath && kubernetesContext);
    const selection = { kubeconfigPath, kubernetesContext };
    function importedImage(name: string) {
      const image = process.env[name];
      assert.match(image ?? "", /^\S+@sha256:[a-f0-9]{64}$/, `${name} requires an immutable image`);
      assert.ok(image);
      return image;
    }
    const images = {
      controller: importedImage("OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"),
      postgres: importedImage("OCC_TEST_PRODUCTION_POSTGRES_IMAGE"),
      runtime: importedImage("OCC_TEST_KUBERNETES_IMAGE"),
    };
    const kubernetes = createKubernetesClient({ selection });
    const { kubectl, resource, waitFor } = kubernetes;
    const directory = await mkdtemp(join(tmpdir(), "occ-receipt-production-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const occ = join(directory, "occ");
    execFileSync("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);

    // This proxy forwards real Kubernetes requests with the selected fixture
    // credentials. Holding a Secret create or the observer's successful GET
    // models a lost connection after persistence, without inventing cluster state.
    const source = JSON.parse(
      String(await kubectl("config", "view", "--minify", "--flatten", "--raw", "-o", "json")),
    );
    const cluster = source.clusters[0].cluster;
    const identity = source.users[0].user;
    const endpoint = new URL(cluster.server);
    const proxyKey = join(directory, "proxy-key.pem");
    const proxyCert = join(directory, "proxy-cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        proxyKey,
        "-out",
        proxyCert,
      ],
      { stdio: "ignore" },
    );
    const proxyCA = await readFile(proxyCert);
    const installerToken = randomBytes(32).toString("hex");
    let heldPath = "";
    let heldStatus = 200;
    let writes = 0;
    let held = heldResponse();
    const proxy = createServer(
      { key: await readFile(proxyKey), cert: proxyCA },
      (request, response) => {
        if (!request.headers.authorization?.startsWith("Bearer ")) {
          response.writeHead(401);
          response.end();
          return;
        }
        const isInstaller = request.headers.authorization === `Bearer ${installerToken}`;
        const headers = { ...request.headers, host: endpoint.host };
        if (isInstaller) {
          delete headers.authorization;
        }
        if (!["GET", "HEAD"].includes(request.method ?? "")) {
          writes++;
        }
        const upstream = requestHTTPS(
          {
            hostname: endpoint.hostname,
            port: endpoint.port,
            path: request.url,
            method: request.method,
            headers,
            ca: Buffer.from(cluster["certificate-authority-data"], "base64"),
            cert: isInstaller
              ? Buffer.from(identity["client-certificate-data"], "base64")
              : undefined,
            key: isInstaller ? Buffer.from(identity["client-key-data"], "base64") : undefined,
          },
          (result) => {
            const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
            if (
              heldPath === path &&
              result.statusCode === heldStatus &&
              request.headers["user-agent"]?.startsWith("kubectl/")
            ) {
              result.resume();
              held.resolve();
              return;
            }
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
          },
        );
        upstream.on("error", () => {
          response.writeHead(502);
          response.end();
        });
        // A killed Helm client must also release its live upstream watches.
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
      },
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    const proxyServer = `https://127.0.0.1:${address.port}`;
    async function config(path: string, token: string) {
      await writeFile(
        path,
        JSON.stringify({
          apiVersion: "v1",
          kind: "Config",
          clusters: [
            {
              name: "fixture",
              cluster: {
                server: proxyServer,
                "certificate-authority-data": proxyCA.toString("base64"),
              },
            },
          ],
          contexts: [{ name: "fixture", context: { cluster: "fixture", user: "reader" } }],
          users: [{ name: "reader", user: { token } }],
        }),
        { mode: 0o600 },
      );
    }
    const installerConfig = join(directory, "installer.json");
    await config(installerConfig, installerToken);

    for (const capture of ["secret", "before", "after"] as const) {
      const suffix = randomBytes(5).toString("hex");
      const namespace = `receipt-${capture}-${suffix}`;
      const release = "oce";
      const jobName = "oce-initialization";
      await kubectl("create", "namespace", namespace);
      t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
      const working = await mkdtemp(join(directory, `${capture}-`));
      const secrets: string[] = [installerToken];
      const secret = () => {
        const value = randomBytes(32).toString("hex");
        secrets.push(value);
        return value;
      };
      const redact = (value: unknown) =>
        secrets.reduce((text, value) => text.split(value).join("[redacted]"), String(value));
      const run: FixtureRun = async (command, args, options) => {
        try {
          return await runFixtureCommand(command, args, options);
        } catch (error) {
          // eslint-disable-next-line preserve-caught-error -- raw fixture errors may contain generated credentials
          throw new Error(redact(error));
        }
      };
      const prepared = await prepareProductionHelmControlPlane({
        selection,
        images,
        repositoryCredentials: undefined,
        gatewayRouting: undefined,
        controlPlane: undefined,
        executionCluster: undefined,
        metrics: undefined,
        namespace,
        release,
        directory: working,
        suffix,
        configuration: createKubernetesInstallationConfiguration({
          authentication: { mode: "inCluster" },
          codexSeccompProfile: undefined,
          platformNamespace: namespace,
          gatewayImage: images.runtime,
          codexImage: images.runtime,
          cluster: namespace,
        }),
        authBaseURL: "https://occ.example.invalid",
        agentNativeAdminDomain: "agents.example.invalid",
        installationName: `Receipt ${capture}`,
        bootstrapCredentials: capture === "secret" ? "generate" : "existing",
        apiClients: [{ namespace, podLabels: { app: "operator" } }],
        run,
        kubernetes,
        createSecretValue: secret,
        record: async () => {},
      });
      const receipt = join(working, "receipt");
      const target = [
        "--kubeconfig",
        installerConfig,
        "--context",
        "fixture",
        "--kube-namespace",
        namespace,
        "--release",
        release,
      ];
      held = heldResponse();
      const boundary = {
        secret: { status: 201, path: `/api/v1/namespaces/${namespace}/secrets` },
        before: { status: 200, path: `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}` },
        after: { status: 200, path: "" },
      }[capture];
      heldStatus = boundary.status;
      heldPath = boundary.path;
      const child = spawn(
        occ,
        [
          "installation",
          "install",
          "--bootstrap-credentials",
          capture === "secret" ? "generate" : "existing",
          ...target,
          "--chart",
          "deploy/helm/openclaw-enterprise",
          "--values",
          prepared.valuesPath,
          "--receipt",
          receipt,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, TMPDIR: working, XDG_STATE_HOME: join(working, "state") },
        },
      );
      assert.ok(child.pid);
      // Disarm cleanup after termination or exit: process group IDs can be reused.
      let active = true;
      const terminate = () => {
        if (!active) {
          return;
        }
        active = false;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      };
      t.after(terminate);
      const exited = new Promise((resolve) =>
        child.once("exit", (code) => {
          active = false;
          resolve(code);
        }),
      );
      if (capture === "secret" || capture === "before") {
        await Promise.race([
          held.promise,
          new Promise((_, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("installer did not reach the selected response boundary")),
              60_000,
            );
            timeout.unref();
          }),
        ]);
      } else {
        await waitFor("durable original Job UID", async () => {
          try {
            await readFile(join(receipt, "job.json"));
            return true;
          } catch {
            return false;
          }
        });
      }
      terminate();
      await exited;
      heldPath = "";
      if (capture === "secret") {
        // The API committed the Secret before the installer lost its response.
        // Preserve the same local inputs; neither handoff nor a retry may replace it.
        const bootstrap = asRecord(
          JSON.parse(await readFile(join(receipt, "bootstrap-secret.json"), "utf8")),
        );
        const inputs = bootstrap?.inputDirectory;
        assert.ok(typeof inputs === "string" && inputs.startsWith(join(working, "state") + "/"));
        assert.equal((await stat(inputs)).mode & 0o777, 0o700);
        const created = asRecord(await resource("secret", "occ-bootstrap-credentials", namespace));
        const data = asRecord(created?.data);
        for (const [file, key] of [
          ["initial-admin-password", "admin-password"],
          ["initial-admin-service-key", "admin-service-key"],
        ] as const) {
          const path = join(inputs, file);
          const value = await readFile(path, "utf8");
          secrets.push(value);
          assert.equal((await stat(path)).mode & 0o777, 0o600);
          assert.equal(
            data?.[key] === Buffer.from(value).toString("base64"),
            true,
            "Secret differs from retained input",
          );
        }
        await assert.rejects(readFile(join(receipt, "bootstrap-secret-result.json")), {
          code: "ENOENT",
        });
        await assert.rejects(readFile(join(receipt, "dispatch.json")), { code: "ENOENT" });
        assert.equal(
          String(
            await kubectl(
              "-n",
              namespace,
              "get",
              "job",
              jobName,
              "--ignore-not-found",
              "-o",
              "name",
            ),
          ).trim(),
          "",
        );
        const mutationCount = writes;
        await assert.rejects(
          run(occ, ["installation", "doctor", ...target, "--receipt", receipt]),
          { message: /Bootstrap Secret: preparation or creation unconfirmed/ },
        );
        assert.equal(writes, mutationCount, "handoff must not mutate the cluster");
        continue;
      }
      const original = asRecord(asRecord(await resource("job", jobName, namespace))?.metadata);
      assert.ok(typeof original?.uid === "string" && original.uid, "expected the Job UID");
      if (capture === "before") {
        await assert.rejects(readFile(join(receipt, "job.json")), { code: "ENOENT" });
      } else {
        assert.equal(
          JSON.parse(await readFile(join(receipt, "job.json"), "utf8")).uid,
          original.uid,
        );
      }
      await assert.rejects(readFile(join(receipt, "helm-result.json")), { code: "ENOENT" });

      // The original Job continues independently of its disconnected operator:
      // real migration and bootstrap finish using their distinct database roles.
      await kubectl(
        "-n",
        namespace,
        "wait",
        "--for=condition=Complete",
        `job/${jobName}`,
        "--timeout=300s",
      );
      const databaseState = () =>
        kubectl(
          "-n",
          namespace,
          "exec",
          "postgres",
          "--",
          "psql",
          "-U",
          "postgres",
          "-d",
          "openclaw_enterprise",
          "-Atc",
          "SELECT id FROM occ.installation",
        );
      const before = await databaseState();
      assert.match(String(before).trim(), /^ins_/);
      await kubectl("-n", namespace, "create", "serviceaccount", "receipt-reader");
      await kubectl(
        "-n",
        namespace,
        "create",
        "role",
        "receipt-reader",
        "--verb=get",
        "--resource=jobs.batch",
        `--resource-name=${jobName}`,
      );
      const token = String(
        await kubectl("-n", namespace, "create", "token", "receipt-reader", "--duration=10m"),
      ).trim();
      secrets.push(token);
      const readerConfig = join(working, "reader.json");
      await config(readerConfig, token);
      const readTarget = [...target];
      readTarget[1] = readerConfig;
      // Prove this process uses the reader identity, not the proxy's installer:
      // authenticated discovery works, but the named Job is forbidden until bound.
      await assert.rejects(
        run(occ, ["installation", "doctor", ...readTarget, "--receipt", receipt]),
        { message: /kubectl reported a refusal/ },
      );
      await kubectl(
        "-n",
        namespace,
        "create",
        "rolebinding",
        "receipt-reader",
        "--role=receipt-reader",
        `--serviceaccount=${namespace}:receipt-reader`,
      );
      const records = await readdir(receipt);
      const mutationCount = writes;
      if (capture === "before") {
        await assert.rejects(
          run(occ, ["installation", "doctor", ...readTarget, "--receipt", receipt]),
          (error: Error) => {
            assert.match(error.message, /original UID was not recorded/);
            assert.doesNotMatch(error.message, /matches the recorded UID/);
            return true;
          },
        );
      } else {
        const outcome = await run(occ, [
          "installation",
          "doctor",
          ...readTarget,
          "--receipt",
          receipt,
        ]);
        assert.match(outcome, /install hook\): complete/);
        assert.match(outcome, /matches the recorded UID/);
      }
      assert.equal(writes, mutationCount, "reconciliation must issue no Kubernetes mutation");
      assert.deepEqual(await readdir(receipt), records);
      assert.equal(await databaseState(), before, "reconciliation must not repeat bootstrap");

      // Copying the marker to an inert same-name replacement does not give it
      // the original UID. Neither an unrecorded UID nor a captured one may be
      // settled by that replacement.
      const render = await renderProductionChart(
        {},
        { namespace, release, isUpgrade: false, valuesFiles: [prepared.valuesPath] },
      );
      const replacement = findChartJob(await parseProductionChart(render.stdout));
      const annotations = asRecord(replacement.metadata.annotations);
      assert.ok(annotations, "Expected initialization Job annotations");
      annotations["openclaw.dev/installation-attempt"] = asRecord(original.annotations)?.[
        "openclaw.dev/installation-attempt"
      ];
      replacement.metadata.namespace = namespace;
      replacement.spec.suspend = true;
      await kubectl("-n", namespace, "delete", "job", jobName);
      await run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
        input: JSON.stringify(replacement),
      });
      await assert.rejects(
        run(occ, ["installation", "doctor", ...readTarget, "--receipt", receipt]),
        {
          message:
            capture === "before" ? /original UID was not recorded/ : /This is a different Job/,
        },
      );
      assert.equal(await databaseState(), before);
    }
  },
);
