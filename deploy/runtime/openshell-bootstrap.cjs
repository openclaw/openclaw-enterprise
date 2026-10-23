"use strict";

const fs = require("node:fs");
const path = require("node:path");

function absolutePath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value === "/" ||
    value.includes("\0") ||
    path.normalize(value) !== value
  ) {
    throw new Error("OpenShell bootstrap requires normalized absolute paths.");
  }
  return value;
}

// Bootstrap runs before the Harness, after the previous writer has stopped.
// Refuse retained symlink ancestors rather than following them during mkdir/chmod.
function directory(value, create) {
  let current = "/";
  for (const part of absolutePath(value).slice(1).split("/")) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined && create) {
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (!stat?.isDirectory()) {
      throw new Error("OpenShell bootstrap requires directory ancestors: " + current);
    }
  }
}

function privateDirectory(value) {
  directory(value, true);
  if (fs.lstatSync(value).uid !== process.getuid()) {
    throw new Error("OpenShell bootstrap requires a process-owned directory: " + value);
  }
  fs.chmodSync(value, 0o700);
}

/**
 * Establish the Harness home and links to retained data before its loader runs.
 * Inputs describe in-container paths; the image has no Kubernetes/PVC knowledge.
 * Exact state-directory environment paths remain real directories, not links.
 */
function prepare({ home, links, native }) {
  absolutePath(home);
  if (!Array.isArray(links) || typeof native !== "boolean") {
    throw new Error("Invalid OpenShell filesystem bootstrap configuration.");
  }
  const names = new Set();
  for (const link of links) {
    absolutePath(link.path);
    absolutePath(link.target);
    if (
      !link.path.startsWith(home + "/") ||
      link.target === home ||
      link.target.startsWith(home + "/") ||
      names.has(link.path)
    ) {
      throw new Error("OpenShell bootstrap links must connect home paths to retained data.");
    }
    names.add(link.path);
    directory(link.target, false);
  }
  privateDirectory(home);
  for (const link of links) {
    privateDirectory(path.dirname(link.path));
    const existing = fs.lstatSync(link.path, { throwIfNoEntry: false });
    if (existing !== undefined) {
      if (!existing.isSymbolicLink() || fs.readlinkSync(link.path) !== link.target) {
        throw new Error(
          "OpenShell workspace link conflicts with existing runtime state: " + link.path,
        );
      }
    } else {
      fs.symlinkSync(link.target, link.path);
    }
  }
  if (native) {
    const temporary = path.join(home, "tmp");
    privateDirectory(temporary);
    process.env.TMPDIR = temporary;
  }
}

function isRevisionTarget(target, parent) {
  return path.dirname(target) === parent && /^[a-f0-9]{16}$/.test(path.basename(target));
}

function prepareManaged({ root, revision, directories, links, native }) {
  absolutePath(root);
  if (!/^[a-f0-9]{16}$/.test(revision) || !Array.isArray(directories)) {
    throw new Error("Invalid managed OpenShell filesystem layout.");
  }
  const data = path.join(root, "oce");
  // TODO(managed-workload-retention): prune retired homes after the RFC defines
  // rollback and credential-retention rules. Agent deletion currently removes them.
  const runtime = path.join(data, "revisions", revision);
  const home = path.join(runtime, "home");
  const alias = path.join(root, ".openclaw-runtime");
  directory(root, false);
  privateDirectory(data);
  privateDirectory(path.join(data, "revisions"));
  privateDirectory(runtime);
  for (const relative of directories) {
    if (typeof relative !== "string" || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(relative)) {
      throw new Error("Invalid retained OpenShell directory.");
    }
    privateDirectory(path.join(data, relative));
  }
  prepare({
    home,
    native,
    links: links.map(({ path: relative, target }) => {
      if (
        typeof relative !== "string" ||
        path.isAbsolute(relative) ||
        relative.split("/").some((part) => part === ".." || part === "." || part === "") ||
        !directories.includes(target)
      ) {
        throw new Error("Invalid retained OpenShell link.");
      }
      return { path: path.join(home, relative), target: path.join(data, target) };
    }),
  });
  const existing = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (
    existing !== undefined &&
    (!existing.isSymbolicLink() ||
      !isRevisionTarget(fs.readlinkSync(alias), path.join(data, "revisions")))
  ) {
    throw new Error("OpenShell runtime selector conflicts with retained state.");
  }
  const temporary = alias + "." + require("node:crypto").randomUUID();
  fs.symlinkSync(runtime, temporary);
  try {
    fs.renameSync(temporary, alias);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { prepareManaged };
