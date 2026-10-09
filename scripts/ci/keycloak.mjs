import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { connect } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Keycloak for the keycloak-oidc lane (RFC-0019): a digest-pinned `start-dev` server that
// imports tests/fixtures/keycloak/realm-oce.json and serves HTTPS on 127.0.0.1:443 as
// keycloak.oce.localhost, so its issuer satisfies OCE's endpoint rule unchanged.

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const keycloakRealmFile = join(repositoryRoot, "tests/fixtures/keycloak/realm-oce.json");
export const keycloakImageFile = join(repositoryRoot, "tests/fixtures/keycloak/image.json");
export const keycloakHost = "keycloak.oce.localhost";
export const keycloakIssuer = `https://${keycloakHost}/realms/oce`;
export const keycloakResourceKind = "keycloak-server";

const clientId = "oce-console";
const containerHttpsPort = 8443;
const containerTlsDirectory = "/opt/keycloak/conf/oce-tls";
const readinessDeadlineMs = 180_000;
const ownedNamePattern = /^openclaw-ci-kc-[a-z0-9-]+$/;
const hostsMarker = "# openclaw-ci keycloak";

// Prefixes every failure with the step it happened in, so a lane log names it.
async function step(name, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`Keycloak ${name} step failed: ${error.message}`, { cause: error });
  }
}

export async function readKeycloakImage(path = keycloakImageFile) {
  const { image } = JSON.parse(await readFile(path, "utf8"));
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
    throw new Error(`${path} must pin an immutable image@sha256 reference.`);
  }
  return image;
}

// `--import-realm` resolves `${NAME}` from the server's environment and, when NAME is
// unset, imports the placeholder text itself, so every placeholder must have a value.
export function realmPlaceholders(realmText) {
  return [...new Set([...realmText.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((m) => m[1]))];
}

export function assertPlaceholderValues(names, values) {
  const empty = names.filter((name) => typeof values[name] !== "string" || values[name] === "");
  if (empty.length > 0) {
    throw new Error(`refusing to start while realm placeholder variable(s) are empty: ${empty}`);
  }
}

function secret() {
  return randomBytes(24).toString("base64url");
}

async function writePrivate(path, data) {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

// A two-day private CA and its server leaves: one for Keycloak's DNS name, one for the
// test's HTTPS Console origin on 127.0.0.1. Same openssl recipe as routing.mjs.
async function createCertificates(directory, execFile) {
  const ca = { certPath: join(directory, "ca.crt"), keyPath: join(directory, "ca.key") };
  await execFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "2",
    "-nodes",
    "-subj",
    "/CN=OCC disposable Keycloak test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    ca.keyPath,
    "-out",
    ca.certPath,
  ]);
  const leaves = {};
  for (const [name, commonName, subjectAltName] of [
    ["keycloak", keycloakHost, `DNS:${keycloakHost}`],
    ["console", "127.0.0.1", "IP:127.0.0.1"],
  ]) {
    const certPath = join(directory, `${name}.crt`);
    const keyPath = join(directory, `${name}.key`);
    const csrPath = join(directory, `${name}.csr`);
    const extPath = join(directory, `${name}.ext`);
    await writePrivate(
      extPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${subjectAltName}`,
        "",
      ].join("\n"),
    );
    await execFile("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=${commonName}`,
      "-keyout",
      keyPath,
      "-out",
      csrPath,
    ]);
    await execFile("openssl", [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      ca.certPath,
      "-CAkey",
      ca.keyPath,
      "-set_serial",
      `0x${randomBytes(15).toString("hex")}`,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      extPath,
      "-out",
      certPath,
    ]);
    await rm(csrPath, { force: true });
    await rm(extPath, { force: true });
    leaves[name] = { certPath, keyPath };
  }
  for (const path of [ca.certPath, ca.keyPath, ...Object.values(leaves).flatMap(Object.values)]) {
    await chmod(path, 0o600);
  }
  return { ca, leaves };
}

