import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { nodeLogExcerpt } from "../../scripts/ci/k3d-diagnostics.ts";
import { captureK3dDiagnostics } from "../../scripts/ci/k3d-preparation-diagnostics.ts";
import { execFile } from "../../scripts/ci/prepare-command.ts";
import { assertAbsent, cutCredentials, cutOffsets } from "../fixtures/cut-credentials.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

export function registerBoundedNodeLogCases() {
  test("k3d node log excerpts stay bounded and keep the start, later errors and the end", () => {
    const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 0, 0, second)).toISOString();
    const info = (second: number) =>
      `${at(second)} I0923 kubelet.go:1] "fixture progress ${second}" ${"x".repeat(200)}`;
    const stdout = [
      // An output cap can start a stream mid-line, past the keyword of a credential.
      "=do-not-publish-cut-credential more",
      `${at(0)} level=info msg="Starting k3s agent fixture"`,
      ...Array.from({ length: 4_000 }, (_, second) => info(second + 1)),
      `${at(4_001)} level=info msg="fixture end of log"`,
    ].join("\n");
    const stderr = [
      `${at(2_000)} E0923 kubelet_node_status.go:1] "Error updating node status" err="fixture lease"`,
      `${at(2_001)} level=error msg="fixture join token=do-not-publish-node-token"`,
      // The credential keyword sits past the 1000-character line cut.
      `${at(2_001)} level=warning msg="do-not-publish-long-line ${"y".repeat(1_100)} password=hidden"`,
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `${at(2_002 + index)} The connection to the server localhost:8080 was refused`,
      ),
    ].join("\n");
    const excerpt = nodeLogExcerpt(stdout, stderr);
    assert.ok(excerpt.length < 42_000, `excerpt has ${excerpt.length} characters`);
    assert.match(excerpt, /^\[diagnostics dropped 1 unstamped line fragments\]\n/);
    assert.match(excerpt, /\n\[diagnostics omitted 500 kubectl retry lines against localhost:8080/);
    assert.match(excerpt, /Starting k3s agent fixture/);
    assert.match(excerpt, /Error updating node status/);
    assert.match(excerpt, /\[redacted credential-bearing line\]/);
    assert.match(excerpt, /fixture end of log"$/);
    assert.match(excerpt, /\[diagnostics omitted \d+ lines; 3 of 3 error and warning lines/);
    assert.doesNotMatch(excerpt, /do-not-publish|localhost:8080 was refused/);
  });

  test("k3d node log excerpts keep a K3s exit that the entrypoint's API retries follow", () => {
    const at = (second: number) => new Date(Date.UTC(2026, 9, 12, 22, 56, second)).toISOString();
    const discovery = (second: number, detail: string) =>
      `${at(second)} E1012 22:56:00.000000 ${second} memcache.go:265] "Unhandled Error" ` +
      `err="couldn't get current server API group list: ${detail}"`;
    const refused = (second: number, server: string) =>
      Array.from({ length: 4 }, () =>
        discovery(
          second,
          `Get \\"${server}/api?timeout=32s\\": dial tcp: connect: connection refused`,
        ),
      ).concat(
        `${at(second)} The connection to the server ${server.replace(/^https?:\/\//, "")} was refused - did you specify the right host or port?`,
      );
    const stdout = [
      `${at(0)} level=info msg="Starting k3s v1.35.9+k3s1"`,
      ...refused(0, "http://localhost:8080"),
      discovery(1, "the server is currently unable to handle the request"),
      `${at(1)} Error from server (ServiceUnavailable): the server is currently unable to handle the request`,
      // Newer kubectl appends a logger field after the error.
      `${at(1)} E1012 22:56:01.000000 1 memcache.go:265] "Unhandled Error" err="couldn't get current server ` +
        `API group list: Get \\"https://127.0.0.1:6443/api?timeout=32s\\": net/http: TLS handshake timeout" ` +
        `logger="UnhandledError"`,
      `${at(1)} Unable to connect to the server: net/http: TLS handshake timeout`,
      // K3s's own lines stay, whatever they say.
      `${at(2)} level=error msg="fixture K3s line: couldn't get current server API group list: kept"`,
      `${at(2)} level=fatal msg="fixture K3s exit cause"`,
      // The finding 1174 node logged API retries for five minutes after K3s exited.
      ...Array.from({ length: 400 }, (_, retry) =>
        refused(5 + retry * 3, "https://127.0.0.1:6443"),
      ).flat(),
    ].join("\n");
    const excerpt = nodeLogExcerpt(stdout, "");
    assert.match(
      excerpt,
      /msg="fixture K3s line: couldn't get current server API group list: kept"\n.*msg="fixture K3s exit cause"$/,
    );
    assert.match(
      excerpt,
      new RegExp(
        [
          `^\\[diagnostics omitted 5 kubectl retry lines against localhost:8080 \\(connection refused\\), ${at(0)} to ${at(0)}\\]`,
          `\\[diagnostics omitted 2 kubectl retry lines against the API server \\(ServiceUnavailable\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 1 kubectl retry lines against 127\\.0\\.0\\.1:6443 \\(TLS handshake timeout\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 1 kubectl retry lines against the API server \\(TLS handshake timeout\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 2000 kubectl retry lines against 127\\.0\\.0\\.1:6443 \\(connection refused\\), ${at(5)} to ${at(1202)}\\]\n`,
        ].join("\n"),
      ),
    );
    assert.doesNotMatch(
      excerpt,
      /memcache|was refused|Error from server|Unable to connect|logger=/,
    );
  });
}

