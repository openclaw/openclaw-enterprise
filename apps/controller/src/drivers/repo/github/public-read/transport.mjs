import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

function configuration(path) {
  if (!isAbsolute(path ?? "")) {
    throw new Error("A managed public Git configuration is required.");
  }
  const bytes = readFileSync(path);
  if (bytes.length > 64 * 1024) {
    throw new Error("The managed public Git configuration is too large.");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "endpoint",
          "caPath",
          "capabilityPath",
          "capabilityEnvironment",
          "authenticatedRepositories",
        ].includes(key),
    ) ||
    !Array.isArray(value.authenticatedRepositories) ||
    !value.authenticatedRepositories.every(
      (repo) => typeof repo === "string" && /^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i.test(repo),
    ) ||
    !isAbsolute(value.caPath ?? "") ||
    (!isAbsolute(value.capabilityPath ?? "") &&
      value.capabilityEnvironment !== "OCE_PUBLIC_GITHUB_READ_CAPABILITY")
  ) {
    throw new Error("The managed public Git configuration is invalid.");
  }
  const endpoint = new URL(value.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("The public reader requires an exact HTTPS origin.");
  }
  return { ...value, endpoint: endpoint.origin };
}

function capability(value, allowPlaceholder = false) {
  if (
    typeof value !== "string" ||
    (!/^[a-z\d_-]{1,128}\.[A-Za-z\d_-]{43}$/i.test(value) &&
      !(
        allowPlaceholder &&
        /^openshell:resolve:env:s[0-9a-f]{64}_OCE_PUBLIC_GITHUB_READ_CAPABILITY$/.test(value)
      ))
  ) {
    throw new Error("Public reader authorization is unavailable.");
  }
  return value;
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function install(configPath) {
  configuration(configPath);
  if (process.env.GIT_EXEC_PATH) {
    throw new Error("Managed public Git cannot replace a configured GIT_EXEC_PATH.");
  }
  const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const original = result.stdout?.trim();
  if (result.status !== 0 || !isAbsolute(original ?? "")) {
    throw new Error("The image Git helper directory is unavailable.");
  }
  const helper = realpathSync(join(original, "git-remote-https"));
  const directory = mkdtempSync(join(tmpdir(), "oce-public-git-"));
  chmodSync(directory, 0o700);
  const script = fileURLToPath(import.meta.url);
  writeFileSync(
    join(directory, "git-remote-https"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} --remote-helper "$@"\n`,
    { mode: 0o500 },
  );
  // Git searches GIT_EXEC_PATH before PATH. Keep the image's other external
  // helpers discoverable without copying or replacing their implementations.
  return {
    GIT_EXEC_PATH: directory,
    PATH: original + ":" + (process.env.PATH ?? ""),
    OCE_PUBLIC_GITHUB_READ_CONFIG: configPath,
    OCE_PUBLIC_GITHUB_REAL_HTTP_HELPER: helper,
  };
}

function gitHubRepository(value) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const match =
    /^https:\/\/github\.com(?::443)?\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/(?!\.{1,2}(?:\.git)?$)([a-z\d._-]{1,104})$/i.exec(
      value,
    );
  if (!match) {
    throw new Error("Public Git requires a canonical GitHub HTTPS repository URL.");
  }
  const repository = match[2].replace(/\.git$/i, "");
  if (!repository || repository.length > 100 || repository === "." || repository === "..") {
    throw new Error("The GitHub repository URL is invalid.");
  }
  return `${match[1]}/${repository}`.toLowerCase();
}

function appendGitConfig(env, entries) {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0 || count > 256) {
    throw new Error("Inherited Git configuration is invalid.");
  }
  for (let index = 0; index < entries.length; index++) {
    env[`GIT_CONFIG_KEY_${count + index}`] = entries[index][0];
    env[`GIT_CONFIG_VALUE_${count + index}`] = entries[index][1];
  }
  env.GIT_CONFIG_COUNT = String(count + entries.length);
}

function remoteHelper(remote, originalUrl) {
  const config = configuration(process.env.OCE_PUBLIC_GITHUB_READ_CONFIG);
  const helper = process.env.OCE_PUBLIC_GITHUB_REAL_HTTP_HELPER;
  if (!isAbsolute(helper ?? "") || !remote || !originalUrl) {
    throw new Error("The managed Git transport is not installed.");
  }
  const repository = gitHubRepository(originalUrl);
  let url = originalUrl;
  const env = { ...process.env };
  const admittedBindings =
    process.env.OCE_PUBLIC_GITHUB_AUTHENTICATED_REPOSITORIES === undefined
      ? []
      : JSON.parse(process.env.OCE_PUBLIC_GITHUB_AUTHENTICATED_REPOSITORIES);
  if (
    !Array.isArray(admittedBindings) ||
    !admittedBindings.every(
      (bound) => typeof bound === "string" && /^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i.test(bound),
    )
  ) {
    throw new Error("Authenticated Git routing is unavailable.");
  }
  if (
    repository &&
    ![...config.authenticatedRepositories, ...admittedBindings].some(
      (bound) => bound.toLowerCase() === repository,
    )
  ) {
    const token = capability(
      config.capabilityEnvironment
        ? process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY
        : readFileSync(config.capabilityPath, "utf8").trim(),
      Boolean(config.capabilityEnvironment),
    );
    url = `${config.endpoint}/git/${repository}.git`;
    // Git's -c parameters outrank GIT_CONFIG_COUNT, and URL-specific options
    // outrank origin-wide ones. Reset command configuration, then constrain the
    // exact rewritten repository URL. Authenticated delegates retain every input.
    for (const name of Object.keys(env)) {
      if (/^GIT_CONFIG(?:_(?:COUNT|KEY_.*|VALUE_.*|PARAMETERS))?$/.test(name)) {
        delete env[name];
      }
    }
    for (const name of [
      "GIT_SSL_NO_VERIFY",
      "GIT_SSL_CERT",
      "GIT_SSL_KEY",
      "GIT_SSL_CAPATH",
      "GIT_SSL_CERT_PASSWORD_PROTECTED",
      "GIT_PROXY_SSL_CERT",
      "GIT_PROXY_SSL_KEY",
      "GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED",
    ]) {
      delete env[name];
    }
    // An empty sslCert value still activates native Git's client-certificate
    // credential path. Refuse configured client identities rather than sending
    // them to a different service or relying on an ineffective empty override.
    const inheritedHttp = spawnSync("git", ["config", "--null", "--get-urlmatch", "http", url], {
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    if (
      inheritedHttp.error ||
      ![0, 1].includes(inheritedHttp.status) ||
      inheritedHttp.stdout.split("\0").some((entry) => {
        const separator = entry.indexOf("\n");
        return (
          ["http.sslcert", "http.sslkey", "http.proxysslcert", "http.proxysslkey"].includes(
            entry.slice(0, separator).toLowerCase(),
          ) && entry.slice(separator + 1).length > 0
        );
      })
    ) {
      throw new Error("Inherited Git TLS client identities are unavailable for public reads.");
    }
    env.GIT_SSL_CAINFO = config.caPath;
    // Keep the Sandbox's environment proxy route; inherited Git config cannot
    // replace it with a proxy that receives repository credentials.
    const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? "";
    const http = `http.${url}/`;
    appendGitConfig(env, [
      ["http.extraHeader", ""],
      [`${http}.extraHeader`, ""],
      [`${http}.extraHeader`, `Authorization: Bearer ${token}`],
      [`${http}.sslCAInfo`, config.caPath],
      [`${http}.sslCAPath`, env.GIT_EXEC_PATH],
      [`${http}.sslVerify`, "true"],
      [`${http}.followRedirects`, "false"],
      [`${http}.cookieFile`, ""],
      [`${http}.saveCookies`, "false"],
      [`${http}.proxy`, proxy],
      [`${http}.emptyAuth`, "false"],
      [`${http}.delegation`, "none"],
      [`remote.${remote}.proxy`, proxy],
      ["credential.helper", ""],
      [`credential.${url}.helper`, ""],
      [`credential.${url}.username`, ""],
      ["credential.interactive", "false"],
    ]);
    env.GIT_TERMINAL_PROMPT = "0";
  }
  const child = spawn(helper, [remote, url], { env, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const term = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  child.once("error", () => {
    process.stderr.write("The image Git HTTP helper could not start.\n");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

function installMaterial(materialPath) {
  const bytes = readFileSync(materialPath);
  if (bytes.length > 1024 * 1024) {
    throw new Error("Public reader material exceeds its bound.");
  }
  const material = JSON.parse(bytes.toString("utf8"));
  if (
    !material ||
    Object.keys(material).sort().join(" ") !== "authenticatedRepositories caBundle endpoint" ||
    typeof material.caBundle !== "string"
  ) {
    throw new Error("Invalid public reader material.");
  }
  const directory = mkdtempSync(join(tmpdir(), "oce-public-git-material-"));
  chmodSync(directory, 0o700);
  let ca = material.caBundle;
  for (const file of new Set(
    [process.env.GIT_SSL_CAINFO, process.env.SSL_CERT_FILE, process.env.NODE_EXTRA_CA_CERTS].filter(
      Boolean,
    ),
  )) {
    const inherited = readFileSync(file);
    if (inherited.length > 1024 * 1024) {
      throw new Error("Inherited TLS trust exceeds its bound.");
    }
    ca += "\n" + inherited.toString("utf8");
  }
  const caPath = join(directory, "ca.pem");
  writeFileSync(caPath, ca, { mode: 0o400 });
  const token =
    process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY === undefined
      ? capability(readFileSync(process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE, "utf8").trim())
      : capability(process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY, true);
  const configPath = join(directory, "transport.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      endpoint: material.endpoint,
      caPath,
      capabilityEnvironment: "OCE_PUBLIC_GITHUB_READ_CAPABILITY",
      authenticatedRepositories: material.authenticatedRepositories,
    }),
    { mode: 0o400 },
  );
  return {
    ...install(configPath),
    OCE_PUBLIC_GITHUB_READ_CA_FILE: caPath,
    OCE_PUBLIC_GITHUB_READ_CAPABILITY: token,
  };
}

try {
  if (process.argv[2] === "--install-material" && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(installMaterial(process.argv[3])) + "\n");
  } else if (process.argv[2] === "--install" && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(install(process.argv[3])) + "\n");
  } else if (process.argv[2] === "--remote-helper" && process.argv.length === 5) {
    remoteHelper(process.argv[3], process.argv[4]);
  } else {
    throw new Error("Unsupported managed Git invocation.");
  }
} catch {
  // Neither native arguments nor configuration contents belong in diagnostics.
  process.stderr.write("The managed public Git transport refused this invocation.\n");
  process.exitCode = 1;
}
