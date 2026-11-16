import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";

import type { PreviewState } from "../../scripts/docs-site/preview-build.ts";

import {
  createDocsFixture,
  repositoryRoot,
  spawnDocsPreview,
  waitForDocsPreview,
} from "../helpers/docs-site.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("preview serves static docs on loopback and confines reads to site output", async (t) => {
  const fixture = await temporaryDirectory(t, "enterprise-docs-server-");
  await mkdir(join(fixture, "dist/docs/guide"), { recursive: true });
  await writeFile(join(fixture, "dist/docs/index.html"), "<h1>Home</h1>");
  await writeFile(join(fixture, "dist/docs/guide/index.html"), "<h1>Guide</h1>");
  await writeFile(join(fixture, "private.txt"), "not site content");
  await symlink(join(fixture, "private.txt"), join(fixture, "dist/docs/outside.txt"));
  // An absent working directory causes a spawn error. An invalid port starts
  // the executable but exits without ever opening a listener.
  await assert.rejects(waitForDocsPreview(spawnDocsPreview(join(fixture, "missing"))), {
    code: "ENOENT",
  });
  await assert.rejects(
    waitForDocsPreview(spawnDocsPreview(fixture, "--port", "invalid")),
    /Docs preview exited before ready: 1/,
  );
  const child = spawnDocsPreview(fixture);
  t.after(async () => {
    if (child.pid !== undefined) {
      await stopProcess(child);
    }
  });
  const origin = await waitForDocsPreview(child);
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await home.text(), "<h1>Home</h1>");
  const redirect = await fetch(`${origin}/guide?test=1`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/guide/?test=1");
  assert.equal((await fetch(`${origin}/guide/`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${origin}/guide/`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/__docs_preview/client.mjs`)).status, 404);
  for (const path of ["/missing", "/outside.txt", "/%2e%2e%2f%2e%2e%2fprivate.txt"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  // A loopback bind must not become a content endpoint for an unrelated hostname.
  const status = await new Promise<number | undefined>(
    (resolve, reject: (reason: unknown) => void) => {
      request(origin, { headers: { Host: "unrelated.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on("error", reject)
        .end();
    },
  );
  assert.equal(status, 403);
});

test(
  "watch preview publishes rebuilds and retains the last successful site on failure",
  { timeout: 120_000 },
  async (t) => {
    const preview: { child?: ReturnType<typeof spawnDocsPreview> } = {};
    const controller = new AbortController();
    const { directory } = await createDocsFixture(t, "enterprise-docs-watch-", {
      logo: true,
      async beforeRemove() {
        controller.abort();
        if (preview.child?.pid !== undefined) {
          await stopProcess(preview.child);
        }
      },
    });
    await mkdir(join(directory, "scripts"));
    // The fixture owns its sources and output, but invokes the actual renderer and Pagefind.
    await symlink(join(repositoryRoot, "scripts/docs-site"), join(directory, "scripts/docs-site"));
    const page = join(directory, "docs/README.md");
    await writeFile(page, "# First preview\n");
    const child = spawnDocsPreview(directory, "--watch");
    preview.child = child;
    const origin = await waitForDocsPreview(child);
    const events = await fetch(`${origin}/__docs_preview/events`, { signal: controller.signal });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(events.body);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    async function nextState(predicate: (state: PreviewState) => boolean): Promise<PreviewState> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const end = buffered.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            const state: unknown = JSON.parse(data.slice(6));
            assert.ok(state !== null && typeof state === "object", "Expected a preview state");
            assert.ok("revision" in state && typeof state.revision === "string");
            assert.ok("error" in state && typeof state.error === "string");
            const { revision, error } = state;
            const previewState = { revision, error };
            if (predicate(previewState)) {
              return previewState;
            }
          }
          continue;
        }
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject: (reason: unknown) => void) => {
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
    const first = await nextState((state) => state.revision !== "" && state.error === "");
    const initial = await (await fetch(origin)).text();
    assert.match(initial, /First preview/);
    assert.match(initial, /__docs_preview\/client\.mjs/);
    // The injected watch client keeps its existing HTTP URL and JavaScript response.
    const clientUrl = `${origin}/__docs_preview/client.mjs`;
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(clientUrl, { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const source = await response.text();
      if (method === "HEAD") {
        assert.equal(source, "");
      } else {
        assert.ok(source.length > 0);
      }
    }
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
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.kill("SIGTERM");
    let shutdownTimer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject: (reason: unknown) => void) => {
        shutdownTimer = setTimeout(() => reject(new Error("Preview did not stop")), 10_000);
        shutdownTimer.unref();
      }),
    ]).finally(() => clearTimeout(shutdownTimer));
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(
      (await readdir(join(directory, "dist"))).filter((name) => name.startsWith(".docs-preview-")),
      [],
    );
  },
);
