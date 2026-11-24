import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { parseRuntimeDownloadClientSelection } from "../../../scripts/lib/runtime-download-clients.ts";

// Rust component SHA-256s come from the 1.95.0 channel manifest. Go publishes
// tarball SHA-256s at go.dev/dl, and rustup publishes rustup-init.sha256.
// The two npm tarballs were checked against the version's dist.integrity.
const platforms = {
  x64: {
    rustTarget: "x86_64-unknown-linux-gnu",
    goArch: "amd64",
    bunArch: "x64",
    rustup: "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71",
    rustc: "8426a3d170a5879f5682f5fbdd024a1779b3951e7baba685af2d6dc32a6dfc15",
    "rust-std": "047ea7098803d3500fa1072e9cee5392697e21525559e4458128a2bf874aa382",
    cargo: "e74edd2cf7d0f1f1383b4f00eb90c843750bc489e2ccf7214e6476678a907425",
    go: "65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40",
    bun: "93ca5a2abe45f3bcac6dd55baff8bb06c4ac824b70f89650b54e5c8b80dbef18",
  },
  arm64: {
    rustTarget: "aarch64-unknown-linux-gnu",
    goArch: "arm64",
    bunArch: "aarch64",
    rustup: "15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433",
    rustc: "0fe3689eeaed603e5ef24572d11597d3edadaefd2cb181674ad621260f2501d2",
    "rust-std": "3a21b271b1ff973b94d69b25e7a39992f9fbcae1ab6d9475844a23e6ad3908ac",
    cargo: "7c070aeba9bbf12073646995a03f36c346bb5f541d0078ba6d9dc2a7adaaf6af",
    go: "a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49",
    bun: "ab95e7e692a53d25a1baa98ee395a17f5f264aedfb3cb15811432d54142f70eb",
  },
};

const selection = parseRuntimeDownloadClientSelection(
  readFileSync(new URL("../additional-download-clients.json", import.meta.url), "utf8"),
);
if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
  throw new Error(`Unsupported native tool platform ${process.platform}/${process.arch}.`);
}
const platform = platforms[process.arch];
mkdirSync("/archives", { recursive: true });

function download(url: string, filename: string, digest: string) {
  execFileSync("bash", ["scripts/ci/download-pinned.sh", url, `/archives/${filename}`, digest], {
    stdio: "inherit",
  });
}

if (selection.has("/opt/devtools/bin/rustup")) {
  download(
    `https://static.rust-lang.org/rustup/archive/1.29.1/${platform.rustTarget}/rustup-init`,
    "rustup",
    platform.rustup,
  );
}
if (selection.has("/opt/devtools/bin/cargo")) {
  for (const component of ["rustc", "rust-std", "cargo"] as const) {
    download(
      `https://static.rust-lang.org/dist/2026-04-16/${component}-1.95.0-${platform.rustTarget}.tar.xz`,
      `${component}.tar.xz`,
      platform[component],
    );
  }
}
if (selection.has("/opt/devtools/bin/go")) {
  download(`https://go.dev/dl/go1.27.3.linux-${platform.goArch}.tar.gz`, "go.tar.gz", platform.go);
}
if (selection.has("/opt/devtools/bin/bun")) {
  const name = `bun-linux-${platform.bunArch}`;
  download(`https://registry.npmjs.org/@oven/${name}/-/${name}-1.4.4.tgz`, "bun.tgz", platform.bun);
}
