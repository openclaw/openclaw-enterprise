import assert from "node:assert/strict";
import { readFile, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ConsoleThemeError,
  loadConsoleTheme,
} from "../../apps/controller/src/composition/console-theme.ts";
import { startApi, startupFailureFields } from "../../apps/controller/src/api-startup.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

async function bundle(t: TestContext, manifest: object = { schemaVersion: 1 }) {
  const directory = await temporaryDirectory(t, "occ-theme-");
  await writeFile(join(directory, "theme.json"), JSON.stringify(manifest));
  return directory;
}

test("mounted console themes serve public branding without changing API failures", async (t) => {
  const displayName = 'Example <Agents> & "Friends" $&';
  const directory = await bundle(t, {
    schemaVersion: 1,
    displayName,
    logo: "logo.png",
    favicon: "icon.png",
    colors: { accent: "#2457C5", surface2: "#EEEEEE", accentSubtle: "#2457C514" },
  });
  const image = await readFile(
    new URL("../../apps/controller/src/console/favicon-32.png", import.meta.url),
  );
  await writeFile(join(directory, "logo.png"), image);
  await writeFile(join(directory, "icon.png"), image);
  // The real startup loader feeds the same app option used by production composition.
  const theme = await loadConsoleTheme(directory);
  const fixture = await createConsoleAppFixture(t, { consoleTheme: theme });
  const shell = await fixture.rawRequest("GET", "/console/login");
  assert.equal(shell.response.status, 200);
  assert.ok(
    shell.text.includes("<title>Example &lt;Agents&gt; &amp; &quot;Friends&quot; $&amp;</title>"),
  );
  assert.match(shell.text, /occ-console-display-name/);
  assert.match(shell.text, /href="\/console\/theme\/colors.css"/);
  assert.match(shell.text, /href="\/console\/theme\/icon.png"/);
  assert.equal(shell.response.headers.get("cache-control"), "no-store");
  const policy = shell.response.headers.get("content-security-policy");
  assert.ok(policy);
  assert.doesNotMatch(policy, /unsafe-inline/);
  const css = await fixture.rawRequest("GET", "/console/theme/colors.css");
  assert.equal(css.response.status, 200);
  assert.match(css.text, /--color-accent: #2457C5/);
  assert.match(css.text, /--color-surface-2: #EEEEEE/);
  assert.match(css.text, /--color-accent-subtle: #2457C514/);
  const logo = await fetch(`${fixture.origin}/console/theme/logo.png`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), image);
  const head = await fetch(`${fixture.origin}/console/theme/logo.png`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(image.length));
  for (const path of [
    "/console/theme/theme.json",
    "/console/theme/missing.png",
    "/console/theme/%2e%2e%2fserver.mjs",
  ]) {
    const missing = await fixture.rawRequest("GET", path);
    assert.equal(missing.response.status, 404);
    assert.doesNotMatch(missing.text, /<!doctype|OCC_|occ-theme-/i);
  }
  const api = await fixture.rawRequest("GET", "/api/does-not-exist");
  assert.equal(JSON.parse(api.text).error.code, "NOT_FOUND");
});

test("theme snapshots stay fixed until startup reload and remain isolated between apps", async (t) => {
  const directory = await bundle(t, {
    schemaVersion: 1,
    displayName: "First",
    colors: { accent: "#112233" },
  });
  const first = await createConsoleAppFixture(t, {
    consoleTheme: await loadConsoleTheme(directory),
  });
  await writeFile(
    join(directory, "theme.json"),
    JSON.stringify({ schemaVersion: 1, displayName: "Second", colors: { accent: "#445566" } }),
  );
  const second = await createConsoleAppFixture(t, {
    consoleTheme: await loadConsoleTheme(directory),
  });
  for (const [fixture, name, accent] of [
    [first, "First", "#112233"],
    [second, "Second", "#445566"],
    [first, "First", "#112233"],
  ] as const) {
    const html = await fixture.rawRequest("GET", "/console/");
    assert.match(html.text, new RegExp(`<title>${name}</title>`));
    const response = await fetch(`${fixture.origin}/console/theme/colors.css`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), new RegExp(accent));
  }
});

test("minimal themes inherit bundled branding and absent configuration keeps the shell", async (t) => {
  assert.equal(await loadConsoleTheme(undefined), undefined);
  const theme = await loadConsoleTheme(await bundle(t));
  const fixture = await createConsoleAppFixture(t, { consoleTheme: theme });
  const response = await fixture.rawRequest("GET", "/console/");
  assert.match(response.text, /<title>OpenClaw Enterprise<\/title>/);
  assert.match(response.text, /\/console\/oce-mascot.png/);
});

test("invalid theme manifests fail configuration rather than falling back", async (t) => {
  for (const manifest of [
    {},
    { schemaVersion: 2 },
    { schemaVersion: 1, extra: true },
    { schemaVersion: 1, displayName: " " },
    { schemaVersion: 1, displayName: "x".repeat(81) },
    { schemaVersion: 1, displayName: "name\n" },
    { schemaVersion: 1, colors: null },
    { schemaVersion: 1, colors: { madeUp: "#112233" } },
    { schemaVersion: 1, colors: { accent: "red; background: url(https://example.com)" } },
    ...[
      "../file.png",
      "/file.png",
      "https://example.com/logo.png",
      "folder/file.png",
      "logo.svg",
      "missing.png",
    ].map((logo) => ({ schemaVersion: 1, logo })),
  ]) {
    await assert.rejects(loadConsoleTheme(await bundle(t, manifest)), ConsoleThemeError);
  }
  const malformed = await bundle(t);
  await writeFile(join(malformed, "theme.json"), "{");
  await assert.rejects(loadConsoleTheme(malformed), ConsoleThemeError);
  await writeFile(join(malformed, "theme.json"), " ".repeat(65537));
  await assert.rejects(loadConsoleTheme(malformed), ConsoleThemeError);
  await assert.rejects(loadConsoleTheme(""), ConsoleThemeError);
  await assert.rejects(loadConsoleTheme("relative"), ConsoleThemeError);
});

test("API startup refuses an invalid mounted theme before listening", async (t) => {
  const directory = await bundle(t, { schemaVersion: 2 });
  await assert.rejects(
    startApi({
      NODE_ENV: "development",
      OCC_HOST: "127.0.0.1",
      OCC_PORT: "3000",
      OCC_CONSOLE_THEME_DIR: directory,
    }),
    (error: unknown) =>
      error instanceof ConsoleThemeError &&
      startupFailureFields(error).code === "CONSOLE_THEME_INVALID",
  );
});

test("image formats, size limits and resolved paths are enforced, including ConfigMap projections", async (t) => {
  const directory = await bundle(t, { schemaVersion: 1, logo: "logo.png" });
  await writeFile(join(directory, "logo.png"), "not an image");
  await assert.rejects(loadConsoleTheme(directory), ConsoleThemeError);
  await writeFile(join(directory, "logo.png"), Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(loadConsoleTheme(directory), ConsoleThemeError);
  const external = await bundle(t);
  const image = await readFile(
    new URL("../../apps/controller/src/console/favicon-32.png", import.meta.url),
  );
  await writeFile(join(external, "outside.png"), image);
  await rm(join(directory, "logo.png"));
  await symlink(join(external, "outside.png"), join(directory, "logo.png"));
  await assert.rejects(loadConsoleTheme(directory), ConsoleThemeError);
  // Kubernetes projects ConfigMap keys through a generation directory and ..data link.
  await rm(join(directory, "logo.png"));
  await mkdir(join(directory, "..generation"));
  await writeFile(join(directory, "..generation", "logo.png"), image);
  await symlink("..generation", join(directory, "..data"));
  await symlink("..data/logo.png", join(directory, "logo.png"));
  assert.ok(await loadConsoleTheme(directory));
});
