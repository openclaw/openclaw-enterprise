import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";

import {
  createDocsFixture,
  repositoryRoot,
  spawnDocsPreview,
  waitForDocsPreview,
} from "../helpers/docs-site.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("preview serves static docs on loopback and confines reads to site output", async (t) => {
  const fixture = await temporaryDirectory(t, "enterprise-docs-server-");
  await mkdir(join(fixture, "dist/docs/guide"), { recursive: true });
  await writeFile(join(fixture, "dist/docs/index.html"), "<h1>Home</h1>");
  await writeFile(join(fixture, "dist/docs/guide/index.html"), "<h1>Guide</h1>");
  await writeFile(join(fixture, "private.txt"), "not site content");
  await symlink(join(fixture, "private.txt"), join(fixture, "dist/docs/outside.txt"));
  const child = spawnDocsPreview(fixture);
  t.after(() => stopProcess(child));
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

test(
  "watch preview publishes rebuilds and retains the last successful site on failure",
  { timeout: 120_000 },
  async (t) => {
    let child;
    const { directory } = await createDocsFixture(t, "enterprise-docs-watch-", {
      logo: true,
      beforeRemove: () => child && stopProcess(child),
    });
    await mkdir(join(directory, "scripts"));
    // The fixture owns its sources and output, but invokes the actual renderer and Pagefind.
    await symlink(join(repositoryRoot, "scripts/docs-site"), join(directory, "scripts/docs-site"));
    const page = join(directory, "docs/README.md");
    await writeFile(page, "# First preview\n");
    child = spawnDocsPreview(directory, "--watch");
    const origin = await waitForDocsPreview(child);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events = await fetch(`${origin}/__docs_preview/events`, { signal: controller.signal });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /text\/event-stream/);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    async function nextState(predicate) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const end = buffered.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            const state = JSON.parse(data.slice(6));
            if (predicate(state)) {
              return state;
            }
          }
          continue;
        }
        let timer;
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for preview event")),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(result.done, false, "Preview event stream closed unexpectedly");
        buffered += decoder.decode(result.value, { stream: true });
      }
      throw new Error("Timed out waiting for preview state");
    }
    const first = await nextState((state) => state.revision && !state.error);
    const initial = await (await fetch(origin)).text();
    assert.match(initial, /First preview/);
    assert.match(initial, /__docs_preview\/client\.mjs/);
    const search = await fetch(`${origin}/pagefind/pagefind.js`);
    assert.equal(search.status, 200);
    assert.ok((await search.text()).length > 0);

    await writeFile(page, "# Second preview\n");
    const second = await nextState((state) => state.revision !== first.revision && !state.error);
    assert.match(await (await fetch(origin)).text(), /Second preview/);
    assert.equal((await fetch(`${origin}/pagefind/pagefind.js`)).status, 200);

    // A failed build must not publish partial output or discard the last good generation.
    await writeFile(page, "---\npublished: invalid\n---\n# Broken preview\n");
    const failed = await nextState((state) => Boolean(state.error));
    assert.equal(failed.revision, second.revision);
    assert.match(await (await fetch(origin)).text(), /Second preview/);
    assert.equal((await fetch(`${origin}/pagefind/pagefind.js`)).status, 200);

    await writeFile(page, "# Recovered preview\n");
    await nextState((state) => state.revision !== second.revision && !state.error);
    assert.match(await (await fetch(origin)).text(), /Recovered preview/);
    // The live event connection must not prevent graceful shutdown and cleanup.
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Preview did not stop")), 10_000);
        timer.unref();
      }),
    ]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(
      (await readdir(join(directory, "dist"))).filter((name) => name.startsWith(".docs-preview-")),
      [],
    );
  },
);
