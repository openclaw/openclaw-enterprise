import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { readKeycloakImage } from "../../scripts/ci/keycloak.ts";
import {
  issueServingCertificate,
  keycloakRealm,
  keycloakUser,
  keycloakUserClient,
  realmDocument,
} from "./keycloak-issuer-material.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

/**
 * Keycloak's own release, pinned by digest in tests/fixtures/keycloak/image.json and shared
 * with the Keycloak sign-in lane. CI imports it into k3d before the test runs (prepare.mjs
 * sets OCC_TEST_KEYCLOAK_IMAGE), so the cluster never pulls it.
 */
export const defaultKeycloakImage = await readKeycloakImage();

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
  scopedClients = {},
}) {
  const namespace = `oce-keycloak-${randomUUID().slice(0, 8)}`;
  const host = `keycloak.${namespace}.svc.cluster.local`;
  const port = 8443;
  const issuer = `https://${host}:${port}/realms/${keycloakRealm}`;
  const clientSecret = randomBytes(24).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  const adminPassword = randomBytes(24).toString("base64url");
  const directory = await temporaryDirectory(context, "oce-keycloak-");
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
              realmDocument({ clientSecret, password, accessTokenLifespan, scopedClients }),
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
    /** A real signed token with the audience and scopes declared by the test realm. */
    async scopedClientToken(clientId) {
      if (!Object.hasOwn(scopedClients, clientId)) {
        throw new Error("The scoped client was not provisioned in the test realm.");
      }
      const response = await call("POST", tokenPath(keycloakRealm), {
        form: {
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        },
      });
      if (response.status !== 200 || typeof response.body?.access_token !== "string") {
        throw new Error(`Keycloak client sign-in failed (HTTP ${response.status}).`);
      }
      return response.body.access_token;
    },
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
