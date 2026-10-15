import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// The trusted host scans this bounded snapshot in memory and never prints it:
// the selected session bearer is legitimately present in these client files.
const surfaces = [];
let bytes = 0;
async function walk(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) {
      await walk(join(path, name));
    }
  } else if (stat.isFile()) {
    if (stat.size > 4 * 1024 * 1024 || (bytes += stat.size) > 16 * 1024 * 1024) {
      throw new Error("probe-size-limit");
    }
    surfaces.push(await readFile(path, "utf8"));
  }
}
for (const path of ["/session", "/workspace", "/tmp", "/app"]) {
  await walk(path);
}
// Writable runtime mounts outside the read-only root, where present. Entries the
// Agent user cannot read are not Agent surfaces.
for (const path of ["/dev/shm", "/run"]) {
  try {
    await walk(path);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES") {
      throw error;
    }
  }
}
for (const name of await readdir("/proc")) {
  if (!/^\d+$/.test(name)) {
    continue;
  }
  for (const file of ["environ", "cmdline"]) {
    try {
      surfaces.push(await readFile(`/proc/${name}/${file}`, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}
const forbidden = [
  "/inputs",
  "/state",
  "/run/repository-control",
  "/run/repository-credentials",
  "/var/run/docker.sock",
  "/source",
  "/session-parent",
  "/sessions",
  "/sibling",
  "/app/dist/repository-credentials.js",
  "/app/dist/composition",
  "/app/dist/backends",
  "/app/dist/drivers/repo/github/credentials/driver",
  "/app/dist/drivers/repo/github/credentials/driver.js",
  "/app/dist/drivers/repo/github/credentials/factory.js",
  "/app/dist/drivers/repo/github/credentials/material.js",
];
const present = [];
// The client shares only this pure validator with the service. Any other
// common-owner module, directory or symlink still fails the delivered boundary.
const commonDirectory = "/app/dist/drivers/repo/credentials";
if (!(await lstat(commonDirectory)).isDirectory()) {
  present.push(commonDirectory);
} else {
  for (const entry of await readdir(commonDirectory, { withFileTypes: true })) {
    if (entry.name !== "client-contracts.js" || !entry.isFile()) {
      present.push(join(commonDirectory, entry.name));
    }
  }
}
for (const path of forbidden) {
  try {
    await lstat(path);
    present.push(path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
process.stdout.write(JSON.stringify({ surfaces, present, bytes, environment: process.env }));
