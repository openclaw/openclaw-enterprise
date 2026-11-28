import { createHash, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { SshBrowserTransport } from "./browser-route.ts";

// Controller-local, installed atomically by the trusted listener supervisor.
// No paths, ports, certificates or credentials are taken from the browser.
export function manifestBrowserTransport(
  directory = "/run/occ-browser",
  owner = 0,
): SshBrowserTransport {
  return async (target, signal) => {
    signal.throwIfAborted();
    const name = createHash("sha256")
      .update(
        JSON.stringify([
          target.installationId,
          target.namespaceId,
          target.agentId,
          target.revisionId,
        ]),
      )
      .digest("hex");
    try {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0)
        return undefined;
      const file = await open(
        join(directory, name + ".json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== owner ||
          (stat.mode & 0o027) !== 0 ||
          stat.size > 16384 ||
          stat.size < 1
        )
          return undefined;
        const buffer = Buffer.alloc(16385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) return undefined;
        const data = JSON.parse(buffer.toString("utf8", 0, bytesRead));
        if (
          !data ||
          data.installationId !== target.installationId ||
          data.namespaceId !== target.namespaceId ||
          data.agentId !== target.agentId ||
          data.revisionId !== target.revisionId ||
          data.port !== target.port ||
          !Number.isSafeInteger(data.localTlsPort) ||
          data.localTlsPort < 1024 ||
          data.localTlsPort > 65535 ||
          typeof data.credential !== "string" ||
          !/^[0-9a-f]{64}$/.test(data.credential) ||
          typeof data.revisionCertificate !== "string"
        )
          return undefined;
        const cert = new X509Certificate(data.revisionCertificate);
        return {
          ...target,
          localTlsPort: data.localTlsPort,
          revisionCertificate: cert.toString(),
          credential: data.credential,
        };
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    } finally {
      signal.throwIfAborted();
    }
  };
}
