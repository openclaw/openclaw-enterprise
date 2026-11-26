import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { readStableDescriptor } from "./stable-file-descriptor.ts";

type ProtectedFileRead = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false };

// Success transfers the returned bytes to the caller for disposal. Failure
// carries no filesystem details or partially read material.
export async function readProtectedFile(
  path: string,
  maximum: number,
  privateFile = true,
): Promise<ProtectedFileRead> {
  try {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error("invalid-protected-file");
    }
    const uid = process.getuid?.();
    const immediateParent = dirname(path);
    const ancestors: string[] = [];
    let parent = immediateParent;
    for (;;) {
      ancestors.push(parent);
      if (parent === parse(parent).root) {
        break;
      }
      parent = dirname(parent);
    }
    // Validate from the root so each trusted prefix protects the next component
    // against replacement by another user. Root-owned sticky ancestors permit
    // private directories beneath /tmp; the immediate parent must stay unwritable.
    for (const ancestor of ancestors.reverse()) {
      const stat = await lstat(ancestor);
      const rootStickyAncestor =
        ancestor !== immediateParent && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !rootStickyAncestor)
      ) {
        throw new Error("invalid-protected-file");
      }
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const bytes = await readStableDescriptor(handle, maximum, {
      statName: () => lstat(path),
      uid,
      privateFile,
    });
    return { ok: true, bytes };
  } catch {
    return { ok: false };
  }
}
