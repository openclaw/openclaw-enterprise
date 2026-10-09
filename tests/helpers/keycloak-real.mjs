import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Keycloak's own release, pinned by its multi-platform index digest. */
export const defaultKeycloakImage =
  "quay.io/keycloak/keycloak:26.4.7@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007";

export const keycloakRealm = "oce";
export const keycloakServiceClient = "occ-tools";
export const keycloakUserClient = "occ-tools-user";
const keycloakUser = "tools-user";

/**
 * Issues a private CA and a serving certificate for the issuer's in-cluster DNS name. The CA
 * is the only trust anchor for the issuer, so a client that reaches it has been configured to
 * trust a private CA rather than falling back to public roots.
 */
export async function issueServingCertificate(directory, host) {
  const path = (name) => join(directory, name);
  await writeFile(
    path("server.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${host}`,
      "",
    ].join("\n"),
  );
  await executeFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.crt"),
    "-days",
    "2",
    "-subj",
    "/CN=OCE disposable issuer CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await executeFile("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("tls.key"),
    "-out",
    path("tls.csr"),
    "-subj",
    `/CN=${host}`,
  ]);
  await executeFile("openssl", [
    "x509",
    "-req",
    "-in",
    path("tls.csr"),
    "-CA",
    path("ca.crt"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-out",
    path("tls.crt"),
    "-days",
    "2",
    "-extfile",
    path("server.ext"),
  ]);
  return { caPem: await readFile(path("ca.crt"), "utf8") };
}

export function realmDocument({ clientSecret, password, accessTokenLifespan }) {
  return {
    realm: keycloakRealm,
    enabled: true,
    accessTokenLifespan,
    ssoSessionIdleTimeout: 3600,
    clients: [
      {
        // A confidential service client for the client-credentials source.
        clientId: keycloakServiceClient,
        enabled: true,
        protocol: "openid-connect",
        publicClient: false,
        secret: clientSecret,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
      },
      {
        // A public client whose user sign-in stands in for the completed authorization that
        // supplies a refresh-token source.
        clientId: keycloakUserClient,
        enabled: true,
        protocol: "openid-connect",
        publicClient: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
      },
    ],
    users: [
      {
        username: keycloakUser,
        enabled: true,
        email: "tools-user@example.test",
        emailVerified: true,
        firstName: "Tools",
        lastName: "User",
        credentials: [{ type: "password", value: password, temporary: false }],
      },
    ],
  };
}

/**
 * Starts a disposable Keycloak that serves HTTPS with a private CA on its cluster DNS name.
 * The host reaches it through a port-forward with the same TLS name and trust, and a fixed
 * hostname keeps every token's issuer identical however Keycloak is reached.
 */
