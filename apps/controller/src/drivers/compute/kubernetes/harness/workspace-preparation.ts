/**
 * Init script that makes each Harness claim subdirectory a process-owned 0700
 * directory. The 2026-09-28 release had no Harness init, so the kubelet created
 * `workspace` and `generated-images` for their subPath mounts: root-owned and
 * group- and world-writable, which uid 1000 cannot chmod (EPERM, finding 752).
 * The claim root is writable without a sticky bit, so such a directory is
 * renamed aside, recreated by uid 1000, and its entries are renamed back. Every
 * step is a rename on one filesystem, and a retried init resumes an interrupted
 * move. An entry already present in the new directory stays aside, and is logged.
 * A directory the tenant made read-only (chmod 0555) moves too (finding 884).
 * The move assumes no other Pod writes the claim (dedicated Harnesses with node
 * enrollment roll with Recreate).
 */
export function harnessWorkspacePreparationScript(paths: readonly string[]): string {
  return `{
  const fs = require("node:fs");
  const uid = process.getuid();
  const move = (from, to) => {
    // Moving a directory to a new parent needs write on the directory itself, so an owned
    // directory the tenant made read-only gets u+w for the rename and its mode back after
    // (an init stopped in between leaves it owner-writable).
    const stat = fs.lstatSync(from);
    const locked = stat.isDirectory() && stat.uid === uid && (stat.mode & 0o200) === 0;
    if (locked) fs.chmodSync(from, (stat.mode & 0o7777) | 0o200);
    try {
      fs.renameSync(from, to);
    } catch (error) {
      error.message += "; uid " + uid + " cannot move " + from + (stat.uid === uid
        ? " (owned by uid " + uid + "): make its parent directory writable by uid " + uid
        : " (owner uid " + stat.uid + "): chown it to uid " + uid) + " on the node";
      if (locked) {
        try {
          fs.chmodSync(from, stat.mode & 0o7777);
        } catch {}
      }
      throw error;
    }
    if (locked) fs.chmodSync(to, stat.mode & 0o7777);
  };
  for (const path of ${JSON.stringify(paths)}) {
    const aside = path.replace(/\\/([^/]+)$/u, "/.$1.kubelet-created");
    if (
      fs.lstatSync(aside, { throwIfNoEntry: false }) === undefined &&
      fs.lstatSync(path, { throwIfNoEntry: false })?.isDirectory()
    ) {
      try {
        fs.chmodSync(path, 0o700);
      } catch (error) {
        if (error.code !== "EPERM") throw error;
        move(path, aside);
      }
    }
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(aside, { throwIfNoEntry: false }) !== undefined) {
      const kept = [];
      for (const entry of fs.readdirSync(aside)) {
        if (fs.lstatSync(path + "/" + entry, { throwIfNoEntry: false }) === undefined) {
          move(aside + "/" + entry, path + "/" + entry);
        } else {
          kept.push(entry);
        }
      }
      if (kept.length === 0) {
        fs.rmdirSync(aside);
      } else {
        console.error("kept in " + aside + ", already in " + path + ": " +
          JSON.stringify(kept.slice(0, 20)) + (kept.length > 20 ? " and " + (kept.length - 20) + " more" : ""));
      }
    }
    fs.chmodSync(path, 0o700);
  }
}`;
}
