import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export const keycloakRealm = "oce";
export const keycloakServiceClient = "occ-tools";
export const keycloakUserClient = "occ-tools-user";
export const keycloakUser = "tools-user";

type ServingCertificateOptions = {
  alternateHosts?: readonly string[];
  caName?: string;
};

/**
 * Issues a private CA and a serving certificate for the issuer's in-cluster DNS name. The CA
 * is the only trust anchor for the issuer, so a client that reaches it has been configured to
 * trust a private CA rather than falling back to public roots.
 */
export async function issueServingCertificate(
  directory: string,
  host: string,
  { alternateHosts = [], caName = "OCE disposable issuer CA" }: ServingCertificateOptions = {},
) {
  const path = (name: string) => join(directory, name);
  await writeFile(
    path("server.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${[host, ...alternateHosts].map((name) => `DNS:${name}`).join(",")}`,
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
    `/CN=${caName}`,
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

type RealmDocumentOptions = {
  clientSecret: string;
  password: string;
  accessTokenLifespan: number;
  scopedClients?: Readonly<Record<string, readonly string[]>>;
};

function serviceClient(clientId: string, secret: string) {
  return {
    clientId,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    secret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
  };
}

export function realmDocument({
  clientSecret,
  password,
  accessTokenLifespan,
  scopedClients = {},
}: RealmDocumentOptions) {
  const scopedServiceClients = Object.entries(scopedClients).map(([clientId, scopes]) => ({
    ...serviceClient(clientId, clientSecret),
    protocolMappers: [
      {
        name: "OpenShell audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        config: {
          "included.custom.audience": "openshell-cli",
          "access.token.claim": "true",
        },
      },
      {
        name: "OpenShell scopes",
        protocol: "openid-connect",
        protocolMapper: "oidc-hardcoded-claim-mapper",
        config: {
          "claim.name": "oce_scopes",
          "claim.value": JSON.stringify(scopes),
          "jsonType.label": "JSON",
          "access.token.claim": "true",
        },
      },
    ],
  }));
  // A confidential service client for the client-credentials source.
  const serviceCredentialsClient = serviceClient(keycloakServiceClient, clientSecret);
  // A public client whose user sign-in stands in for the completed authorization that
  // supplies a refresh-token source.
  const userClient = {
    clientId: keycloakUserClient,
    enabled: true,
    protocol: "openid-connect",
    publicClient: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: true,
  };
  type RealmClient =
    (typeof scopedServiceClients)[number] | typeof serviceCredentialsClient | typeof userClient;
  const clients: RealmClient[] = [...scopedServiceClients, serviceCredentialsClient, userClient];

  return {
    realm: keycloakRealm,
    enabled: true,
    accessTokenLifespan,
    ssoSessionIdleTimeout: 3600,
    clients,
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
