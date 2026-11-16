import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
    // The sender enforces one exact writable ref before any material read: another branch,
    // the fixed base and a deletion are refused without a provider connection.
    // Discovery (GET info/refs) is still served; every refused POST stops before material.
    const pushes = () => f.writes.filter(({ path }) => path.endsWith("/git-receive-pack")).length;
    const refused = pushes();
    const authorized = f.authorizations.filter(({ operation }) => operation === "receive-pack");
    for (const refspec of ["HEAD:refs/heads/other", "HEAD:refs/heads/main", ":refs/heads/review"]) {
      await assert.rejects(route.remoteGit(["push", "origin", refspec], copy), /403/);
      assert.equal(f.receipts.at(-1)?.stage, "request-refused");
    }
    await assert.rejects(
      route.remoteGit(["push", "origin", "HEAD:refs/heads/review", "HEAD:refs/heads/other"], copy),
      /403/,
    );
    assert.equal(pushes(), refused);
    assert.deepEqual(
      f.authorizations.filter(({ operation }) => operation === "receive-pack"),
      authorized,
    );
    assert.equal(
      (await f.git(["--git-dir", f.repoPath, "rev-parse", "refs/heads/main"])).stdout.trim() ===
        expected,
      false,
    );
    await assert.rejects(
      f.git(["--git-dir", f.repoPath, "rev-parse", "--verify", "refs/heads/other"]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 128,
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
    assert.equal((await route.call(path, undefined, f.unrelatedBearer)).status, 403);
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

test(
  "a missing, wrong, ambiguous or replaced execution bearer is refused before any material read or connect",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const route = await f.install();
    const refs = "/repository.git/info/refs?service=git-upload-pack";
    const quiet = () => ({
      reads: f.state.materialReads,
      authorizations: f.authorizations.length,
      connections: f.connections(),
      writes: f.writes.length,
    });
    const before = quiet();
    const raw = (headers: Record<string, string | string[]>, path = refs) =>
      route.raw(path, headers);
    assert.equal((await route.call(refs, undefined, null)).status, 403);
    assert.equal((await route.call(refs, undefined, f.unrelatedBearer)).status, 403);
    assert.equal((await route.call(refs, undefined, `${f.bearer}x`)).status, 403);
    assert.equal((await route.call(refs, undefined, f.bearer.slice(1))).status, 403);
    assert.equal((await raw({ authorization: `bearer ${f.bearer}` })).status, 403);
    assert.equal((await raw({ authorization: `Basic ${f.bearer}` })).status, 403);
    assert.equal(
      (await raw({ authorization: [`Bearer ${f.bearer}`, `Bearer ${f.bearer}`] })).status,
      403,
    );
    assert.equal(
      (
        await raw({
          authorization: `Bearer ${f.bearer}`,
          "proxy-authorization": `Bearer ${f.bearer}`,
        })
      ).status,
      403,
    );
    assert.ok(f.receipts.every(({ stage }) => stage === "execution-refused"));
    assert.deepEqual(quiet(), before);

    // A correct bearer on a path or method outside the fixed endpoints never reaches material.
    for (const path of [
      "/repository.git/info/refs?service=git-upload-archive",
      "/repository.git/HEAD",
      "/repos/example/review/pulls",
      "/draft-pull?x=1",
      "/other.git/info/refs?service=git-upload-pack",
    ]) {
      assert.equal((await route.call(path)).status, 403);
      assert.equal(f.receipts.at(-1)?.stage, "request-refused");
    }
    assert.equal((await route.call("/draft-pull")).status, 403);
    assert.deepEqual(quiet(), before);

    assert.equal((await route.call(refs)).status, 200);
    const served = quiet();

    // Execution replacement: the host now reports a new run with a different bearer digest.
    // The old bearer is refused even though the sender, route and material are unchanged.
    const next = f.replaceExecution();
    assert.equal((await route.call(refs)).status, 403);
    assert.equal(f.receipts.at(-1)?.stage, "execution-refused");
    // The new execution's bearer is not this sender's execution either.
    assert.equal((await route.call(refs, undefined, next)).status, 403);
    assert.deepEqual(quiet(), served);
    assert.ok(!JSON.stringify(f.receipts).includes(f.bearer));
  },
);

test("the push command list admits exactly one update of the selected head", async () => {
  const { exactPushCommands } = await import("../../deploy/examples/strands-box/git/protocol.ts");
  const repository = {
    repository: "example/review",
    repositoryId: "1",
    installationId: "2",
    head: "review",
    base: "main",
  };
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
  const old = "a".repeat(40);
  const next = "b".repeat(40);
  const zero = "0".repeat(40);
  const body = (...lines: string[]) => Buffer.from(lines.join("") + "0000PACK");
  const caps = "\0report-status side-band-64k agent=git/2\n";
  assert.equal(
    exactPushCommands(body(pkt(`${old} ${next} refs/heads/review${caps}`)), repository),
    true,
  );
  assert.equal(
    exactPushCommands(body(pkt(`${zero} ${next} refs/heads/review${caps}`)), repository),
    true,
  );
  assert.equal(
    exactPushCommands(
      body(pkt(`shallow ${old}\n`), pkt(`${old} ${next} refs/heads/review${caps}`)),
      repository,
    ),
    true,
  );
  for (const refused of [
    body(pkt(`${old} ${next} refs/heads/main${caps}`)),
    body(pkt(`${old} ${zero} refs/heads/review${caps}`)),
    body(pkt(`${old} ${next} refs/heads/review-2${caps}`)),
    body(pkt(`${old} ${next} refs/tags/review${caps}`)),
    body(pkt(`${old} ${next} refs/heads/review${caps}`), pkt(`${old} ${next} refs/heads/other\n`)),
    body(pkt(`${old} ${next} refs/heads/review\0report-status push-options\n`)),
    body(pkt(`push-cert\0report-status\n`)),
    body(pkt(`${old} ${"b".repeat(64)} refs/heads/review${caps}`)),
    body(pkt(`${old} ${next} refs/heads/review\n`)),
    Buffer.from("0000PACK"),
    Buffer.from("zzzz"),
    Buffer.from(pkt(`${old} ${next} refs/heads/review${caps}`)),
  ]) {
    assert.equal(exactPushCommands(refused, repository), false);
  }
});

test(
  "a push larger than http.postBuffer passes Git's flush-only probe without a provider write",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const route = await f.install();
    const copy = join(f.root, "client");
    await route.remoteGit(["clone", route.remote, copy]);
    // Incompressible content: the pack exceeds the 1 KiB post buffer, so Git first POSTs "0000".
    await writeFile(join(copy, "large.bin"), randomBytes(64 * 1024));
    await f.git(["add", "large.bin"], copy);
    await f.commit("large change", copy);
    const expected = (await f.git(["rev-parse", "HEAD"], copy)).stdout.trim();
    const before = f.authorizations.length;
    await route.remoteGit(
      ["-c", "http.postBuffer=1024", "push", "origin", "HEAD:refs/heads/review"],
      copy,
    );
    assert.equal(
      (await f.git(["--git-dir", f.repoPath, "rev-parse", "refs/heads/review"])).stdout.trim(),
      expected,
    );
    // Only the real push was authorized and sent; the probe never reached material or origin.
    assert.equal(
      f.authorizations.slice(before).filter(({ operation }) => operation === "receive-pack").length,
      1,
    );
    assert.ok(f.receipts.some(({ stage }) => stage === "probe-answered"));
    // A second large push still works: the probe never takes a journal slot.
    await writeFile(join(copy, "large.bin"), randomBytes(64 * 1024));
    await f.git(["add", "large.bin"], copy);
    await f.commit("second large change", copy);
    await route.remoteGit(
      ["-c", "http.postBuffer=1024", "push", "origin", "HEAD:refs/heads/review"],
      copy,
    );
  },
);
