import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createSecureServer, type ServerHttp2Stream } from "node:http2";
import {
  createServer as createHttpsServer,
  get as httpsGet,
  type Server,
  type ServerOptions,
} from "node:https";
import type { RequestListener } from "node:http";
import { join } from "node:path";
import { type PeerCertificate, TLSSocket } from "node:tls";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { boundPort, grpc } from "./openshell-gateway-wire-fixture.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClientOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const selfSignedCertificate = (directory: string, name: string, subjectAltName: string) =>
  selfSigned(directory, { name, commonName: "openshell-gateway", subjectAltName });

// A TLS gRPC listener that answers Health and records the SNI of every connection
// and the path of every request it receives.
type TlsHealthObservation = ["sni", string | false | null] | ["request", string | undefined];

async function tlsHealthGateway(
  keyPath: string,
  certPath: string,
  bind: string,
  seen: TlsHealthObservation[],
) {
  const gateway = createSecureServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  });
  gateway.on("secureConnection", (socket: TLSSocket) => seen.push(["sni", socket.servername]));
  gateway.on("stream", (stream: ServerHttp2Stream, headers) => {
    seen.push(["request", headers[":path"]]);
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    // HealthResponse { status: SERVICE_STATUS_HEALTHY } in one uncompressed gRPC frame.
    stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, 0x01]));
  });
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, bind, resolve);
  });
  return gateway;
}

// Exercise the real grpc-js connector with signed client certificates. This proves
// transport identity and isolation, not the supplier's application authorization.
function signedClientCertificate(
  directory: string,
  name: string,
  ca: { certPath: string; keyPath: string },
) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const csrPath = join(directory, `${name}.csr`);
  for (const args of [
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      "/CN=openshell-client/OU=openshell-user",
    ],
    [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      ca.certPath,
      "-CAkey",
      ca.keyPath,
      "-set_serial",
      "2",
      "-days",
      "1",
      "-out",
      certPath,
    ],
  ]) {
    const generated = spawnSync("openssl", args, { encoding: "utf8" });
    assert.equal(
      generated.status,
      0,
      generated.stderr || generated.error?.message || "openssl failed",
    );
  }
  return { mode: "mtls" as const, certificatePath: certPath, privateKeyPath: keyPath };
}

export async function mutualTls(t: TestContext) {
  const directory = await temporaryDirectory(t, "openshell-mtls-");
  const identity = await selfSignedCertificate(directory, "server", "DNS:localhost,IP:127.0.0.1");
  const authority = await selfSignedCertificate(directory, "client-ca", "DNS:client-ca.invalid");
  const auth = signedClientCertificate(directory, "client", authority);
  const tls = {
    key: readFileSync(identity.keyPath),
    cert: readFileSync(identity.certPath),
    ca: readFileSync(authority.certPath),
  };
  return { tls, auth, rootCertificatePath: identity.certPath, directory };
}

