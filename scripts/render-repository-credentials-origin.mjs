import { spawn } from "node:child_process";

function fail(message) {
  process.stderr.write(`render-repository-credentials-origin: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stderr.write(`Usage: node scripts/render-repository-credentials-origin.mjs \\
  --release NAME --namespace NAME --values FILE

Prints JSON for the repository credential broker origin rendered by Helm.
`);
}

function argValue(args, index, name) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return args[index + 1];
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--release":
        options.release = argValue(argv, index, arg);
        index += 1;
        break;
      case "--namespace":
        options.namespace = argValue(argv, index, arg);
        index += 1;
        break;
      case "--values":
        options.values = argValue(argv, index, arg);
        index += 1;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        usage();
        fail(`unsupported argument ${arg}`);
    }
  }
  for (const name of ["release", "namespace", "values"]) {
    if (!options[name]) {
      fail(`--${name} is required`);
    }
  }
  return options;
}

function command(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `${file} exited ${code ?? "without status"}`));
      }
    });
    child.stdin.end(input);
  });
}

function objectsFromYq(jsonLines) {
  return jsonLines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((value) => value && typeof value === "object" && value.kind);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    fail(`rendered repository credential container is missing ${flag}`);
  }
  return args[index + 1];
}

function renderedBroker(objects, options) {
  const worker = objects.find(
    (object) =>
      object.kind === "Deployment" && object.metadata?.name === "openclaw-enterprise-worker",
  );
  const broker = worker?.spec?.template?.spec?.containers?.find(
    (container) => container.name === "repository-credentials",
  );
  if (!broker) {
    fail("repositoryCredentials.enabled did not render a repository credential container");
  }
  const args = broker.args ?? [];
  const origin = valueAfter(args, "--public-origin");
  const backendId = valueAfter(args, "--backend-id");
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("rendered broker origin is not a valid URL");
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    fail("rendered broker origin must be a bare HTTPS origin");
  }
  return {
    origin,
    hostname: url.hostname,
    serviceName: url.hostname.split(".")[0],
    namespace: options.namespace,
    release: options.release,
    backendId,
  };
}

const options = parseArgs(process.argv.slice(2));

try {
  const manifests = await command(process.env.OCC_HELM_BIN ?? "helm", [
    "template",
    options.release,
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    options.namespace,
    "--values",
    options.values,
  ]);
  const jsonLines = await command(
    process.env.OCC_YQ_BIN ?? "yq",
    ["eval-all", "-o=json", "-I=0", ".", "-"],
    manifests,
  );
  process.stdout.write(`${JSON.stringify(renderedBroker(objectsFromYq(jsonLines), options))}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
