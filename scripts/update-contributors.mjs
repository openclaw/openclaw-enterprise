#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "openclaw/openclaw-enterprise";
const root = fileURLToPath(new URL("../", import.meta.url));
const readmePath = new URL("../README.md", import.meta.url);
const correctionsPath = new URL("./contributors.json", import.meta.url);
const startMarker = "<!-- contributors:start -->";
const endMarker = "<!-- contributors:end -->";

function github(endpoint, paginated = false) {
  const args = ["api", "--hostname", "github.com", endpoint];
  if (paginated) {
    args.push("--paginate", "--slurp");
  }
  let value;
  try {
    value = JSON.parse(
      execFileSync("gh", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch {
    // CLI errors can contain credential-bearing URLs; keep diagnostics local.
    throw new Error(
      `Could not read ${endpoint}. Check gh authentication, repository access, rate limits, and connectivity, then retry. README unchanged.`,
    );
  }
  if (!paginated) {
    return value;
  }
  assert.ok(
    Array.isArray(value) && value.length > 0 && value.every(Array.isArray),
    "GitHub returned invalid pagination data. README unchanged.",
  );
  return value.flat();
}

function readCorrections() {
  let corrections;
  try {
    corrections = JSON.parse(readFileSync(correctionsPath, "utf8"));
  } catch {
    throw new Error("Could not read scripts/contributors.json as JSON. README unchanged.");
  }
  assert.ok(
    corrections && typeof corrections === "object" && !Array.isArray(corrections),
    "contributors.json must be an object keyed by numeric GitHub account ID.",
  );
  for (const [id, correction] of Object.entries(corrections)) {
    assert.ok(
      /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)),
      "Contributor correction keys must be positive numeric GitHub account IDs.",
    );
    assert.ok(
      correction && typeof correction === "object" && !Array.isArray(correction),
      `Correction ${id} must be an object.`,
    );
    assert.ok(
      Object.keys(correction).every((key) =>
        ["include", "exclude", "displayName", "url", "reason"].includes(key),
      ),
      `Correction ${id} contains an unknown field.`,
    );
    for (const key of ["include", "exclude"]) {
      assert.ok(
        correction[key] === undefined || typeof correction[key] === "boolean",
        `Correction ${id}: ${key} must be a boolean.`,
      );
    }
    assert.ok(
      !(correction.include && correction.exclude),
      `Correction ${id} cannot both include and exclude an account.`,
    );
    assert.ok(
      correction.displayName === undefined ||
        (typeof correction.displayName === "string" && correction.displayName.trim()),
      `Correction ${id}: displayName must be a nonempty string.`,
    );
    assert.ok(
      correction.include || correction.exclude || correction.displayName,
      `Correction ${id} must include, exclude, or name an account.`,
    );
    assert.ok(
      typeof correction.reason === "string" && correction.reason.trim(),
      `Correction ${id} needs a reason.`,
    );
    let url;
    try {
      url = new URL(correction.url);
    } catch {
      throw new Error(`Correction ${id} needs a public HTTPS evidence URL.`);
    }
    assert.ok(
      url.protocol === "https:" && !url.username && !url.password,
      `Correction ${id} needs a public HTTPS evidence URL without credentials.`,
    );
  }
  return corrections;
}

function accountId(user) {
  assert.ok(
    user && Number.isSafeInteger(user.id) && user.id > 0,
    "GitHub returned an unresolved contributor. Add an explicit correction before retrying.",
  );
  return String(user.id);
}

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function updateContributors() {
  assert.equal(process.argv.length, 2, "Usage: node scripts/update-contributors.mjs");
  const readme = readFileSync(readmePath, "utf8");
  assert.ok(
    readme.split(startMarker).length === 2 && readme.split(endMarker).length === 2,
    "README must contain exactly one contributors:start / contributors:end marker pair.",
  );
  const start = readme.indexOf(startMarker) + startMarker.length;
  const end = readme.indexOf(endMarker);
  assert.ok(start <= end, "README contributor markers are out of order.");
  const corrections = readCorrections();
  const metadata = github(`repos/${repository}`);
  assert.ok(
    metadata.full_name === repository && typeof metadata.default_branch === "string",
    "GitHub returned an unexpected repository identity or default branch.",
  );
  const branchEndpoint = `repos/${repository}/commits/${encodeURIComponent(metadata.default_branch)}`;
  const baseline = github(branchEndpoint).sha;
  assert.match(baseline, /^[0-9a-f]{40}$/, "GitHub returned an invalid default-branch SHA.");
  const ids = new Set();
  for (const user of github(`repos/${repository}/contributors?per_page=100`, true)) {
    ids.add(accountId(user));
  }
  for (const pr of github(`repos/${repository}/pulls?state=closed&per_page=100`, true)) {
    assert.ok(pr && Object.hasOwn(pr, "merged_at") && pr.base, "Invalid GitHub PR data.");
    if (pr.merged_at && pr.base.ref === metadata.default_branch) {
      // Deleted authors have no account ID to resolve; retain the prior-wall guard below.
      if (pr.user === null) {
        console.warn(`Skipping merged PR #${pr.number}: its author is unavailable.`);
        continue;
      }
      ids.add(accountId(pr.user));
    }
  }
  for (const [id, correction] of Object.entries(corrections)) {
    if (correction.include) {
      ids.add(id);
    }
    assert.ok(
      !correction.displayName || ids.has(id) || correction.exclude,
      `Display override ${id} has no contributor; use include with evidence if appropriate.`,
    );
  }

  // API omissions must not silently erase previously published recognition.
  for (const match of readme
    .slice(start, end)
    .matchAll(/avatars\.githubusercontent\.com\/u\/(\d+)\?/g)) {
    const id = match[1];
    assert.ok(
      ids.has(id) || corrections[id]?.exclude,
      `Previously credited account ${id} is missing. Retry later or add an explicit inclusion/exclusion with evidence.`,
    );
  }
  const people = [];
  for (const id of ids) {
    if (corrections[id]?.exclude) {
      continue;
    }
    const user = github(`user/${id}`);
    assert.equal(accountId(user), id, "GitHub returned a different account ID.");
    if (user.type === "Bot") {
      continue;
    }
    assert.ok(
      user.type === "User" &&
        typeof user.login === "string" &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login),
      `Account ${id} is not a resolved human GitHub account; add an explicit exclusion if appropriate.`,
    );
    people.push({ id, login: user.login, display: corrections[id]?.displayName ?? user.login });
  }
  assert.ok(people.length > 0, "No human contributors found; refusing to empty the README wall.");
  people.sort((left, right) => {
    const a = left.login.toLowerCase();
    const b = right.login.toLowerCase();
    if (a === b) {
      return Number(left.id) - Number(right.id);
    }
    return a < b ? -1 : 1;
  });
  const rows = [];
  for (let index = 0; index < people.length; index += 10) {
    rows.push(
      people
        .slice(index, index + 10)
        .map(({ id, login, display }) => {
          return `<a href="https://github.com/${login}"><img src="https://avatars.githubusercontent.com/u/${id}?s=48&amp;v=4" width="48" height="48" alt="${escapeAttribute(display)}"></a>`;
        })
        .join(" "),
    );
  }
  assert.equal(
    github(branchEndpoint).sha,
    baseline,
    "Default branch changed during collection; retry.",
  );
  assert.equal(
    readFileSync(readmePath, "utf8"),
    readme,
    "README changed during collection; retry.",
  );
  const next = `${readme.slice(0, start)}\n\n${rows.join("\n")}\n\n${readme.slice(end)}`;
  if (next !== readme) {
    writeFileSync(readmePath, next);
  }
  console.log(
    `${next === readme ? "Unchanged" : "Updated"}: ${people.length} contributors from ${repository}.`,
  );
  console.log(`Default branch: ${metadata.default_branch} at ${baseline}`);
  console.log("Review the README diff and submit it through the normal PR process.");
}

try {
  updateContributors();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
