import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { spawnDocsPreview, waitForDocsPreview } from "../helpers/docs-site.mjs";

test("preview serves static docs on loopback and confines reads to site output", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-server-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "dist/docs/guide"), { recursive: true });
  await writeFile(join(fixture, "dist/docs/index.html"), "<h1>Home</h1>");
  await writeFile(join(fixture, "dist/docs/guide/index.html"), "<h1>Guide</h1>");
  await writeFile(join(fixture, "private.txt"), "not site content");
  await symlink(join(fixture, "private.txt"), join(fixture, "dist/docs/outside.txt"));
  const child = spawnDocsPreview(fixture);
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const origin = await waitForDocsPreview(child);
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.equal(await home.text(), "<h1>Home</h1>");
  const redirect = await fetch(`${origin}/guide?test=1`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/guide/?test=1");
  assert.equal((await fetch(`${origin}/guide/`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${origin}/guide/`, { method: "POST" })).status, 405);
  for (const path of ["/missing", "/outside.txt", "/%2e%2e%2f%2e%2e%2fprivate.txt"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  // A loopback bind must not become a content endpoint for an unrelated hostname.
  const status = await new Promise((resolve, reject) => {
    request(origin, { headers: { Host: "unrelated.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on("error", reject)
      .end();
  });
  assert.equal(status, 403);
});
