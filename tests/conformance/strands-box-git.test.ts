import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { strandsRepositorySenderFixture as fixture } from "../helpers/strands-repository-sender.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

test(
  "a paired sender forwards real Git and one fixed draft, then stops new sends on withdrawal",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const route = await f.install();
    const copy = join(f.root, "client");
    await route.remoteGit(["clone", route.remote, copy]);
    assert.equal(await readFile(join(copy, "tracked.txt"), "utf8"), "first\n");
    await writeFile(join(copy, "tracked.txt"), "review change\n");
    await f.commit("review change", copy);
    const expected = (await f.git(["rev-parse", "HEAD"], copy)).stdout.trim();
    await route.remoteGit(["push", "origin", "HEAD:refs/heads/review"], copy);
    assert.equal(
      (await f.git(["--git-dir", f.repoPath, "rev-parse", "refs/heads/review"])).stdout.trim(),
      expected,
    );

    const originalPush = f.writes.find(({ path }) => path.endsWith("/git-receive-pack"));
    assert.ok(originalPush);
    assert.equal(
      (
        await route.call(
          "/repository.git/git-receive-pack",
          originalPush.body,
          undefined,
          "version=1",
        )
      ).status,
      403,
    );
    assert.equal(f.receipts.at(-1)?.stage, "write-already-attempted");
    assert.equal(
      JSON.parse(
        await readFile(join(f.journal, `push-${sha(originalPush.body)}-result.json`), "utf8"),
      ).status,
      "provider-replied",
    );

    const before = f.writes.length;
    assert.equal(
      (await route.call("/different.git/info/refs?service=git-upload-pack")).status,
      403,
    );
    assert.equal(
      (await route.call("/different.git/git-receive-pack", originalPush.body)).status,
      403,
    );
    assert.equal(f.writes.length, before);
    // GitHub's selected-repository grant is the permission boundary. This
    // separate valid Git request proves the sender does not invent a ref policy.
    await route.remoteGit(["push", "origin", "HEAD:refs/heads/other"], copy);
    assert.equal(
      (await f.git(["--git-dir", f.repoPath, "rev-parse", "refs/heads/other"])).stdout.trim(),
      expected,
    );
    const pr = await route.call("/draft-pull", { title: "Review change" });
    assert.equal(pr.status, 201);
    assert.deepEqual(JSON.parse(pr.body.toString()), {
      id: "81",
      number: 7,
      draft: true,
      state: "open",
      url: "https://github.com/example/review/pull/7",
    });
    assert.deepEqual(JSON.parse(f.writes.at(-1)?.body.toString() ?? ""), {
      title: "Review change",
      head: "review",
      base: "main",
      draft: true,
    });
    assert.equal((await route.call("/draft-pull", { title: "Second" })).status, 403);
    assert.equal(f.writes.filter(({ path }) => path.endsWith("/pulls")).length, 1);

    assert.deepEqual(
      f.writes.map((event) => event.digest),
      f.authorizations.map((q) => q.requestDigestSha256),
    );
    for (const use of f.authorizations) {
      const exchange = f.receipts.filter(({ exchangeId }) => exchangeId === use.exchangeId);
      assert.deepEqual(
        exchange.map(({ stage }) => stage),
        ["authorized", "provider-replied"],
      );
      assert.equal(exchange[0]?.operation, use.operation);
      assert.ok(
        f.receipts.some(
          (event) => event.requestId === exchange[0]?.requestId && event.stage === "received",
        ),
      );
    }
    const writesBefore = f.writes.length;
    const authBefore = f.authorizations.length;
    f.state.withdrawn = true;
    assert.equal(
      (await route.call("/repository.git/info/refs?service=git-upload-pack")).status,
      403,
    );
    assert.equal(f.writes.length, writesBefore);
    assert.equal(f.authorizations.length, authBefore);
    assert.equal(f.receipts.at(-1)?.stage, "material-refused");
    assert.equal(f.receipts.at(-1)?.reason, "withdrawn");
    assert.equal(f.receipts.at(-1)?.exchangeId, undefined);
    assert.ok(!JSON.stringify(f.receipts).includes(f.material.value));
  },
);