/** The resolver's answer for the Keycloak name, as text for the prepare log. */
async function resolverAnswer(lookupAll) {
  try {
    const addresses = (await lookupAll(keycloakHost)).map(({ address }) => address);
    return { loopbackOnly: addresses.length === 1 && addresses[0] === "127.0.0.1", addresses };
  } catch (error) {
    return { loopbackOnly: false, addresses: [], error: error.code ?? error.message };
  }
}

function describeAnswer({ addresses, error }) {
  return error === undefined ? `[${addresses.join(", ")}]` : `no answer (${error})`;
}

function hostsLineFor(resource) {
  return `127.0.0.1 ${keycloakHost} ${hostsMarker} ${resource.name}`;
}

function loopbackPortAccepts(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (accepted) => {
      socket.destroy();
      resolvePromise(accepted);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// Real DNS, real TLS: the request trusts only the lane CA (plus the system store).
function httpsJSON(url, { ca, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method, headers, ca, timeout: 10_000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolvePromise({ status: response.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${url} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}

class PermanentReadinessError extends Error {}

async function checkReadiness({ ca, adminUsername, adminPassword, expected }) {
  const discovery = await httpsJSON(`${keycloakIssuer}/.well-known/openid-configuration`, {
    ca,
  });
  if (discovery.status !== 200) {
    throw new Error(`discovery answered HTTP ${discovery.status}`);
  }
  if (discovery.json?.issuer !== keycloakIssuer) {
    throw new PermanentReadinessError(
      `discovery issuer ${JSON.stringify(discovery.json?.issuer)} is not ${keycloakIssuer}`,
    );
  }
  const token = await httpsJSON(
    `https://${keycloakHost}/realms/master/protocol/openid-connect/token`,
    {
      ca,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: adminUsername,
        password: adminPassword,
      }).toString(),
    },
  );
  if (token.status !== 200 || typeof token.json?.access_token !== "string") {
    throw new Error(`admin sign-in answered HTTP ${token.status}`);
  }
  const authorization = { authorization: `Bearer ${token.json.access_token}` };
  const clients = await httpsJSON(
    `https://${keycloakHost}/admin/realms/oce/clients?clientId=${clientId}`,
    { ca, headers: authorization },
  );
  const client = clients.json?.[0];
  if (clients.status !== 200 || client?.clientId !== clientId) {
    throw new PermanentReadinessError(`the oce realm has no ${clientId} client`);
  }
  const clientSecret = await httpsJSON(
    `https://${keycloakHost}/admin/realms/oce/clients/${encodeURIComponent(client.id)}/client-secret`,
    { ca, headers: authorization },
  );
  const value = clientSecret.json?.value;
  // A literal `${...}` means the import read an unset variable; never hand that to a test.
  if (typeof value !== "string" || /\$\{/.test(value)) {
    throw new PermanentReadinessError("the client secret is a literal realm placeholder");
  }
  if (value !== expected.clientSecret) {
    throw new PermanentReadinessError("the client secret differs from the generated secret");
  }
  if (JSON.stringify(client.redirectUris) !== JSON.stringify([expected.redirectUri])) {
    throw new PermanentReadinessError("the client redirect URI differs from the reserved one");
  }
}

async function containerRunning(execFile, docker, name) {
  const inspected = await execFile(docker, ["inspect", "--format", "{{.State.Running}}", name]);
  return inspected.stdout.trim() === "true";
}

async function waitForReadiness({ execFile, docker, name, sleep, deadlineMs, ...check }) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      await checkReadiness(check);
      return;
    } catch (error) {
      if (error instanceof PermanentReadinessError) {
        throw error;
      }
      last = error;
    }
    if (!(await containerRunning(execFile, docker, name))) {
      throw new Error(`the container exited before it was ready (last: ${last.message})`);
    }
    if (Date.now() - started >= deadlineMs) {
      throw new Error(`not ready within ${deadlineMs / 1000} s (last: ${last.message})`);
    }
    await sleep(2_000);
  }
}

/**
 * Starts the lane's Keycloak. `registerResource` records the cleanup resource before any
 * side effect; `saveState` persists later additions to it (the hosts line).
 */
export async function prepareKeycloak({
  stateDirectory,
  name,
  execFile,
  docker = "docker",
  ensureImage,
  reservePort,
  registerResource,
  saveState,
  lookupAll = (host) => lookup(host, { all: true }),
  portAccepts = loopbackPortAccepts,
  sleep = delay,
  realmFile = keycloakRealmFile,
  imageFile = keycloakImageFile,
  deadlineMs = readinessDeadlineMs,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  if (!ownedNamePattern.test(name)) {
    throw new Error(`Keycloak container name is not owned by CI: ${name}`);
  }
  const directory = join(stateDirectory, name);
  const resource = await registerResource({ name, directory });

  const image = await step("image", async () => {
    const pinned = await readKeycloakImage(imageFile);
    // Pulls through pullImage's bounded retry and verifies the repository digest.
    await ensureImage(pinned);
    return pinned;
  });

  const port = await step("port", async () => {
    if (await portAccepts(443)) {
      throw new Error("127.0.0.1:443 is already in use; stop the service holding it.");
    }
    return reservePort();
  });

  const values = {
    OCE_KEYCLOAK_CLIENT_SECRET: secret(),
    OCE_KEYCLOAK_REDIRECT_URI: `https://127.0.0.1:${port}/api/auth/providers/oidc/callback`,
    OCE_KEYCLOAK_ALICE_PASSWORD: secret(),
    OCE_KEYCLOAK_CAROL_PASSWORD: secret(),
  };
  await step("placeholders", async () => {
    assertPlaceholderValues(realmPlaceholders(await readFile(realmFile, "utf8")), values);
  });

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const admin = { username: "admin", password: secret() };
  const secretsPath = join(directory, "secrets.json");
  await writePrivate(
    secretsPath,
    `${JSON.stringify(
      {
        admin,
        clientId,
        clientSecret: values.OCE_KEYCLOAK_CLIENT_SECRET,
        redirectUri: values.OCE_KEYCLOAK_REDIRECT_URI,
        users: {
          alice: { password: values.OCE_KEYCLOAK_ALICE_PASSWORD },
          carol: { password: values.OCE_KEYCLOAK_CAROL_PASSWORD },
        },
      },
      null,
      2,
    )}\n`,
  );
  const { ca, leaves } = await step("certificates", () => createCertificates(directory, execFile));

  await step("hosts", async () => {
    // A `::1`-first answer against a loopback-only publication would flake. The log records
    // each runner image's resolver behaviour (docs/testing/keycloak.md).
    const answer = await resolverAnswer(lookupAll);
    if (answer.loopbackOnly) {
      log(`Keycloak hosts: ${keycloakHost} resolves to 127.0.0.1; no /etc/hosts line added.`);
      return;
    }
    log(
      `Keycloak hosts: ${keycloakHost} resolves to ${describeAnswer(answer)}; adding an /etc/hosts line.`,
    );
    resource.hostsLine = hostsLineFor(resource);
    await saveState();
    await execFile("sudo", [
      "-n",
      "sh",
      "-c",
      'printf "%s\\n" "$1" >> /etc/hosts',
      "sh",
      resource.hostsLine,
    ]);
    const added = await resolverAnswer(lookupAll);
    if (!added.loopbackOnly) {
      throw new Error(
        `${keycloakHost} still resolves to ${describeAnswer(added)}, not exactly 127.0.0.1; /etc/hosts is not consulted first.`,
      );
    }
  });

  await step("start", async () => {
    const env = {
      KC_BOOTSTRAP_ADMIN_USERNAME: admin.username,
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin.password,
      ...values,
    };
    await execFile(
      docker,
      [
        "run",
        "--detach",
        "--name",
        name,
        // Root in the container reads the 0600 leaf key it bind-mounts read-only.
        "--user",
        "0",
        "--memory",
        "1536m",
        "--publish",
        `127.0.0.1:443:${containerHttpsPort}`,
        "--volume",
        `${realmFile}:/opt/keycloak/data/import/realm-oce.json:ro`,
        "--volume",
        `${leaves.keycloak.certPath}:${containerTlsDirectory}/tls.crt:ro`,
        "--volume",
        `${leaves.keycloak.keyPath}:${containerTlsDirectory}/tls.key:ro`,
        // Values come from this process's environment, never the command line.
        ...Object.keys(env).flatMap((variable) => ["--env", variable]),
        image,
        "start-dev",
        "--import-realm",
        `--hostname=https://${keycloakHost}`,
        "--http-enabled=false",
        `--https-port=${containerHttpsPort}`,
        `--https-certificate-file=${containerTlsDirectory}/tls.crt`,
        `--https-certificate-key-file=${containerTlsDirectory}/tls.key`,
      ],
      { env, timeoutMs: 120_000 },
    );
  });

  await step("readiness", async () => {
    try {
      await waitForReadiness({
        execFile,
        docker,
        name,
        sleep,
        deadlineMs,
        ca: await readFile(ca.certPath),
        adminUsername: admin.username,
        adminPassword: admin.password,
        expected: {
          clientSecret: values.OCE_KEYCLOAK_CLIENT_SECRET,
          redirectUri: values.OCE_KEYCLOAK_REDIRECT_URI,
        },
      });
    } catch (error) {
      const logs = await execFile(docker, ["logs", "--tail", "40", name]).catch(() => undefined);
      if (logs) {
        log(`Keycloak container log tail:\n${logs.stdout}${logs.stderr}`);
      }
      throw error;
    }
  });

  return {
    resource,
    env: {
      OCC_TEST_KEYCLOAK_ISSUER: keycloakIssuer,
      OCC_TEST_KEYCLOAK_CONSOLE_PORT: String(port),
      OCC_TEST_KEYCLOAK_SECRETS_FILE: secretsPath,
      OCC_TEST_KEYCLOAK_CA_CERT: ca.certPath,
      OCC_TEST_KEYCLOAK_CONSOLE_CERT: leaves.console.certPath,
      OCC_TEST_KEYCLOAK_CONSOLE_KEY: leaves.console.keyPath,
      OCC_TEST_KEYCLOAK_CONTAINER: name,
      // Node reads this only at start, so the test process receives it from preparation.
      NODE_EXTRA_CA_CERTS: ca.certPath,
    },
  };
}

/** Removes the container, the hosts line and the private directory a run created. */
export async function cleanupKeycloak(
  resource,
  { execFile, docker = "docker", hostsFile = "/etc/hosts" },
) {
  if (!ownedNamePattern.test(resource.name ?? "")) {
    throw new Error(`Refusing to clean unowned Keycloak container: ${resource.name}`);
  }
  if (
    typeof resource.directory !== "string" ||
    !isAbsolute(resource.directory) ||
    basename(resource.directory) !== resource.name
  ) {
    throw new Error(
      `Refusing to clean Keycloak directory outside ownership: ${resource.directory}`,
    );
  }
  await execFile(docker, ["rm", "--force", "--volumes", resource.name]).catch((error) => {
    if (!/no such container|no container with name or id/i.test(error.message)) {
      throw error;
    }
  });
  const remaining = await execFile(docker, [
    "ps",
    "--all",
    "--filter",
    `name=^${resource.name}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (remaining.stdout.trim() !== "") {
    throw new Error(`Owned Keycloak container remains after removal: ${resource.name}`);
  }
  if (resource.hostsLine !== undefined) {
    if (resource.hostsLine !== hostsLineFor(resource)) {
      throw new Error("Refusing to remove a hosts line this run did not write.");
    }
    const present = async () =>
      (await readFile(hostsFile, "utf8")).split(/\r?\n/).includes(resource.hostsLine);
    if (await present()) {
      // Rewrite in place (the file may be a bind mount) and keep it on a grep error.
      await execFile("sudo", [
        "-n",
        "sh",
        "-c",
        'grep -vxF -e "$1" "$2" > "$2.$3"; s=$?; [ "$s" -le 1 ] && cat "$2.$3" > "$2"; rm -f "$2.$3"; [ "$s" -le 1 ]',
        "sh",
        resource.hostsLine,
        hostsFile,
        resource.name,
      ]);
      if (await present()) {
        throw new Error(`The Keycloak hosts line remains in ${hostsFile}.`);
      }
    }
  }
  await rm(resource.directory, { recursive: true, force: true });
}
