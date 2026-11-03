import assert from "node:assert/strict";
import test from "node:test";
import { readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { credentialDriverModule } from "../fixtures/repository-credentials/runtime.mjs";
import { runPinnedClients } from "../fixtures/repository-credentials/clients.mjs";
import { removeRemoteBranches } from "../fixtures/repository-credentials/workflows.mjs";
import {
  closeAndDispose,
  registerResourceCleanup,
} from "../fixtures/repository-credentials/cleanup.mjs";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";

test(
  "authorized live development-token smoke runs through the native sender with bounded cleanup",
  { timeout: 180000 },
  async (t) => {
    if (process.env.REPOSITORY_CREDENTIALS_LIVE !== "1") {
      t.skip(
        "live provider evidence unavailable: set REPOSITORY_CREDENTIALS_LIVE=1 with an authorized disposable repository and explicit development-token sender",
      );
      return;
    }
    assert.equal(
      process.env.REPOSITORY_CREDENTIALS_LIVE_AUTHORIZED,
      "1",
      "explicit disposable-repository write authorization is required",
    );
    const socket = process.env.REPOSITORY_CREDENTIALS_LIVE_CONTROL_SOCKET;
    const caFile = process.env.REPOSITORY_CREDENTIALS_LIVE_CA;
    assert.ok(
      socket && caFile,
      "live smoke requires the private control socket and public gateway CA",
    );
    const [{ callControl }, { writeClientConfiguration }] = await Promise.all([
      credentialDriverModule("client/operator"),
      credentialDriverModule("client/config"),
    ]);
    const opened = await callControl(socket, {
      method: "POST",
      path: "/v1/sessions",
      body: { durationSeconds: 300, profile: "git-full" },
    });
    assert.ok(opened.session && opened.client, "live session admission failed");
    const cleanup = [() => closeAndDispose(callControl, socket, opened.session.sessionId)];
    const workSignal = AbortSignal.any([t.signal, AbortSignal.timeout(90000)]);
    let cleanupClient;
    let clientDirectory;
    const cleanupRequest = async ({ method, path, body }, signal) => {
      const args = ["api", "--method", method, path];
      if (body) {
        args.push("--input", await cleanupClient.json("cleanup.json", body));
      }
      const response = await cleanupClient.gh(args, { signal, timeout: 5000 });
      return response.stdout ? JSON.parse(response.stdout) : undefined;
    };
    try {
      assert.deepEqual(opened.client.pushRefAllowlist, ["refs/heads/credential-smoke/*"]);
      const parent = await temporaryDirectory(t, "repository-credentials-live-");
      await chmod(parent, 0o700);
      clientDirectory = join(parent, "session");
      await writeClientConfiguration(opened, clientDirectory, await readFile(caFile));
      const client = await runPinnedClients(t, { clientDirectory }, { signal: workSignal });
      const checkout = join(client.directory, "checkout");
      const branch = `credential-smoke/${randomBytes(16).toString("hex")}`;
      const prefix = `repos/${opened.client.repository}`;
      const marker = (kind) => `<!-- ${branch}:${kind} -->`;
      const register = (kind, uniqueMarker, extra = {}) =>
        registerResourceCleanup(cleanup, {
          request: cleanupRequest,
          repository: opened.client.repository,
          kind,
          marker: uniqueMarker,
          ...extra,
        });
      await client.git(["clone", opened.client.gitRemote, checkout]);
      await client.git(["fetch", "origin"], { cwd: checkout });
      const base = (
        await client.git(["branch", "--show-current"], { cwd: checkout })
      ).stdout.trim();
      await client.git(["switch", "-c", branch], { cwd: checkout });
      await client.git(["config", "user.name", "Credential smoke"], { cwd: checkout });
      await client.git(["config", "user.email", "credential-smoke@example.test"], {
        cwd: checkout,
      });
      await client.git(["commit", "--allow-empty", "-m", "Credential gateway smoke"], {
        cwd: checkout,
      });
      // A failed response can follow an accepted push. Register cleanup first,
      // then reconcile the remote refs instead of assuming either outcome.
      cleanup.push(() => removeRemoteBranches(cleanupClient, checkout, [branch]));
      await client.git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout });
      const pullInput = await client.json("pull.json", {
        title: "Credential gateway smoke",
        body: marker("pull"),
        base,
        head: branch,
      });
      register("pulls", marker("pull"), { head: branch });
      const pull = JSON.parse(
        (await client.gh(["api", "--method", "POST", `${prefix}/pulls`, "--input", pullInput]))
          .stdout,
      );
      assert.ok(pull.number > 0);
      await client.gh(["api", `${prefix}/pulls/${pull.number}`]);
      const updateInput = await client.json("update.json", {
        title: "Credential gateway smoke checked",
      });
      await client.gh([
        "api",
        "--method",
        "PATCH",
        `${prefix}/pulls/${pull.number}`,
        "--input",
        updateInput,
      ]);
      const issueInput = await client.json("issue.json", {
        title: "Credential gateway smoke",
        body: marker("issue"),
      });
      register("issues", marker("issue"));
      const issue = JSON.parse(
        (await client.gh(["api", "--method", "POST", `${prefix}/issues`, "--input", issueInput]))
          .stdout,
      );
      const commentInput = await client.json("comment.json", {
        body: marker("comment"),
      });
      register("comment", marker("comment"), { issueNumber: issue.number });
      const comment = JSON.parse(
        (
          await client.gh([
            "api",
            "--method",
            "POST",
            `${prefix}/issues/${issue.number}/comments`,
            "--input",
            commentInput,
          ])
        ).stdout,
      );
      assert.ok(comment.id > 0);
      await client.gh(["api", "--paginate", `${prefix}/issues/${issue.number}/comments`]);
    } finally {
      const failures = [];
      // Work cancellation kills its command tree. Cleanup gets a separate finite
      // budget so the cancelled work signal cannot suppress reconciliation.
      const cleanupSignal = AbortSignal.timeout(60000);
      try {
        if (clientDirectory) {
          cleanupClient = await runPinnedClients(t, { clientDirectory }, { signal: cleanupSignal });
        }
      } catch {
        failures.push("cleanup client unavailable");
      }
      for (const action of cleanup.reverse()) {
        try {
          await action(cleanupSignal);
        } catch (error) {
          failures.push(
            /^(unresolved (issues|pulls|comment)|session cleanup)/.test(error.message)
              ? error.message
              : "live resource reconciliation failed",
          );
        }
      }
      assert.equal(
        failures.length,
        0,
        `live cleanup requires operator attention: ${failures.join("; ")}`,
      );
    }
  },
);