test(
  "foreign peer, missing authority and a replaced recipient cannot disclose material or write",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const path = "/repository.git/info/refs?service=git-upload-pack";
    const unbound = await f.install(false);
    const route = await f.install();
    assert.equal((await unbound.call(path)).status, 403);
    assert.equal((await route.call(path, undefined, f.unrelatedLeaf)).status, 403);
    assert.equal(f.state.materialReads, 0);
    f.state.missing = true;
    assert.equal((await route.call(path)).status, 403);
    assert.equal(f.receipts.at(-1)?.stage, "material-refused");
    assert.equal(f.authorizations.length, 0);
    f.state.missing = false;
    f.state.withdrawAtAuthorization = true;
    assert.equal((await route.call(path)).status, 403);
    assert.equal(f.receipts.at(-1)?.stage, "authorization-refused");
    assert.equal(f.receipts.at(-1)?.reason, "withdrawn");
    assert.equal(f.receipts.at(-1)?.exchangeId, f.authorizations[0]?.exchangeId);
    assert.equal(f.writes.length, 0);
    f.state.withdrawAtAuthorization = false;
    f.state.replaceAfterAllow = true;
    assert.equal((await route.call(path)).status, 403);
    assert.equal(f.receipts.at(-1)?.stage, "not-sent");
    assert.equal(f.authorizations.length, 2);
    assert.equal(f.writes.length, 0);
  },
);

test(
  "a lost draft result survives a sender restart and cannot trigger a replay",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const route = await f.install();
    f.state.loseDraft = true;
    assert.equal((await route.call("/draft-pull", { title: "One attempt" })).status, 502);
    assert.equal(f.writes.length, 1);
    assert.equal(f.receipts.at(-1)?.stage, "outcome-unknown");
    assert.equal(
      JSON.parse(await readFile(join(f.journal, "draft-result.json"), "utf8")).status,
      "outcome-unknown",
    );
    await route.binding?.close();
    f.state.loseDraft = false;
    const restarted = await f.install();
    assert.equal((await restarted.call("/draft-pull", { title: "No replay" })).status, 403);
    assert.equal(f.writes.length, 1);
    assert.equal(f.authorizations.length, 1);
  },
);

test(
  "withdrawing one original execution leaves another sender's independent authority intact",
  { timeout: 20_000 },
  async (t) => {
    const [one, two] = await Promise.all([fixture(t, "first-agent"), fixture(t, "second-agent")]);
    const [a, b] = await Promise.all([one.install(), two.install()]);
    const refs = "/repository.git/info/refs?service=git-upload-pack";
    assert.equal((await a.call(refs)).status, 200);
    one.state.withdrawn = true;
    assert.equal((await a.call(refs)).status, 403);
    assert.equal((await b.call(refs)).status, 200);
    assert.equal(one.authorizations.length, 1);
    assert.equal(two.authorizations.length, 1);
    assert.equal(one.writes.length, 1);
    assert.equal(two.writes.length, 1);
  },
);

test(
  "an applied push with a lost reply stays unknown to the sender and cannot be replayed",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const route = await f.install();
    const copy = join(f.root, "client");
    await route.remoteGit(["clone", route.remote, copy]);
    await writeFile(join(copy, "tracked.txt"), "uncertain response\n");
    await f.commit("uncertain response", copy);
    const expected = (await f.git(["rev-parse", "HEAD"], copy)).stdout.trim();
    f.state.losePush = true;
    await assert.rejects(
      route.remoteGit(["push", "origin", "HEAD:refs/heads/review"], copy),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /502/.test(error.stderr),
    );
    assert.equal(f.receipts.at(-1)?.stage, "outcome-unknown");
    assert.equal(
      (await f.git(["--git-dir", f.repoPath, "rev-parse", "refs/heads/review"])).stdout.trim(),
      expected,
    );
    const original = f.writes.find(({ path }) => path.endsWith("/git-receive-pack"));
    assert.ok(original);
    assert.equal(
      JSON.parse(await readFile(join(f.journal, `push-${sha(original.body)}-result.json`), "utf8"))
        .status,
      "outcome-unknown",
    );
    await route.binding?.close();
    const restarted = await f.install();
    assert.equal(
      (await restarted.call("/repository.git/git-receive-pack", original.body)).status,
      403,
    );
    assert.equal(f.writes.filter(({ path }) => path.endsWith("/git-receive-pack")).length, 1);
  },
);