export function registerNodeLogChronologyCases() {
  test("node log excerpts retain sub-millisecond order across Docker streams", () => {
    const stdout = [
      "2026-10-21T00:00:00.123900000Z later stdout",
      "2026-10-21T00:00:00.123100002Z second nanosecond",
      "2026-10-21T00:00:01.000000001Z after whole second",
      "2026-10-21T00:00:02.1Z tied stdout",
    ].join("\n");
    const stderr = [
      "2026-10-21T00:00:00.123100000Z earlier stderr",
      "2026-10-21T00:00:00.123100001Z first nanosecond",
      "2026-10-21T00:00:01Z whole second",
      "2026-10-21T00:00:02.100000000Z tied stderr",
    ].join("\n");
    assert.deepEqual(nodeLogExcerpt(stdout, stderr).split("\n"), [
      "2026-10-21T00:00:00.123100000Z earlier stderr",
      "2026-10-21T00:00:00.123100001Z first nanosecond",
      "2026-10-21T00:00:00.123100002Z second nanosecond",
      "2026-10-21T00:00:00.123900000Z later stdout",
      "2026-10-21T00:00:01Z whole second",
      "2026-10-21T00:00:01.000000001Z after whole second",
      "2026-10-21T00:00:02.1Z tied stdout",
      "2026-10-21T00:00:02.100000000Z tied stderr",
    ]);
  });

  test("node log retry summaries retain the latest kinds within one millisecond", () => {
    const retries = Array.from(
      { length: 13 },
      (_, index) =>
        `2026-10-21T00:00:00.123${String(index + 1).padStart(6, "0")}Z The connection to the server 127.0.0.1:${2000 + index} was refused`,
    );
    const excerpt = nodeLogExcerpt(retries.join("\n"), "");
    assert.doesNotMatch(excerpt, /against 127\.0\.0\.1:2000 /u);
    assert.match(excerpt, /against 127\.0\.0\.1:2012 /u);
    assert.match(excerpt, /omitted 1 earlier kinds of kubectl retry lines/u);
  });

  test("node log retry summaries omit credential-bearing endpoints", () => {
    const endpoint = syntheticCredentialUrl({
      username: "fixture-user",
      password: "fixture-value",
      host: "diagnostic.example.test",
      port: undefined,
    });
    // Retry summaries may echo the endpoint and error detail into the published report.
    const stdout = `2026-10-21T00:00:00Z The connection to the server ${endpoint} was refused`;
    const stderr = `2026-10-21T00:00:01Z Unable to connect to the server: Get ${endpoint}`;
    assert.equal(
      nodeLogExcerpt(stdout, stderr),
      "2026-10-21T00:00:00Z [redacted credential-bearing line]\n" +
        "2026-10-21T00:00:01Z [redacted credential-bearing line]",
    );
  });

  test("node log chronology and retry retention do not depend on the process locale", () => {
    const moduleUrl = new URL("../../scripts/ci/k3d-diagnostics.ts", import.meta.url).href;
    const script = `
      import { nodeLogExcerpt } from ${JSON.stringify(moduleUrl)};
      const early = "2026-10-21T00:00:00.020000000Z early stderr";
      const later = "2026-10-21T00:00:00.100000000Z later stdout";
      const tied = "2026-10-21T00:00:00.1Z tied stderr";
      const retries = ["020000000", "100000000", ...Array.from({ length: 11 }, (_, i) => String(i + 20) + "0000000")]
        .map((fraction, i) => "2026-10-21T00:00:00." + fraction + "Z The connection to the server 127.0.0.1:" + (2000 + i) + " was refused");
      console.log(JSON.stringify({
        numeric: new Intl.Collator().resolvedOptions().numeric,
        events: nodeLogExcerpt(later, early + "\\n" + tied).split("\\n"),
        retries: nodeLogExcerpt(retries.join("\\n"), ""),
      }));
    `;
    const locales: readonly [locale: string, numeric: boolean][] = [
      ["en-US", false],
      ["en-US-u-kn-true", true],
    ];
    for (const [locale, numeric] of locales) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        timeout: 10_000,
      });
      assert.equal(child.status, 0, child.stderr);
      const result = asRecord(JSON.parse(child.stdout));
      assert.ok(result, "expected log projection from the locale subprocess");
      assert.ok(typeof result.retries === "string", "expected the retry summary");
      assert.equal(result.numeric, numeric, locale);
      assert.deepEqual(
        result.events,
        [
          "2026-10-21T00:00:00.020000000Z early stderr",
          "2026-10-21T00:00:00.100000000Z later stdout",
          "2026-10-21T00:00:00.1Z tied stderr",
        ],
        locale,
      );
      assert.doesNotMatch(result.retries, /against 127\.0\.0\.1:2000 /u, locale);
      assert.match(result.retries, /against 127\.0\.0\.1:2001 /u, locale);
      assert.match(result.retries, /omitted 1 earlier kinds of kubectl retry lines/u, locale);
    }
  });
}

