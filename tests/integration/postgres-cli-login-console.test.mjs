import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const email = "cli-console-admin@example.test";
const password = "cli-console-local-password";
const authSecret = "cli-console-auth-test-secret-at-least-32-bytes";

// The ordinary Console in Chromium against the PostgreSQL development composition. occ's
// side of the flow (start and poll) is plain HTTP from this process.
test(
  "the Console approves, denies and refuses occ login codes and revokes CLI sessions",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const apps = [];
    let browser;
    t.after(async () => {
      await browser?.close();
      for (const app of apps.reverse()) {
        await app.close();
      }
      await pool.end();
    });
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret,
      authBaseURL: "http://127.0.0.1",
      installationName: "CLI sign-in browser proof",
    });
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = await composePostgresDevelopment(
      { mode: "development", host: "127.0.0.1", databaseUrl, authSecret, authBaseURL: origin },
      {
        computeDriver: createDevelopmentComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
      },
    );
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });

    async function start(remoteAddress) {
      const payload = { clientLabel: "occ on browser-proof" };
      const response =
        remoteAddress === undefined
          ? await fetch(`${origin}/api/auth/cli/device-authorizations`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }).then(async (result) => ({ status: result.status, body: await result.json() }))
          : await app
              .inject({
                method: "POST",
                url: "/api/auth/cli/device-authorizations",
                remoteAddress,
                payload,
              })
              .then((result) => ({ status: result.statusCode, body: result.json() }));
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.data;
    }
    async function poll(deviceCode) {
      const response = await fetch(`${origin}/api/auth/cli/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      return { status: response.status, body: await response.json() };
    }

    browser = await chromium.launch({
      chromiumSandbox: true,
      headless: true,
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
    });
    const page = await browser.newPage();
    const code = page.getByLabel("Code shown by occ login");
    async function enter(userCode) {
      await page.goto(`${origin}/console/cli-login`);
      await code.fill(userCode);
      await page.getByRole("button", { name: "Continue" }).click();
    }

    await t.test(
      "signing in from the approval page returns to it; a URL code is ignored",
      async () => {
        const started = await start();
        await page.goto(
          `${origin}/console/cli-login?userCode=${started.userCode}&code=${started.userCode}`,
        );
        await page.getByLabel("Username").fill(email);
        await page.getByLabel("Password").fill(password);
        await page.getByRole("button", { name: "Login" }).click();
        await page.waitForURL(/\/console\/cli-login/);
        await code.waitFor();
        assert.equal(await code.inputValue(), "");
        assert.equal((await poll(started.deviceCode)).body.error.code, "AUTHORIZATION_PENDING");
      },
    );

    await t.test("a wrong code is refused without revealing anything", async () => {
      await enter("ZZZZ-ZZZZ");
      await page.getByText(/No pending sign-in request has this code/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0);
    });

    let approvedCode;
    await t.test(
      "approve: review the request, approve, and occ's next poll is issued",
      async () => {
        const started = await start();
        await enter(started.userCode.toLowerCase());
        await page.getByRole("heading", { name: "Approve this sign-in?" }).waitFor();
        await page
          .getByText("occ on browser-proof (reported by the client, not verified)")
          .waitFor();
        assert.equal(await page.getByText(/different network address/).count(), 0);
        await page.getByRole("button", { name: "Approve" }).click();
        await page.getByRole("heading", { name: "occ is signed in" }).waitFor();
        const issued = await poll(started.deviceCode);
        assert.equal(issued.status, 200, JSON.stringify(issued.body));
        assert.match(issued.body.data.token, /^occcli_/);
        approvedCode = started.userCode;
      },
    );

    await t.test("a used or expired code is refused", async () => {
      await enter(approvedCode);
      await page.getByText(/No pending sign-in request has this code/).waitFor();
    });

    await t.test("deny is final and occ reports it", async () => {
      const started = await start();
      await enter(started.userCode);
      await page.getByRole("button", { name: "Deny" }).click();
      await page.getByRole("heading", { name: "Sign-in denied" }).waitFor();
      assert.equal((await poll(started.deviceCode)).body.error.code, "ACCESS_DENIED");
    });

    await t.test("a request from another address carries a warning", async () => {
      const started = await start("203.0.113.24");
      await enter(started.userCode);
      await page.getByText(/different network address than this browser/).waitFor();
      await page.getByText("203.0.113.24").waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
      await code.waitFor();
    });

    await t.test("Settings lists the person's CLI sessions and revokes one", async () => {
      await page.goto(`${origin}/console/settings`);
      const sessions = page.getByRole("list", { name: "CLI sessions" });
      await sessions.getByText("occ on browser-proof").first().waitFor();
      assert.equal(await sessions.getByRole("listitem").count(), 1);
      await sessions.getByRole("button", { name: "Revoke" }).click();
      await page.getByText("No active CLI sessions.").waitFor();
      const remaining = await pool.query("SELECT count(*)::int AS count FROM occ.cli_sessions");
      assert.equal(remaining.rows[0].count, 0);
    });
  },
);
