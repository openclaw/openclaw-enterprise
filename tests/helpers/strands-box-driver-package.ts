import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds the example Strands Box Driver into a controller-shaped package root
// and a one-day CA for 127.0.0.1, so the baseline conformance file and the
// manual native Codex file test the same installed package.
const root = fileURLToPath(new URL("../../", import.meta.url));
const driverSource = join(root, "deploy/examples/strands-box/driver");

export const strandsBoxDriverPackageName = "@openclaw-enterprise/example-strands-box-driver";

export async function strandsBoxDriverPackageVersion(): Promise<string> {
  const { version } = JSON.parse(await readFile(join(driverSource, "package.json"), "utf8")) as {
    version: string;
  };
  return version;
}

export async function installStrandsBoxDriverPackage(directory: string) {
  const packageRoot = join(directory, "controller");
  const scope = join(packageRoot, "node_modules/@openclaw-enterprise");
  const installed = join(scope, "example-strands-box-driver");
  await mkdir(installed, { recursive: true });
  await cp(join(driverSource, "package.json"), join(installed, "package.json"));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      dependencies: { [strandsBoxDriverPackageName]: await strandsBoxDriverPackageVersion() },
    }),
  );
  for (const peer of ["occ", "utils", "contracts"]) {
    await symlink(join(root, "packages", peer), join(scope, peer), "dir");
  }
  execFileSync(process.execPath, [join(driverSource, "build.ts"), join(installed, "dist")], {
    cwd: root,
  });
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Strands Box conformance CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "ca.key"),
      "-out",
      join(directory, "ca.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    packageRoot,
    ca: await readFile(join(directory, "ca.pem"), "utf8"),
    certKey: join(directory, "ca.key"),
    nativeModule: pathToFileURL(join(installed, "dist/native.js")).href,
  };
}

// The installed package's readiness probe, with a TLS identity its CA signs.
export async function strandsBoxReadinessProbe(directory: string) {
  const { ca, certKey, nativeModule } = await installStrandsBoxDriverPackage(directory);
  const module = (await import(nativeModule)) as Record<string, unknown>;
  const exported = module.nativeStatus;
  if (typeof exported !== "function") {
    throw new Error("the installed Driver must export nativeStatus");
  }
  const probe = exported as (
    url: string,
    ca: string,
    token: string,
    signal: AbortSignal,
    generationSha256?: string,
  ) => Promise<unknown>;
  return { probe, ca, tls: { key: await readFile(certKey), cert: ca } };
}
