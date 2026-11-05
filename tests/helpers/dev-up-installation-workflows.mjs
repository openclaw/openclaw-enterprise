import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { devUpUnrelatedImage, prepareDevUpImage } from "../../scripts/ci/prepare.mjs";
import { availablePort } from "../helpers/available-port.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const selected = process.env.OCC_TEST_DEV_UP_K3D_REAL === "1";

// Both the lane and direct opt-in execution need this image on a cold engine.
// Keep the 15-minute pull retry bound, three 30-second inspections and process
// termination margin outside the rejection case's 60-second assertion budget.
before(
  async () => {
    if (selected) {
      await prepareDevUpImage();
    }
  },
  { timeout: 1_080_000 },
);

// This first dev-up builds and imports both cold images. Two hosted runners reached
// the previous 1,400 s launcher limit before the 90 s NetworkPolicy probe started.
const refusalDevUpTimeoutMs = 30 * 60_000;

export function registerInstallationRefusals() {
  test(
    "dev-up refuses mismatched image selections before creating a cluster",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
      timeout: 60_000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "oce-dev-image-preflight-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const stateDirectory = join(root, "state");
      const environment = {
        ...process.env,
        OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
        OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
        OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
        OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
        OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      };
      delete environment.OCC_DEVELOPMENT_CONTROLLER_IMAGE;
      delete environment.OCC_KUBERNETES_RUNTIME_IMAGE;

      // Fail before state or cluster creation if an operator mixes one selected
      // image with a separately built checkout or uses mutable image tags.
      const reject = async (overrides, expected) => {
        await assert.rejects(
          execute(join(repository, "scripts", "dev-up"), [], {
            cwd: repository,
            env: { ...environment, ...overrides },
            timeout: 30_000,
          }),
          (error) => {
            assert.match(error.stderr, expected);
            return true;
          },
        );
        assert.equal(existsSync(stateDirectory), false);
      };
      await reject(
        { OCC_KUBERNETES_RUNTIME_IMAGE: "example/runtime:latest" },
        /must be selected together/,
      );
      await reject(
        {
          OCC_DEVELOPMENT_CONTROLLER_IMAGE: "example/controller:latest",
          OCC_KUBERNETES_RUNTIME_IMAGE: "example/runtime:latest",
        },
        /must use immutable sha256 digest references/,
      );

      // Preparation verified this exact image exists; its real engine metadata
      // cannot claim to be the OCE checkout's release.
      const unrelated = devUpUnrelatedImage;
      await reject(
        { OCC_DEVELOPMENT_CONTROLLER_IMAGE: unrelated, OCC_KUBERNETES_RUNTIME_IMAGE: unrelated },
        /selected image revision does not match checkout/,
      );
    },
  );

  test(
    "dev-up refuses gateway trust when Kubernetes does not enforce NetworkPolicy",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
      timeout: refusalDevUpTimeoutMs + 100_000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "oce-dev-policy-failure-"));
      const stateDirectory = join(root, "state");
      const cluster = `occ-dev-policy-${randomUUID().slice(0, 8)}`;
      const ports = new Set();
      while (ports.size < 3) {
        ports.add(await availablePort());
      }
      const [apiPort, kubernetesPort, browserPort] = ports;
      const realK3d = (await execute("which", ["k3d"])).stdout.trim();
      assert.ok(realK3d.startsWith("/"), "k3d must resolve to an executable path");

      // Run the genuine k3d binary while disabling only its embedded policy
      // controller. This simulates a real non-enforcing CNI, not mock traffic.
      await writeFile(
        join(root, "k3d"),
        `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "cluster" && args[1] === "create") {
  if (args[2] !== ${JSON.stringify(cluster)}) process.exit(1);
  args.push("--k3s-arg", "--disable-network-policy@server:0");
}
const result = spawnSync(${JSON.stringify(realK3d)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
      const environment = {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        OPENCLAW_DEV_PORT: String(apiPort),
        OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
        OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
        OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
        OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
        OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
        OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
        OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
        OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
          process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
        OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "90",
      };
      for (const key of [
        "OCC_DEVELOPMENT_SANDBOX_DRIVER",
        "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY",
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_FILE",
        "CODEX_API_KEY",
        "CODEX_API_KEY_FILE",
      ]) {
        delete environment[key];
      }
      t.after(async () => {
        if (existsSync(stateDirectory)) {
          await execute(join(repository, "scripts", "dev-down"), [], {
            cwd: repository,
            env: environment,
            timeout: 300_000,
          });
        }
        await rm(root, { recursive: true, force: true });
      });

      // The launcher must reject a functioning cluster with ineffective policy
      // before configuring proxy trust or bootstrapping any Agent credentials.
      const launchStarted = performance.now();
      await assert.rejects(
        execute(join(repository, "scripts", "dev-up"), [], {
          cwd: repository,
          env: environment,
          timeout: refusalDevUpTimeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        }),
        (error) => {
          // A cold build can fail before the policy probe. Preserve its category
          // without including launcher output, which can contain private state.
          const output = [error.stdout, error.stderr]
            .filter((value) => typeof value === "string")
            .map((value) => value.slice(-65_536))
            .join("\n");
          const buildError =
            [
              ["space", /no space left on device|\bENOSPC\b/i],
              ["oom", /out of memory|cannot allocate memory|\boom[- ]kill(?:ed|er)?\b/i],
              ["download", /failed to (?:download|fetch)|download failed/i],
              ["compile", /\berror TS\d{4}\b|compilation failed|failed to compile/i],
            ].find(([, pattern]) => pattern.test(output))?.[0] ?? "unknown";
          const exit = Number.isSafeInteger(error.code) ? error.code : "unknown";
          let signal = "unknown";
          if (error.signal == null) {
            signal = "none";
          } else if (
            ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT", "SIGHUP"].includes(error.signal)
          ) {
            signal = error.signal;
          }
          const elapsedSeconds = Math.round((performance.now() - launchStarted) / 1_000);
          const stages = [
            ["cluster creation", "Creating Kubernetes-only k3d cluster"],
            ["image import", "Importing the controller and PostgreSQL images"],
            ["network isolation check", "Verifying Kubernetes network isolation"],
          ];
          const stage =
            stages.findLast(([, marker]) => error.stdout?.includes(marker))?.[0] ?? "unknown";
          const diagnostic = `dev-up exit ${exit}, signal ${signal}, build-error ${buildError}, stage ${stage}, elapsed ${elapsedSeconds}s.`;
          assert.ok(
            /Verifying Kubernetes network isolation before configuring gateway trust/.test(
              error.stdout,
            ),
            `Launcher did not reach the network isolation guard; ${diagnostic}`,
          );
          assert.ok(
            /Kubernetes NetworkPolicy enforcement could not be verified/.test(error.stderr),
            `Launcher did not report failed NetworkPolicy enforcement; ${diagnostic}`,
          );
          assert.ok(
            !/Installing OCE in Namespace/.test(error.stdout),
            `Launcher installed OCE despite failed NetworkPolicy enforcement; ${diagnostic}`,
          );
          return true;
        },
      );
      assert.equal(existsSync(stateDirectory), false, "failed startup must remove owned state");
      const clusters = JSON.parse(
        (
          await execute(realK3d, ["cluster", "list", "-o", "json"], {
            cwd: repository,
            env: environment,
          })
        ).stdout,
      );
      assert.equal(
        clusters.some(({ name }) => name === cluster),
        false,
      );
    },
  );
}

export function registerInstallationKeycloak() {
  test(
    "dev-up Keycloak profile signs in the administrator, preserves the realm and cleans up",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
      timeout: 1_800_000,
    },
    async (t) => {
      const {
        keycloakInstructions,
        keycloakLauncher,
        launchTrustingBrowser,
        publishedJSON,
        verifyKeycloakAPIEgress,
      } = await import("../helpers/dev-up-keycloak.mjs");
      const { chromium } = await import("playwright");
      const fixture = await keycloakLauncher(t);
      const up = await fixture.dev("up");
      const instructions = keycloakInstructions(up.stdout);
      const origin = `https://${fixture.consoleHost}:${fixture.browserPort}`;
      assert.equal(instructions.consoleUrl, `${origin}/console/`);
      assert.deepEqual(instructions.caFiles, [
        join(fixture.stateDirectory, "browser-ca.crt"),
        join(fixture.stateDirectory, "gateway-ca.crt"),
      ]);
      assert.deepEqual(instructions.hosts, [{ address: "127.0.0.1", host: fixture.keycloakHost }]);
      const state = JSON.parse(await fixture.read("state.json"));
      assert.equal(state.signIn, "keycloak");
      const values = JSON.parse(await fixture.read("helm-values.json"));
      assert.equal(values.auth.oidc.enabled, true);
      assert.equal(values.auth.passwordSignIn, "recovery-only");
      assert.equal(values.agentNativeAdmin.enabled, false);
      // Probe the actual API after the OIDC upgrade, when the additive policy is active.
      await verifyKeycloakAPIEgress(fixture, state, values);
      const issuer = `https://${fixture.keycloakHost}/realms/oce`;
      const discovery = await publishedJSON(
        {
          hostname: fixture.keycloakHost,
          port: 443,
          ca: await fixture.read("gateway-ca.crt"),
        },
        "/realms/oce/.well-known/openid-configuration",
      );
      assert.equal(discovery.issuer, issuer);
      assert.equal(discovery.token_endpoint, `${issuer}/protocol/openid-connect/token`);
      const providers = await publishedJSON(
        {
          hostname: fixture.consoleHost,
          port: fixture.browserPort,
          ca: await fixture.read("browser-ca.crt"),
        },
        "/api/auth/providers",
      );
      assert.equal(providers.data.oidc, true);
      assert.equal(providers.data.password, false);

      // Follow the printed steps: import the two CA files into a fresh NSS
      // database and resolve only the printed hosts line. The Console host is a
      // *.localhost name, which browsers resolve to loopback themselves.
      const browser = await launchTrustingBrowser(chromium, fixture.root, instructions);
      const api = (page, path, body) =>
        page.evaluate(
          async ({ path, body }) => {
            const response = await fetch(path, {
              method: body === undefined ? "GET" : "POST",
              ...(body === undefined
                ? {}
                : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
              signal: AbortSignal.timeout(10_000),
            });
            return { status: response.status, json: await response.json() };
          },
          { path, body },
        );
      let alicePassword = (await fixture.read("keycloak-alice-password")).trim();
      try {
        const recovery = await browser.newContext();
        const page = await recovery.newPage();
        await page.goto(`${origin}/console/`);
        const signedIn = await api(page, "/api/auth/sign-in/email", {
          email: "admin@development.openclaw.invalid",
          password: (await fixture.read("initial-admin-password")).trim(),
        });
        assert.equal(signedIn.status, 200, "the recovery administrator remains usable");
        const admin = await api(page, "/api/auth/session");
        assert.equal(admin.status, 200);
        const adminId = admin.json.data.user.id;
        assert.equal(adminId, values.auth.recoveryUserId);
        // Create a real password account through the supported administrator API.
        // Its correct password must still be denied in the recovery-only profile.
        const member = { email: `member-${randomUUID()}@example.test`, password: randomUUID() };
        const created = await api(page, "/api/auth/accounts", member);
        assert.equal(created.status, 201);
        await recovery.close();
        const ordinary = await browser.newContext();
        const ordinaryPage = await ordinary.newPage();
        await ordinaryPage.goto(`${origin}/console/`);
        assert.equal((await api(ordinaryPage, "/api/auth/sign-in/email", member)).status, 401);
        await ordinary.close();

        const signInAlice = async () => {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto(`${origin}/console/`);
            const result = page.waitForResponse(
              (response) => new URL(response.url()).pathname === "/api/auth/providers/oidc/result",
            );
            result.catch(() => {});
            await page.getByRole("button", { name: "Continue with Keycloak" }).click();
            await page.waitForURL((url) => url.origin === new URL(issuer).origin);
            await page.locator("#username").fill("alice");
            await page.locator("#password").fill(alicePassword);
            await page.locator("#kc-login").click();
            assert.equal((await result).status(), 200);
            await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
            const session = await api(page, "/api/auth/session");
            assert.equal(session.status, 200);
            assert.equal(
              session.json.data.user.id,
              adminId,
              "Alice is attached to the existing administrator",
            );
            // The guarded GET requires Origin, which page fetch omits for same-origin GETs.
            // Observe the same browser session through verified HTTPS with its exact cookies.
            const cookies = await context.cookies(origin);
            const account = await publishedJSON(
              {
                hostname: fixture.consoleHost,
                port: fixture.browserPort,
                ca: await fixture.read("browser-ca.crt"),
              },
              `/api/auth/accounts/${adminId}`,
              {
                headers: {
                  origin,
                  cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
                },
              },
            );
            assert.equal(account.data.userId, adminId);
            const sessionCookie = cookies.find(
              ({ name, value }) => name.endsWith(".session_token") && value,
            );
            assert.ok(sessionCookie);
            assert.equal(sessionCookie.domain, fixture.consoleHost);
            assert.equal(sessionCookie.secure, true);
            assert.equal(sessionCookie.httpOnly, true);

            const endpoint = {
              hostname: fixture.consoleHost,
              port: fixture.browserPort,
              ca: await fixture.read("browser-ca.crt"),
            };
            const headers = {
              origin,
              cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
            };
            // Prove the Keycloak session can commit an administrator mutation,
            // then read the persisted account through the guarded API.
            const created = await api(page, "/api/auth/accounts", {
              email: `keycloak-member-${randomUUID()}@example.test`,
              password: randomUUID(),
            });
            assert.equal(created.status, 201);
            const path = `/api/auth/accounts/${created.json.data.id}`;
            const before = await publishedJSON(endpoint, path, { headers });
            assert.equal(before.data.disabled, false);
            const disabled = await api(page, `${path}/disable`, {
              expectedVersion: before.data.version,
            });
            assert.equal(disabled.status, 200);
            const persisted = await publishedJSON(endpoint, path, { headers });
            assert.equal(persisted.data.disabled, true);
            assert.ok(persisted.data.version > before.data.version);

            // Revoke this administrator's OCE sessions, then replay the captured
            // cookie with a current target version so only session admission fails.
            const revoked = await api(page, `/api/auth/accounts/${adminId}/revoke`, {
              expectedVersion: account.data.version,
            });
            assert.equal(revoked.status, 200);
            const refused = await publishedJSON(endpoint, `${path}/enable`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ expectedVersion: persisted.data.version }),
              expectedStatus: 401,
            });
            assert.equal(refused.error.code, "UNAUTHENTICATED");

            // A fresh recovery session observes the durable state independently
            // of the revoked cookie and the failed mutation response.
            const recovery = await browser.newContext();
            try {
              const recoveryPage = await recovery.newPage();
              await recoveryPage.goto(`${origin}/console/`);
              const signedIn = await api(recoveryPage, "/api/auth/sign-in/email", {
                email: "admin@development.openclaw.invalid",
                password: (await fixture.read("initial-admin-password")).trim(),
              });
              assert.equal(signedIn.status, 200);
              const recoveryCookies = await recovery.cookies(origin);
              const unchanged = await publishedJSON(endpoint, path, {
                headers: {
                  origin,
                  cookie: recoveryCookies.map(({ name, value }) => `${name}=${value}`).join("; "),
                },
              });
              assert.deepEqual(unchanged.data, persisted.data);
            } finally {
              await recovery.close();
            }
          } finally {
            await context.close();
          }
        };
        await signInAlice();
        // A password changed after realm import must survive the Pod restart.
        // Reimporting the fixture into an empty database cannot satisfy this proof.
        const keycloak = {
          hostname: fixture.keycloakHost,
          port: 443,
          ca: await fixture.read("gateway-ca.crt"),
        };
        const token = await publishedJSON(
          keycloak,
          "/realms/master/protocol/openid-connect/token",
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "password",
              client_id: "admin-cli",
              username: "admin",
              password: (await fixture.read("keycloak-admin-password")).trim(),
            }).toString(),
          },
        );
        assert.equal(typeof token.access_token, "string");
        const authorization = `Bearer ${token.access_token}`;
        const users = await publishedJSON(
          keycloak,
          "/admin/realms/oce/users?username=alice&exact=true",
          {
            headers: { authorization },
          },
        );
        assert.equal(users.length, 1);
        const [alice] = users;
        assert.equal(alice.username, "alice");
        assert.match(alice.id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu);
        alicePassword = randomUUID();
        await publishedJSON(keycloak, `/admin/realms/oce/users/${alice.id}/reset-password`, {
          method: "PUT",
          expectedStatus: 204,
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ type: "password", value: alicePassword, temporary: false }),
        });
        const before = JSON.parse(
          (
            await fixture.kubectl([
              "-n",
              "occ-development-keycloak",
              "get",
              "pods",
              "-l",
              "app=keycloak",
              "-o",
              "json",
            ])
          ).stdout,
        );
        assert.equal(before.items.length, 1);
        await fixture.kubectl([
          "-n",
          "occ-development-keycloak",
          "rollout",
          "restart",
          "deployment/keycloak",
        ]);
        await fixture.kubectl([
          "-n",
          "occ-development-keycloak",
          "rollout",
          "status",
          "deployment/keycloak",
          "--timeout=180s",
        ]);
        const after = JSON.parse(
          (
            await fixture.kubectl([
              "-n",
              "occ-development-keycloak",
              "get",
              "pods",
              "-l",
              "app=keycloak",
              "-o",
              "json",
            ])
          ).stdout,
        );
        assert.ok(after.items.some((pod) => pod.metadata.uid !== before.items[0].metadata.uid));
        // A fresh browser session must authenticate with the same persisted realm credentials.
        await signInAlice();
      } finally {
        await browser.close();
      }
      await fixture.dev("down");
      assert.equal(existsSync(fixture.stateDirectory), false);
      await fixture.assertCluster(false);
    },
  );

  // The end of a command's output for a failure message. The results artifact keeps a whole
  // message only up to 16 KiB, so each stream is bounded to leave room for both.
  const outputTailLines = 40;
  const outputTailChars = 6_000;
  function outputTail(output) {
    return String(output ?? "")
      .trimEnd()
      .split("\n")
      .slice(-outputTailLines)
      .join("\n")
      .slice(-outputTailChars);
  }

  test(
    "dev-up Keycloak second-pass failure retains recovery state until owned cleanup succeeds",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
      timeout: 1_800_000,
    },
    async (t) => {
      const { keycloakLauncher } = await import("../helpers/dev-up-keycloak.mjs");
      const fixture = await keycloakLauncher(t);
      const realHelm = (await fixture.run("which", ["helm"])).stdout.trim();
      const realK3d = (await fixture.run("which", ["k3d"])).stdout.trim();
      assert.ok(realHelm.startsWith("/") && realK3d.startsWith("/"));
      const helmMarker = join(fixture.root, "second-pass-failed");
      const deleteMarker = join(fixture.root, "delete-failed");
      // External command faults surround the real launcher. First-pass Helm,
      // Keycloak provisioning and all NetworkPolicies run normally. Refuse only
      // this cluster's second upgrade and first deletion, then use genuine down.
      for (const [name, real, fault] of [
        [
          "helm",
          realHelm,
          `const index = args.indexOf("-f");
if (args[0] === "upgrade" && index >= 0 && args[index + 1] === ${JSON.stringify(join(fixture.stateDirectory, "helm-values.json"))} && JSON.parse(readFileSync(args[index + 1], "utf8")).auth.oidc?.enabled) {
  writeFileSync(${JSON.stringify(helmMarker)}, "second pass reached");
  console.error("injected second Helm pass failure"); process.exit(1);
}`,
        ],
        [
          "k3d",
          realK3d,
          `if (args[0] === "cluster" && args[1] === "delete" && args[2] === ${JSON.stringify(fixture.cluster)} && !existsSync(${JSON.stringify(deleteMarker)})) {
  writeFileSync(${JSON.stringify(deleteMarker)}, "owned deletion refused");
  console.error("injected owned cluster deletion failure"); process.exit(1);
}`,
        ],
      ]) {
        await writeFile(
          join(fixture.root, name),
          `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
${fault}
const result = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
          { mode: 0o700 },
        );
      }
      await assert.rejects(
        fixture.dev("up", {
          ...fixture.environment,
          PATH: `${fixture.root}${delimiter}${fixture.environment.PATH}`,
        }),
        (error) => {
          // Finding 1884: dev up once failed before the second pass, and the assertion cut its
          // stdout and never showed stderr. A mismatch now names the step dev up stopped at.
          try {
            assert.match(error.stdout, /Enabling Keycloak sign-in \(second Helm pass\)/);
            assert.match(error.stderr, /injected second Helm pass failure/);
            assert.match(error.stderr, /injected owned cluster deletion failure/);
          } catch (mismatch) {
            // Node's own message quotes the start of stdout; keep only its first line.
            throw new Error(
              `${mismatch.message.split("\n")[0].replace(/ Input:$/, "")} dev up exit ${error.code} signal ${error.signal}.` +
                `\n--- dev up stdout, last ${outputTailLines} lines ---\n${outputTail(error.stdout)}` +
                `\n--- dev up stderr, last ${outputTailLines} lines ---\n${outputTail(error.stderr)}`,
              { cause: mismatch },
            );
          }
          return true;
        },
      );
      assert.equal(existsSync(helmMarker), true);
      assert.equal(existsSync(deleteMarker), true);
      assert.equal(JSON.parse(await fixture.read("state.json")).cluster, fixture.cluster);
      for (const name of ["kubeconfig", "initial-admin-password", "keycloak-alice-password"]) {
        assert.equal((await stat(join(fixture.stateDirectory, name))).mode & 0o077, 0);
      }
      await fixture.assertCluster(true);
      const namespace = await fixture.kubectl([
        "get",
        "namespace",
        "occ-development-keycloak",
        "--ignore-not-found",
        "-o",
        "name",
      ]);
      assert.equal(
        namespace.stdout.trim(),
        "",
        "rollback removes the realm before cluster deletion",
      );
      await fixture.dev("down");
      assert.equal(existsSync(fixture.stateDirectory), false);
      await fixture.assertCluster(false);
    },
  );
}