export function registerTlsCases(): void {
  test("OpenShell client verifies a TLS gateway at an IP endpoint against that IP and sends no SNI", async (t) => {
    const { SandboxGatewayUnavailableError } = await import("../../packages/occ/src/index.ts");
    const directory = await temporaryDirectory(t, "openshell-grpc-tls-");
    // IPv6 loopback is optional on CI hosts; without it the IPv6 cases are skipped.
    // The probe only binds, so it needs no certificate.
    const probe = createSecureServer();
    const ipv6 = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    const health: TlsHealthObservation = ["request", "/openshell.v1.OpenShell/Health"];
    const cases = [
      // A DNS endpoint is sent as SNI and verified by name, as before.
      { name: "dns", san: "DNS:localhost", bind: "localhost", host: "localhost", sni: "localhost" },
      // TLS forbids an IP in SNI: the certificate must carry the endpoint IP itself.
      { name: "ipv4", san: "IP:127.0.0.1", bind: "127.0.0.1", host: "127.0.0.1", sni: false },
      { name: "ipv6", san: "IP:::1", bind: "::1", host: "[::1]", sni: false, needsIpv6: true },
      // A hex IPv6 literal (IPv4-mapped, so it reaches the IPv4 loopback listener).
      {
        name: "ipv6-hex",
        san: "IP:::ffff:7f00:1",
        bind: "127.0.0.1",
        host: "[::ffff:7f00:1]",
        sni: false,
        needsIpv6: true,
      },
      // A gateway certificate the client's CA does not vouch for: a configuration error, not an
      // outage, so it fails within the attempt budget (finding 2042). The dual-stack listener takes
      // every address localhost resolves to, so no refused address hides the certificate error
      // (grpc-js reports only the last address's error).
      {
        name: "untrusted-dns",
        san: "DNS:localhost",
        bind: "::",
        host: "localhost",
        untrusted: true,
        needsIpv6: true,
      },
      { name: "wrong-ip", san: "IP:127.0.0.2", bind: "127.0.0.1", host: "127.0.0.1" },
      // A name certificate does not vouch for an IP endpoint, even one that resolves there.
      { name: "name-for-ip", san: "DNS:localhost", bind: "127.0.0.1", host: "127.0.0.1" },
    ];
    // A gateway that answers through a certificate the client does not trust never answered it, but
    // waiting cannot fix that: it is an ordinary failed request, not a Sandbox gateway outage.
    const untrusted = (error: unknown) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
      assert.equal(asRecord(error)?.grpcStatus, grpc.status.UNAVAILABLE);
      return true;
    };
    const otherAuthority = await selfSignedCertificate(
      directory,
      "other-authority",
      "DNS:localhost",
    );
    for (const { name, san, bind, host, sni, needsIpv6, untrusted: distrusted } of cases) {
      await t.test(
        name,
        { skip: needsIpv6 && !ipv6 && "IPv6 loopback ::1 is unavailable" },
        async (t) => {
          const { keyPath, certPath } = await selfSignedCertificate(directory, name, san);
          const seen: TlsHealthObservation[] = [];
          const gateway = await tlsHealthGateway(keyPath, certPath, bind, seen);
          t.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));
          const client = new GrpcOpenShellGatewayClient({
            endpoint: `https://${host}:${boundPort(gateway)}`,
            rootCertificatePath: distrusted ? otherAuthority.certPath : certPath,
            requestTimeoutMs: 5_000,
          });
          t.after(() => client.close());
          const signal = AbortSignal.timeout(10_000);
          if (sni !== undefined) {
            await client.health(signal);
            assert.deepEqual(seen, [["sni", sni], health]);
            return;
          }
          await assert.rejects(client.health(signal), untrusted);
          assert.deepEqual(
            seen.filter(([kind]) => kind === "request"),
            [],
            "an unverified listener never receives a request",
          );
        },
      );
    }
    // Clients of one IP endpoint never share a verified connection: a client that does not
    // trust the gateway's certificate still fails while a trusting client is connected.
    await t.test("untrusted-beside-trusted", async (t) => {
      const { keyPath, certPath } = await selfSignedCertificate(
        directory,
        "shared",
        "IP:127.0.0.1",
      );
      const other = await selfSignedCertificate(directory, "other", "IP:127.0.0.1");
      const seen: TlsHealthObservation[] = [];
      const gateway = await tlsHealthGateway(keyPath, certPath, "127.0.0.1", seen);
      t.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));
      const endpoint = `https://127.0.0.1:${boundPort(gateway)}`;
      const client = (rootCertificatePath: string) => {
        const created = new GrpcOpenShellGatewayClient({
          endpoint,
          rootCertificatePath,
          requestTimeoutMs: 5_000,
        });
        t.after(() => created.close());
        return created;
      };
      await client(certPath).health(AbortSignal.timeout(10_000));
      await assert.rejects(client(other.certPath).health(AbortSignal.timeout(10_000)), untrusted);
      assert.deepEqual(
        seen.filter(([kind]) => kind === "request"),
        [health],
        "an untrusting client never reaches the gateway over the trusting client's connection",
      );
    });
  });

  test("OpenShell mTLS authenticates DNS and IP channels and refuses missing or foreign identities", async (t) => {
    const { SandboxGatewayUnavailableError } = await import("../../packages/occ/src/index.ts");
    const { tls, auth, rootCertificatePath, directory } = await mutualTls(t);
    const foreignCA = await selfSignedCertificate(directory, "foreign-ca", "DNS:foreign.invalid");
    const foreign = signedClientCertificate(directory, "foreign", foreignCA);
    const seen: {
      authorized: boolean;
      subject: PeerCertificate["subject"] | undefined;
      sni: string | false | null;
      authorization: string | undefined;
    }[] = [];
    const server = createSecureServer({
      ...tls,
      requestCert: true,
      rejectUnauthorized: true,
    });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      const tlsSocket = stream.session?.socket;
      assert.ok(tlsSocket instanceof TLSSocket);
      seen.push({
        authorized: tlsSocket.authorized,
        subject: tlsSocket.getPeerCertificate().subject,
        sni: tlsSocket.servername,
        authorization: headers.authorization,
      });
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, 0x01]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    for (const host of ["localhost", "127.0.0.1"]) {
      await t.test(host, async (t) => {
        const makeClient = (
          clientAuth: OpenShellGatewayClientOptions["auth"],
          trustedServer = rootCertificatePath,
        ) => {
          const client = new GrpcOpenShellGatewayClient({
            endpoint: `https://${host}:${boundPort(server)}`,
            rootCertificatePath: trustedServer,
            ...(clientAuth === undefined ? {} : { auth: clientAuth }),
            requestTimeoutMs: 1_000,
          });
          t.after(() => client.close());
          return client;
        };
        await makeClient(auth).health(AbortSignal.timeout(5_000));
        const observation = seen.at(-1);
        assert.ok(observation?.subject);
        assert.equal(observation.authorized, true);
        assert.equal(observation.subject.CN, "openshell-client");
        assert.equal(observation.subject.OU, "openshell-user");
        assert.equal(observation.sni, host === "localhost" ? "localhost" : false);
        assert.equal(observation.authorization, undefined);
        const count = seen.length;
        // None may reuse the authenticated channel of the successful client.
        for (const rejected of [
          makeClient(undefined),
          makeClient(foreign),
          makeClient(auth, foreignCA.certPath),
        ]) {
          await assert.rejects(rejected.health(AbortSignal.timeout(5_000)), (error) => {
            assert.ok(error instanceof DependencyUnavailableError, String(error));
            // A refused identity is never a Sandbox gateway outage: waiting cannot fix it (owner
            // rule: retry network failures and timeouts, never an authentication failure). The IP
            // channel proves it. localhost can also resolve to ::1, where nothing listens here,
            // and grpc-js reports only the last address's error, which can be that refused connect.
            if (host === "127.0.0.1") {
              assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
            }
            return true;
          });
        }
        assert.equal(seen.length, count, "unverified peers never reach an RPC");
        await assert.rejects(
          makeClient({ ...auth, privateKeyPath: join(directory, "missing.key") }).health(
            AbortSignal.timeout(5_000),
          ),
          { code: "ENOENT" },
        );
      });
    }
    assert.throws(
      () => new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1", auth }),
      /mTLS requires an HTTPS/,
    );
    assert.throws(
      () =>
        new GrpcOpenShellGatewayClient({
          endpoint: "https://127.0.0.1:1",
          auth: { ...auth, certificatePath: "relative.crt" },
        }),
      /paths must be absolute/,
    );
  });

  test("OpenShell service transport never sends the administrator mTLS identity", async (t) => {
    const { tls, auth, rootCertificatePath } = await mutualTls(t);
    const listen = async (options: ServerOptions, handler: RequestListener) => {
      const server = createHttpsServer({ ...tls, ...options }, handler);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      return server;
    };
    const serviceDocument = (server: Server) => {
      const client = new GrpcOpenShellGatewayClient({
        endpoint: `https://127.0.0.1:${boundPort(server)}`,
        rootCertificatePath,
        auth,
      });
      t.after(() => client.close());
      return client.getServiceDocument(
        "https://harness.example.invalid",
        "/status",
        "scoped-service-token",
        AbortSignal.timeout(5_000),
      );
    };

    // First prove that this listener requests and accepts the administrator certificate.
    const peers: (string | string[] | undefined)[] = [];
    const strict = await listen(
      { requestCert: true, rejectUnauthorized: true },
      (request, response) => {
        assert.ok(request.socket instanceof TLSSocket);
        peers.push(request.socket.getPeerCertificate().subject?.CN);
        response.writeHead(204).end();
      },
    );
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpsGet(
        {
          host: "127.0.0.1",
          port: boundPort(strict),
          ca: tls.cert,
          cert: readFileSync(auth.certificatePath),
          key: readFileSync(auth.privateKeyPath),
          agent: false,
          signal: AbortSignal.timeout(5_000),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
    });
    assert.equal(status, 204);
    assert.deepEqual(peers, ["openshell-client"]);

    // On the service path the same listener must see a missing certificate, not just
    // an arbitrary connection failure. Sending the administrator identity would succeed.
    const tlsError: (
      server: Server,
      event: "tlsClientError",
      options: { signal: AbortSignal },
    ) => Promise<readonly unknown[]> = once;
    const rejected = tlsError(strict, "tlsClientError", { signal: AbortSignal.timeout(5_000) });
    const [[error]] = await Promise.all([
      rejected,
      assert.rejects(serviceDocument(strict), DependencyUnavailableError),
    ]);
    assert.equal(asRecord(error)?.code, "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE");
    assert.equal(peers.length, 1, "the service request never reached an authenticated socket");

    const requests: (string | string[] | undefined)[] = [];
    const service = await listen({}, (request, response) => {
      requests.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" }).end('{"ready":true}');
    });
    assert.deepEqual(await serviceDocument(service), { status: 200, json: { ready: true } });
    assert.deepEqual(requests, ["Bearer scoped-service-token"]);
  });
}
