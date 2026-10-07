import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  createAccount,
  currentSession,
  defaultInstallSettings,
  installationRoles,
  postgresSignInState,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "cli-sign-in-admin@example.test";
const memberEmail = "cli-sign-in-member@example.test";
const memberPassword = "cli-sign-in-member-password";
const authSecret = "cli-sign-in-auth-test-secret-at-least-32-bytes";
const CSRF = "The request did not satisfy the configured CSRF boundary.";

function runOcc(executable, args, environment, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(stderr);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function goBuild(output) {
  return new Promise((resolve, reject) => {
    const child = spawn("go", ["build", "-trimpath", "-o", output, "./cmd/occ"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`go build failed:\n${stderr}`)),
    );
  });
}

// The default production composition (password-only profile) on real PostgreSQL, through
// Fastify and, at the end, the real occ binary over a loopback socket.
test(
  "occ login issues a CLI session that a person approves in the console and that ends with it",
  requiresPostgres,
  async (t) => {
    const apps = [];
    const { pool, state } = postgresSignInState(t, () => apps);
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const compose = (settings = defaultInstallSettings) =>
      composeProductionSignIn(t, {
        databaseUrl,
        settings,
        secrets: { "occ-auth/secret": authSecret },
      });
    const app = await compose();
    apps.push(app);
    await app.ready();

    const inject = (method, url, headers = {}, payload, remoteAddress = "192.0.2.10") =>
      app.inject({
        method,
        url,
        remoteAddress,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    async function browser(account, remoteAddress = "192.0.2.10") {
      const headers = await signedInHeaders(app, origin, account, remoteAddress);
      const session = await currentSession(app, headers.cookie);
      assert.ok(session.sessionKey);
      return {
        ...headers,
        "x-occ-session-key": session.sessionKey,
        userId: session.user.id,
      };
    }
    const headersOf = ({ userId: _userId, ...headers }) => headers;
    async function start(payload = { clientLabel: "occ on test host" }, remoteAddress) {
      const response = await inject(
        "POST",
        "/api/auth/cli/device-authorizations",
        {},
        payload,
        remoteAddress,
      );
      assert.equal(response.statusCode, 201, response.body);
      return response.json().data;
    }
    const poll = (deviceCode) => inject("POST", "/api/auth/cli/token", {}, { deviceCode });
    const decide = (session, userCode, decision = "approve", remoteAddress) =>
      inject(
        "POST",
        "/api/auth/cli/device-authorizations/decide",
        headersOf(session),
        { userCode, decision },
        remoteAddress,
      );
    async function signInCli(session, payload) {
      const started = await start(payload);
      const approved = await decide(session, started.userCode);
      assert.equal(approved.statusCode, 200, approved.body);
      const issued = await poll(started.deviceCode);
      assert.equal(issued.statusCode, 200, issued.body);
      return issued.json().data;
    }
    const cli = (token, extra = {}) => ({ "x-occ-cli-session": token, ...extra });

    const admin = await browser({ email: adminEmail, password: adminPassword });
    const { admin: adminRole } = await installationRoles(state, pool);
    const created = await inject("POST", "/namespaces", headersOf(admin), {
      name: `cli ${randomUUID()}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    const namespace = created.json().data;
    const otherNamespace = (
      await inject("POST", "/namespaces", headersOf(admin), { name: `cli other ${randomUUID()}` })
    ).json().data;
    assert.ok(otherNamespace.id);

    await t.test(
      "the device flow: pending, slow down, approval with a browser session, one exchange",
      async () => {
        const started = await start();
        assert.match(started.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        assert.match(started.deviceCode, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(started.verificationUri, "/console/cli-login");
        assert.equal(started.interval, 5);
        assert.ok(started.expiresIn > 590 && started.expiresIn <= 600);
        const pending = await poll(started.deviceCode);
        assert.equal(pending.statusCode, 400);
        assert.equal(pending.json().error.code, "AUTHORIZATION_PENDING");
        assert.equal(pending.headers["cache-control"], "no-store");
        const fast = await poll(started.deviceCode);
        assert.equal(fast.json().error.code, "SLOW_DOWN");
        const stored = await pool.query(
          "SELECT device_code_hash, user_code_hash FROM occ.cli_device_authorizations WHERE device_code_hash=$1",
          [createHash("sha256").update(started.deviceCode).digest("hex")],
        );
        assert.equal(stored.rowCount, 1);

        // The approval page needs the exact Origin, the tab's session key and a cookie.
        const lookupBody = { userCode: started.userCode.toLowerCase().replace("-", " ") };
        for (const refused of [
          { cookie: admin.cookie, "x-occ-session-key": admin["x-occ-session-key"] },
          {
            cookie: admin.cookie,
            origin: "https://attacker.example.test",
            "x-occ-session-key": admin["x-occ-session-key"],
          },
          { cookie: admin.cookie, origin },
          { origin, "x-occ-session-key": admin["x-occ-session-key"] },
        ]) {
          const response = await inject(
            "POST",
            "/api/auth/cli/device-authorizations/lookup",
            refused,
            lookupBody,
          );
          assert.ok(
            [401, 403].includes(response.statusCode),
            `${response.statusCode} ${response.body}`,
          );
        }
        const lookup = await inject(
          "POST",
          "/api/auth/cli/device-authorizations/lookup",
          headersOf(admin),
          lookupBody,
        );
        assert.equal(lookup.statusCode, 200, lookup.body);
        assert.equal(lookup.json().data.clientLabel, "occ on test host");
        assert.equal(lookup.json().data.requesterAddress, "192.0.2.10");
        assert.equal(lookup.json().data.sameAddress, true);
        const elsewhere = await inject(
          "POST",
          "/api/auth/cli/device-authorizations/lookup",
          headersOf(admin),
          lookupBody,
          "198.51.100.7",
        );
        assert.equal(elsewhere.json().data.sameAddress, false);

        const approved = await decide(admin, started.userCode);
        assert.equal(approved.statusCode, 200, approved.body);
        await new Promise((resolve) => setTimeout(resolve, 4100));
        const [first, second] = await Promise.all([
          poll(started.deviceCode),
          poll(started.deviceCode),
        ]);
        const statuses = [first.statusCode, second.statusCode].sort();
        assert.deepEqual(statuses, [200, 400]);
        const issued = (first.statusCode === 200 ? first : second).json().data;
        assert.match(issued.token, /^occcli_[A-Za-z0-9_-]{43}$/);
        assert.equal(issued.user.email, adminEmail);
        const current = await inject("GET", "/api/auth/cli-sessions/current", cli(issued.token));
        assert.equal(current.statusCode, 200, current.body);
        assert.equal(current.json().data.id, issued.session.id);
        const audits = await pool.query(
          `SELECT action, details::text AS details FROM occ.audit_events
         WHERE action LIKE 'openclaw.auth.cli-sessions.%'`,
        );
        assert.deepEqual(audits.rows.map((row) => row.action).sort(), [
          "openclaw.auth.cli-sessions.approve",
          "openclaw.auth.cli-sessions.issue",
        ]);
        assert.ok(audits.rows.every((row) => !row.details.includes(issued.token)));
        assert.ok(audits.rows.every((row) => !row.details.includes(started.deviceCode)));
      },
    );

    await t.test("wrong codes share one budget, denial is final", async () => {
      const member = await createAccount(app, headersOf(admin), {
        email: memberEmail,
        password: memberPassword,
        roleId: adminRole.id,
      });
      assert.ok(member.id);
      const person = await browser({ email: memberEmail, password: memberPassword }, "192.0.2.30");
      const started = await start();
      const denied = await decide(person, started.userCode, "deny", "192.0.2.30");
      assert.equal(denied.statusCode, 200, denied.body);
      assert.equal((await poll(started.deviceCode)).json().error.code, "ACCESS_DENIED");
      const again = await decide(person, started.userCode, "approve", "192.0.2.30");
      assert.equal(again.statusCode, 404);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const wrong = await decide(person, "BCDF-GHJK", "approve", "192.0.2.30");
        assert.equal(wrong.statusCode, 404, wrong.body);
      }
      const exhausted = await inject(
        "POST",
        "/api/auth/cli/device-authorizations/lookup",
        headersOf(person),
        { userCode: "BCDF-GHJL" },
        "192.0.2.30",
      );
      assert.equal(exhausted.statusCode, 429, exhausted.body);
      assert.ok(Number(exhausted.headers["retry-after"]) >= 1);
      // The budget is the account's too, from another address.
      const moved = await inject(
        "POST",
        "/api/auth/cli/device-authorizations/lookup",
        headersOf(person),
        { userCode: "BCDF-GHJL" },
        "192.0.2.31",
      );
      assert.equal(moved.statusCode, 429, moved.body);
    });

    await t.test("browser-only gates refuse a CLI session", async () => {
      const { token } = await signInCli(admin);
      // Global allowlist: a CLI session reaches ordinary routes with the person's grants.
      const listed = await inject("GET", "/namespaces", cli(token));
      assert.equal(listed.statusCode, 200, listed.body);
      const ids = listed.json().data.map((item) => item.id);
      assert.ok(ids.includes(namespace.id) && ids.includes(otherNamespace.id));

      const keyCount = async () =>
        (await pool.query("SELECT count(*)::int AS count FROM occ.apikey")).rows[0].count;
      const keysBefore = await keyCount();
      const refused = [
        ["GET", `/api/auth/accounts/${admin.userId}`],
        [
          "POST",
          "/api/auth/accounts",
          { email: "cli-created@example.test", password: memberPassword, roleId: adminRole.id },
        ],
        [
          "POST",
          "/api/auth/service-keys",
          { servicePrincipalId: "cli-automation", name: "from-cli", namespaceId: namespace.id },
        ],
        ["DELETE", `/api/auth/service-keys/key_${randomUUID()}`],
        ["GET", "/api/auth/session"],
        ["GET", "/api/auth/cli-sessions"],
        ["POST", "/api/auth/cli/device-authorizations/lookup", { userCode: "BCDF-GHJK" }],
        [
          "POST",
          "/api/auth/cli/device-authorizations/decide",
          { userCode: "BCDF-GHJK", decision: "approve" },
        ],
        ["GET", `/namespaces/${namespace.id}/agents/agt_${randomUUID()}/native-admin`],
      ];
      for (const [method, url, payload] of refused) {
        // Even with the browser cookie, Origin and session key alongside: no ambient fallback.
        for (const extra of [{}, headersOf(admin)]) {
          const response = await inject(method, url, cli(token, extra), payload);
          assert.equal(
            response.statusCode,
            403,
            `${method} ${url}: ${response.statusCode} ${response.body}`,
          );
        }
      }
      const keyDenial = await pool.query(
        `SELECT count(*)::int AS count FROM occ.audit_events
         WHERE action = 'openclaw.auth.service-keys.create' AND outcome = 'denied'
           AND details->'__occAuditMetadata'->>'reasonCode' = 'CLI_SESSION_NOT_ALLOWED'`,
      );
      assert.ok(keyDenial.rows[0].count >= 1);
      assert.equal(await keyCount(), keysBefore, "no key was minted");

      // Workspace-file CSRF: a CLI session is a header credential, like a service key.
      const file = `/namespaces/${namespace.id}/agents/agt_${randomUUID()}/workspace/files/AGENTS.md`;
      const cookieWrite = await inject(
        "PUT",
        file,
        {
          cookie: admin.cookie,
          "x-occ-session-key": admin["x-occ-session-key"],
          "content-type": "application/json",
        },
        { content: "x" },
      );
      assert.equal(cookieWrite.statusCode, 403);
      const cliWrite = await inject(
        "PUT",
        file,
        cli(token, { "content-type": "application/json", "sec-fetch-site": "cross-site" }),
        { content: "x" },
      );
      assert.notEqual(cliWrite.json().error?.message, CSRF, cliWrite.body);
      assert.notEqual(cliWrite.statusCode, 401, cliWrite.body);
      const actions = await pool.query(
        `SELECT count(*)::int AS count FROM occ.audit_events WHERE details->'admission'->>'method' = 'cli_session'`,
      );
      assert.ok(actions.rows[0].count >= 1, "CLI actions are attributed in the audit");
    });

    await t.test("exactly one credential: header precedence and malformed tokens", async () => {
      const { token } = await signInCli(admin);
      const bogus = `occcli_${"A".repeat(43)}`;
      for (const headers of [
        cli(bogus, headersOf(admin)),
        cli("occcli_short", headersOf(admin)),
        cli(token, { "x-api-key": "occ_not_a_real_key" }),
        { "x-occ-cli-session": [token, token] },
      ]) {
        const response = await inject("GET", "/namespaces", headers);
        assert.equal(
          response.statusCode,
          401,
          `${JSON.stringify(Object.keys(headers))}: ${response.body}`,
        );
      }
      const both = await inject(
        "GET",
        "/api/auth/cli-sessions/current",
        cli(token, { authorization: "Bearer x" }),
      );
      assert.equal(both.statusCode, 401);
    });

    await t.test("a Namespace pin reaches only its Namespace", async () => {
      const { token, session } = await signInCli(admin, {
        clientLabel: "occ on test host",
        namespaceId: namespace.id,
      });
      assert.equal(session.namespaceId, namespace.id);
      assert.equal(
        (await inject("GET", `/namespaces/${namespace.id}`, cli(token))).statusCode,
        200,
      );
      for (const url of [`/namespaces/${otherNamespace.id}`, "/namespaces", "/installation"]) {
        const response = await inject("GET", url, cli(token));
        assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
      }
      const malformed = await inject(
        "POST",
        "/api/auth/cli/device-authorizations",
        {},
        { clientLabel: "occ on test host", namespaceId: "default" },
      );
      assert.equal(malformed.statusCode, 400);
    });

    await t.test("own sessions: list and revoke in the console, logout from the CLI", async () => {
      const person = await browser({ email: memberEmail, password: memberPassword }, "192.0.2.40");
      const mine = await signInCli(admin);
      const listed = await inject("GET", "/api/auth/cli-sessions", headersOf(admin));
      assert.equal(listed.statusCode, 200, listed.body);
      assert.ok(listed.json().data.some((item) => item.id === mine.session.id));
      assert.ok(listed.json().data.every((item) => !("token" in item)));
      const theirs = await inject(
        "GET",
        "/api/auth/cli-sessions",
        headersOf(person),
        undefined,
        "192.0.2.40",
      );
      assert.ok(theirs.json().data.every((item) => item.id !== mine.session.id));
      const foreign = await inject(
        "DELETE",
        `/api/auth/cli-sessions/${mine.session.id}`,
        headersOf(person),
        undefined,
        "192.0.2.40",
      );
      assert.equal(foreign.statusCode, 404);
      const noOrigin = await inject("DELETE", `/api/auth/cli-sessions/${mine.session.id}`, {
        cookie: admin.cookie,
        "x-occ-session-key": admin["x-occ-session-key"],
      });
      assert.equal(noOrigin.statusCode, 403);
      const revoked = await inject(
        "DELETE",
        `/api/auth/cli-sessions/${mine.session.id}`,
        headersOf(admin),
      );
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal((await inject("GET", "/namespaces", cli(mine.token))).statusCode, 401);

      const other = await signInCli(admin);
      const logout = await inject("DELETE", "/api/auth/cli-sessions/current", cli(other.token));
      assert.equal(logout.statusCode, 200, logout.body);
      assert.equal((await inject("GET", "/namespaces", cli(other.token))).statusCode, 401);
      assert.equal(
        (await inject("DELETE", "/api/auth/cli-sessions/current", cli(other.token))).statusCode,
        401,
      );
    });

    await t.test("signing the browser out ends its CLI sessions", async () => {
      const tab = await browser({ email: adminEmail, password: adminPassword }, "192.0.2.50");
      const { token } = await signInCli(tab);
      assert.equal((await inject("GET", "/namespaces", cli(token))).statusCode, 200);
      const signedOut = await inject(
        "POST",
        "/api/auth/sign-out",
        headersOf(tab),
        undefined,
        "192.0.2.50",
      );
      assert.equal(signedOut.statusCode, 200, signedOut.body);
      assert.equal((await inject("GET", "/namespaces", cli(token))).statusCode, 401);
    });

    await t.test("the real occ binary: login, approve, request, status, logout", async () => {
      const directory = await privateBootstrapDirectory(t, "occ-cli-login-");
      const executable = join(directory, "occ");
      await goBuild(executable);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const url = `http://127.0.0.1:${app.server.address().port}`;
      const environment = {
        PATH: process.env.PATH,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "config"),
        OCC_URL: url,
      };
      let approval;
      const login = await runOcc(executable, ["login", "--namespace", namespace.id], environment, {
        onStderr(text) {
          const match = /\n {4}([A-Z]{4}-[A-Z]{4})\n/.exec(text);
          if (match !== null && approval === undefined) {
            approval = decide(admin, match[1], "approve", "127.0.0.1");
          }
        },
      });
      assert.equal(login.code, 0, `${login.stdout}\n${login.stderr}`);
      assert.equal((await approval).statusCode, 200);
      assert.match(login.stdout, new RegExp(`Signed in to ${url} as ${adminEmail}`));
      assert.match(login.stdout, new RegExp(`pinned to Namespace ${namespace.id}`));

      const shown = await runOcc(
        executable,
        ["namespace", "get", namespace.id, "-o", "json"],
        environment,
      );
      assert.equal(shown.code, 0, shown.stderr);
      assert.equal(JSON.parse(shown.stdout).id, namespace.id);
      const pinned = await runOcc(executable, ["namespace", "get", otherNamespace.id], environment);
      assert.notEqual(pinned.code, 0);
      assert.match(pinned.stderr, /403|FORBIDDEN|not allowed|denied/i);
      const status = await runOcc(executable, ["auth", "status", "-o", "json"], environment);
      assert.equal(status.code, 0, status.stderr);
      const view = JSON.parse(status.stdout);
      assert.equal(view.source, "cli-session");
      assert.equal(view.state, "active");
      assert.equal(view.account, adminEmail);

      const logout = await runOcc(executable, ["logout"], environment);
      assert.equal(logout.code, 0, logout.stderr);
      assert.match(logout.stdout, /Signed out of/);
      const after = await runOcc(executable, ["namespace", "get", namespace.id], environment);
      assert.notEqual(after.code, 0);
      assert.match(after.stderr, /occ login/);
      const ended = (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.cli_sessions WHERE namespace_id=$1",
          [namespace.id],
        )
      ).rows[0].count;
      assert.equal(ended, 1, "only the earlier HTTP pin test's session remains");
    });

    await t.test("disabled: the routes answer 404 and the header 401", async () => {
      const { token } = await signInCli(admin);
      const disabled = await compose({
        ...defaultInstallSettings,
        OCC_AUTH_CLI_SESSIONS: "disabled",
      });
      apps.push(disabled);
      await disabled.ready();
      const response = await disabled.inject({
        method: "POST",
        url: "/api/auth/cli/device-authorizations",
        remoteAddress: "192.0.2.10",
        payload: { clientLabel: "occ on test host" },
      });
      assert.equal(response.statusCode, 404, response.body);
      const admitted = await disabled.inject({
        method: "GET",
        url: "/namespaces",
        remoteAddress: "192.0.2.10",
        headers: cli(token),
      });
      assert.equal(admitted.statusCode, 401, admitted.body);
    });
  },
);
