import { createServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { aborted } from "node:util";
import type { ProtectedGitHubInstallationMaterial } from "@openclaw-enterprise/contracts";
import {
  jointGitTrust,
  type AssertedPod,
  type JointGitIssuerTrust,
} from "./openshell-joint-git-trust.ts";

export type { JointGitIssuerTrust } from "./openshell-joint-git-trust.ts";

interface Permit extends AssertedPod {
  readonly host: "github.com" | "api.github.com";
  readonly requestId: string;
  readonly until: number;
  readonly lifetime: AbortSignal;
  readonly read: (signal: AbortSignal) => Promise<ProtectedGitHubInstallationMaterial | undefined>;
  /** The current grant, protected plan, same session, signer, execution, Pod and material receipt. */
  readonly current: (signal: AbortSignal) => Promise<boolean>;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const denied = () => new Error("Git token grant refused.");

/** A permit belongs only to the worker that authenticated the signed request. Never reopen a claim. */
export class OpenShellJointGitIssuer {
  private readonly permits = new Map<string, { permit: Permit; spent: boolean }>();
  private readonly stopped = new AbortController();
  private readonly endpoint: URL;
  private readonly trust: JointGitIssuerTrust;
  private authenticate?: Awaited<ReturnType<typeof jointGitTrust>>;
  constructor(endpoint: string, trust: JointGitIssuerTrust) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.href !== endpoint ||
      this.endpoint.pathname !== "/token/git" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw denied();
    }
    this.trust = trust;
  }

  permit(permit: Permit): boolean {
    const now = Date.now();
    for (const [id, current] of this.permits) {
      if (current.permit.until <= now) {
        this.permits.delete(id);
      }
    }
    if (
      !this.authenticate ||
      this.stopped.signal.aborted ||
      permit.lifetime.aborted ||
      !uuid.test(permit.requestId) ||
      !uuid.test(permit.podUid) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(permit.sandboxId) ||
      !(permit.host === "github.com" || permit.host === "api.github.com") ||
      !Number.isFinite(permit.until) ||
      permit.until <= now ||
      permit.until > now + 30_000 ||
      this.permits.size >= 1024 ||
      this.permits.has(permit.requestId)
    ) {
      return false;
    }
    this.permits.set(permit.requestId, { permit, spent: false });
    return true;
  }

  private async handle(q: IncomingMessage, res: ServerResponse) {
    const done = new AbortController();
    const stop = () => done.abort();
    q.once("aborted", stop);
    res.once("close", stop);
    res.setHeader("cache-control", "no-store");
    res.setHeader("pragma", "no-cache");
    res.setHeader("content-type", "application/json");
    try {
      const id = q.headers["x-openshell-request-id"];
      if (
        q.method !== "POST" ||
        q.url !== this.endpoint.pathname ||
        q.headers.host !== this.endpoint.host ||
        typeof id !== "string" ||
        !uuid.test(id) ||
        q.headers["content-type"] !== "application/x-www-form-urlencoded" ||
        q.headers["content-encoding"]
      ) {
        throw denied();
      }
      const entry = this.permits.get(id);
      if (!entry || entry.spent || entry.permit.until <= Date.now()) {
        throw denied();
      }
      const { permit } = entry;
      const signal = AbortSignal.any([
        done.signal,
        permit.lifetime,
        this.stopped.signal,
        AbortSignal.timeout(3000),
      ]);
      // Release HTTP resources even when a caller stalls or a dependency ignores cancellation.
      const cancelled = aborted(signal, q).then(() => {
        throw denied();
      });
      await Promise.race([
        cancelled,
        (async () => {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const part of q) {
            signal.throwIfAborted();
            const bytes = Buffer.from(part);
            size += bytes.length;
            if (size > 16384) {
              throw denied();
            }
            parts.push(bytes);
          }
          const form = new URLSearchParams(Buffer.concat(parts).toString("utf8"));
          const assertion = form.get("client_assertion");
          if (
            form.size !== 4 ||
            !assertion ||
            form.get("client_assertion_type") !==
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
            form.get("grant_type") !== "client_credentials" ||
            form.get("audience") !== "https://" + permit.host
          ) {
            throw denied();
          }
          const authenticate = this.authenticate;
          if (!authenticate) {
            throw denied();
          }
          const trusted = await authenticate(assertion, permit, signal);
          if (
            !trusted() ||
            !(await permit.current(signal)) ||
            !trusted() ||
            entry.spent ||
            this.permits.get(id) !== entry ||
            Date.now() >= permit.until ||
            signal.aborted
          ) {
            throw denied();
          }
          entry.spent = true;
          const material = await permit.read(signal);
          if (!material || !material.value || /[\r\n]/.test(material.value) || signal.aborted) {
            throw denied();
          }
          const reauthenticated = await authenticate(assertion, permit, signal);
          if (!(await permit.current(signal))) {
            throw denied();
          }
          // The permit lifetime includes the worker's observed Pod. Check it after the
          // final receipt await and do not yield between this guard and the response.
          const until = Math.min(Date.parse(material.expiresAt), permit.until);
          if (
            !trusted() ||
            !reauthenticated() ||
            !Number.isFinite(until) ||
            until <= Date.now() ||
            signal.aborted
          ) {
            throw denied();
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              access_token:
                permit.host === "github.com"
                  ? Buffer.from("x-access-token:" + material.value).toString("base64")
                  : material.value,
              token_type: "Bearer",
              expires_in: Math.floor((until - Date.now()) / 1000),
            }),
          );
        })(),
      ]);
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(403);
        res.end('{"error":"access_denied"}');
      }
    } finally {
      done.abort();
    }
  }

  async listen(host: string, tls: ServerOptions) {
    if (!tls.key || !tls.cert || this.authenticate || this.stopped.signal.aborted) {
      throw denied();
    }
    this.authenticate = await jointGitTrust(this.endpoint.href, this.trust);
    const server = createServer(
      { ...tls, requestTimeout: 3000, headersTimeout: 3000, maxHeaderSize: 8192 },
      (q, r) => {
        void this.handle(q, r);
      },
    );
    server.once("close", () => {
      this.stopped.abort();
      this.permits.clear();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(this.endpoint.port || 443), host, resolve);
    });
    return server;
  }
}