export async function startKeycloak({
  context,
  kubectl,
  waitFor,
  startPortForwardTarget,
  image = defaultKeycloakImage,
  accessTokenLifespan = 360,
}) {
  const namespace = `oce-keycloak-${randomUUID().slice(0, 8)}`;
  const host = `keycloak.${namespace}.svc.cluster.local`;
  const port = 8443;
  const issuer = `https://${host}:${port}/realms/${keycloakRealm}`;
  const clientSecret = randomBytes(24).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  const adminPassword = randomBytes(24).toString("base64url");
  const directory = await mkdtemp(join(tmpdir(), "oce-keycloak-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await kubectl("create", "namespace", namespace);
  context.after(() =>
    kubectl("delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"),
  );
  const { caPem } = await issueServingCertificate(directory, host);
  await kubectl(
    "create",
    "secret",
    "tls",
    "keycloak-tls",
    "--namespace",
    namespace,
    `--cert=${join(directory, "tls.crt")}`,
    `--key=${join(directory, "tls.key")}`,
  );
  const manifest = join(directory, "keycloak.json");
  await writeFile(
    manifest,
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "keycloak-bootstrap", namespace },
          stringData: {
            "realm.json": JSON.stringify(
              realmDocument({ clientSecret, password, accessTokenLifespan }),
            ),
            "admin-password": adminPassword,
          },
        },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "keycloak", namespace },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: "keycloak" } },
            template: {
              metadata: { labels: { app: "keycloak" } },
              spec: {
                containers: [
                  {
                    name: "keycloak",
                    image,
                    imagePullPolicy: "IfNotPresent",
                    args: [
                      "start-dev",
                      "--import-realm",
                      "--http-enabled=false",
                      `--https-port=${port}`,
                      "--https-certificate-file=/etc/keycloak-tls/tls.crt",
                      "--https-certificate-key-file=/etc/keycloak-tls/tls.key",
                      `--hostname=https://${host}:${port}`,
                    ],
                    env: [
                      { name: "KC_BOOTSTRAP_ADMIN_USERNAME", value: "admin" },
                      {
                        name: "KC_BOOTSTRAP_ADMIN_PASSWORD",
                        valueFrom: {
                          secretKeyRef: { name: "keycloak-bootstrap", key: "admin-password" },
                        },
                      },
                    ],
                    ports: [{ containerPort: port }],
                    volumeMounts: [
                      { name: "tls", mountPath: "/etc/keycloak-tls", readOnly: true },
                      {
                        name: "realm",
                        mountPath: "/opt/keycloak/data/import/realm.json",
                        subPath: "realm.json",
                        readOnly: true,
                      },
                    ],
                  },
                ],
                volumes: [
                  { name: "tls", secret: { secretName: "keycloak-tls" } },
                  {
                    name: "realm",
                    secret: {
                      secretName: "keycloak-bootstrap",
                      items: [{ key: "realm.json", path: "realm.json" }],
                    },
                  },
                ],
              },
            },
          },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "keycloak", namespace },
          spec: {
            selector: { app: "keycloak" },
            ports: [{ name: "https", port, targetPort: port }],
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  await kubectl("apply", "-f", manifest);

  let forward;
  const ensureForward = async () => {
    forward ??= await startPortForwardTarget(namespace, "service/keycloak", `0:${port}`);
    return forward;
  };
  context.after(() => forward?.stop());

  /** One HTTPS request that verifies the private CA and the issuer's DNS name. */
  const call = async (method, path, { form, json, bearer } = {}) => {
    const target = new URL((await ensureForward()).url);
    const body =
      form === undefined
        ? json === undefined
          ? undefined
          : JSON.stringify(json)
        : new URLSearchParams(form).toString();
    return await new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          host: "127.0.0.1",
          port: target.port,
          servername: host,
          ca: caPem,
          method,
          path,
          headers: {
            ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
            ...(json === undefined ? {} : { "content-type": "application/json" }),
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          timeout: 20_000,
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            let parsed;
            try {
              parsed = text.length === 0 ? undefined : JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({ status: response.statusCode, body: parsed });
          });
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error(`${method} ${path} timed out`)));
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
  const tokenPath = (realm) => `/realms/${realm}/protocol/openid-connect/token`;

  // Keycloak imports the realm during startup; discovery answers only once it is serving.
  await waitFor(
    "Keycloak to serve the test realm over its private CA",
    async () => {
      try {
        const discovery = await call(
          "GET",
          `/realms/${keycloakRealm}/.well-known/openid-configuration`,
        );
        return discovery.status === 200 && discovery.body?.issuer === issuer ? true : undefined;
      } catch {
        // The Pod or its port-forward may not be ready yet; restart the forward next time.
        await forward?.stop().catch(() => undefined);
        forward = undefined;
        return undefined;
      }
    },
    300_000,
  );
  const certs = await call("GET", `/realms/${keycloakRealm}/protocol/openid-connect/certs`);
  if (certs.status !== 200 || !Array.isArray(certs.body?.keys)) {
    throw new Error(`Keycloak returned no signing keys (HTTP ${certs.status}).`);
  }

  const adminToken = async () => {
    const response = await call("POST", tokenPath("master"), {
      form: {
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: adminPassword,
      },
    });
    if (response.status !== 200) {
      throw new Error(`Keycloak admin sign-in failed (HTTP ${response.status}).`);
    }
    return response.body.access_token;
  };

  return Object.freeze({
    namespace,
    host,
    port,
    issuer,
    caPem,
    tokenUrl: `https://${host}:${port}${tokenPath(keycloakRealm)}`,
    /** Public signing keys only; the echo service verifies tokens with them. */
    jwks: Object.freeze({ keys: certs.body.keys }),
    clientSecret,
    /** A completed user sign-in, whose refresh token seeds an oauth2-refresh-token source. */
    async signInRefreshToken() {
      const response = await call("POST", tokenPath(keycloakRealm), {
        form: {
          grant_type: "password",
          client_id: keycloakUserClient,
          username: keycloakUser,
          password,
        },
      });
      if (response.status !== 200 || typeof response.body?.refresh_token !== "string") {
        throw new Error(`Keycloak user sign-in failed (HTTP ${response.status}).`);
      }
      return response.body.refresh_token;
    },
    /** Ends every session of the test user, which invalidates its refresh tokens. */
    async signOutUser() {
      const bearer = await adminToken();
      const users = await call(
        "GET",
        `/admin/realms/${keycloakRealm}/users?exact=true&username=${keycloakUser}`,
        { bearer },
      );
      const id = users.body?.[0]?.id;
      if (users.status !== 200 || typeof id !== "string") {
        throw new Error(`Keycloak user lookup failed (HTTP ${users.status}).`);
      }
      const signedOut = await call("POST", `/admin/realms/${keycloakRealm}/users/${id}/logout`, {
        bearer,
      });
      if (signedOut.status !== 204) {
        throw new Error(`Keycloak user sign-out failed (HTTP ${signedOut.status}).`);
      }
    },
  });
}