export function registerCutOutputCases() {
  test("k3d diagnostics drop the line that a command's output cap cut", async (t) => {
    const directory = await temporaryDirectory(t, "k3d-cut-output-");
    const marker = "[redacted credential-bearing line]";
    const lineEnd = "fixture-cut-line-end";
    // As many lines of `width` characters as fit in `length`, the last one padded to it.
    const lines = (width: number, line: (index: number) => string, length: number) =>
      Array.from({ length: Math.floor((length + 1) / (width + 1)) }, (_, index) =>
        line(index).padEnd(width, "z"),
      )
        .join("\n")
        .padEnd(length, "z");
    // execFile keeps the last 2 MiB of `docker top` and 8 MiB of `docker logs`; each window
    // starts inside a credential. About 200 long process lines that name a credential become
    // markers, so the cut line is inside the 8,000 characters safeText keeps. The private
    // key block is left out: this projection has no private key rule, cut or not.
    const topCap = 2 * 1024 * 1024;
    const cases: { node: string; label: string; secret: string; processLines: number }[] = [];
    for (const { name, text, secret } of cutCredentials.filter(
      ({ text }) => !text.includes("\n"),
    )) {
      for (const offset of cutOffsets(text)) {
        const node = `k3d-cut-server-${cases.length}`;
        const cutLine = `${text.slice(offset)} ${lineEnd}\n`;
        const credentialLines = lines(
          10_000,
          (index) => `root ${index} /bin/fixture --token-file=/run/fixture `,
          topCap - cutLine.length,
        );
        await writeFile(
          join(directory, `${node}.top`),
          `UID PID CMD\nroot 1 /bin/fixture ${text.slice(0, offset)}${cutLine}${credentialLines}`,
        );
        cases.push({
          node,
          label: `${name} cut ${offset} in`,
          secret: secret.slice(Math.max(0, offset - text.indexOf(secret))),
          processLines: credentialLines.split("\n").length,
        });
      }
    }
    // A cut line that starts with a Docker-timestamp-shaped word passes for a stamped line.
    const phrase = "FixturePhrase-0042-value";
    const stamped = `2026-11-18T23:59:59Z ${phrase} ${lineEnd}\n`;
    const logNode = cases[0]!.node;
    await writeFile(
      join(directory, `${logNode}.logs`),
      `2026-11-18T23:59:58Z level=info msg="password: ${stamped}${lines(
        61,
        (index) => `2026-11-19T00:00:00Z level=info msg="fixture progress ${index}"`,
        8 * 1024 * 1024 - stamped.length,
      )}`,
    );
    // A stand-in for the container engine behind the real execFile and its output cap.
    const standIn = join(directory, "engine.mjs");
    await writeFile(
      standIn,
      'import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(process.argv[2]));\n',
    );
    const statePath = join(directory, "state.json");
    await captureK3dDiagnostics({
      execFile: (command, args, options) => {
        const payload = join(directory, `${args.at(-1)}.${args[0]}`);
        return existsSync(payload)
          ? execFile(process.execPath, [standIn, payload], options)
          : Promise.reject(new Error(`${command} ${args[0]} unavailable`));
      },
      cluster: {
        name: "k3d-cut",
        owner: "fixture-owner",
        directory,
        kubeconfig: join(directory, "kubeconfig"),
        context: "k3d-cut",
        nodes: cases.map(({ node }) => node),
      },
      lane: "fixture-lane",
      statePath,
    });
    const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
    const containers = asRecord(JSON.parse(text))?.containers;
    assert.ok(Array.isArray(containers), "expected the node containers");
    assert.doesNotMatch(text, new RegExp(lineEnd), "a cut line is published");
    const records = containers.map((entry: unknown) => asRecord(entry));
    for (const { node, label, secret, processLines } of cases) {
      const container = records.find((entry) => entry?.name === node);
      // Only the whole lines after the cut remain, each one a credential-bearing line.
      assert.deepEqual(
        container?.processes,
        { status: "ok", value: Array.from({ length: processLines }, () => marker).join("\n") },
        label,
      );
      assertAbsent(text, secret, label);
    }
    const logs = asRecord(records.find((entry) => entry?.name === logNode)?.logs);
    assert.equal(logs?.status, "ok");
    assert.match(String(logs?.value), /fixture progress \d+"/);
    assertAbsent(text, phrase, "a stamped cut line");
  });
}
