import { spawnSync } from "node:child_process";
import type { RuntimeRepositoryBinding, RuntimeRepositoryManifest } from "./manifest.ts";

function gitRepositoryPath(value: string): string | undefined {
  const path = value.replace(/\/+$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) && !path.includes("..")
    ? path.toLowerCase()
    : undefined;
}

function selectBinding(
  matches: readonly RuntimeRepositoryBinding[],
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  if (pinned) {
    if (!matches.includes(pinned)) {
      throw new Error("conflicting-repository-selection");
    }
    return pinned;
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "repository-not-admitted" : "name-one-repository-ref");
  }
  return matches[0]!;
}

/** Match the effective credential endpoint, never a guessed command operand. */
export function selectGitCredential(
  manifest: RuntimeRepositoryManifest,
  fields: ReadonlyMap<string, string>,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const path = gitRepositoryPath(fields.get("path") ?? "");
  if (fields.get("protocol") !== "https" || path === undefined) {
    throw new Error("repository-not-admitted");
  }
  const matches = manifest.bindings.filter(({ client }) => {
    const repository = client.repository.toLowerCase();
    return (
      fields.get("host") === new URL(client.gatewayOrigin).host &&
      [repository, `${repository}.git`].includes(path)
    );
  });
  const selected = selectBinding(matches, pinned);
  if (fields.has("username") && fields.get("username") !== selected.client.gitUsername) {
    throw new Error("repository-not-admitted");
  }
  return selected;
}

export function selectGhRepository(
  manifest: RuntimeRepositoryManifest,
  value: string,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const repository = value.replace(/^github\.com\//, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) {
    throw new Error("unsupported-repository-target");
  }
  return selectBinding(
    manifest.bindings.filter(
      ({ client }) =>
        client.canonicalApiHost === "github.com" &&
        client.repository.toLowerCase() === repository.toLowerCase(),
    ),
    pinned,
  );
}

/** Select the actual pre-push destination; unrelated transports keep native behavior. */
function gitPushDestinations(
  manifest: RuntimeRepositoryManifest,
  destination: string,
): readonly RuntimeRepositoryBinding[] {
  if (!destination.startsWith("https://")) {
    return [];
  }
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return [];
  }
  if (
    /[\s\\%?#]/.test(destination) ||
    destination.includes("..") ||
    url.password ||
    url.pathname.startsWith("//")
  ) {
    // Git decodes the URL and trims leading path slashes before the credential
    // helper matches, so an irregular gateway destination can still receive the
    // bearer. Fail closed when a repository it may name has a push-ref policy.
    let decoded: string | undefined;
    try {
      decoded = gitRepositoryPath(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    } catch {
      decoded = undefined;
    }
    const restricted = manifest.bindings.some(({ client }) => {
      const repository = client.repository.toLowerCase();
      return (
        client.gatewayOrigin === url.origin &&
        client.pushRefAllowlist !== undefined &&
        (decoded === undefined || [repository, repository + ".git"].includes(decoded))
      );
    });
    if (restricted) {
      throw new Error("unsupported-push-destination");
    }
    return [];
  }
  const path = gitRepositoryPath(url.pathname.slice(1));
  if (path === undefined) {
    return [];
  }
  return manifest.bindings.filter(({ client }) => {
    const repository = client.repository.toLowerCase();
    return (
      [client.gatewayOrigin, "https://" + client.canonicalApiHost].includes(url.origin) &&
      [repository, repository + ".git"].includes(path)
    );
  });
}

export function hasGitPushDestination(
  manifest: RuntimeRepositoryManifest,
  destination: string,
): boolean {
  return gitPushDestinations(manifest, destination).length > 0;
}

export function selectGitPushDestination(
  manifest: RuntimeRepositoryManifest,
  destination: string,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding | undefined {
  const matches = gitPushDestinations(manifest, destination);
  if (matches.length === 0) {
    return undefined;
  }
  const selected = selectBinding(matches, pinned);
  const username = new URL(destination).username;
  if (username && username !== selected.client.gitUsername) {
    throw new Error("repository-not-admitted");
  }
  return selected;
}

/** Ask native Git for effective remotes only when gh has no explicit target. */
export function selectImplicitGhRepository(
  manifest: RuntimeRepositoryManifest,
  env: NodeJS.ProcessEnv,
): RuntimeRepositoryBinding {
  const output = (args: string[]): string[] => {
    const result = spawnSync("/usr/bin/git", args, {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error || /[\r\0]/.test(result.stdout)) {
      throw new Error("repository-target-inspection-failed");
    }
    return result.stdout.trimEnd().split("\n").filter(Boolean);
  };
  const remotes = output(["remote"]);
  if (remotes.length === 0 || remotes.length > 64) {
    throw new Error("name-one-repository-target");
  }
  let selected: RuntimeRepositoryBinding | undefined;
  for (const remote of remotes) {
    const urls = output(["remote", "get-url", "--all", "--", remote]);
    if (
      urls.length !== 1 ||
      !urls[0]!.startsWith("https://") ||
      /[\s\\%?#@]/.test(urls[0]!) ||
      urls[0]!.includes("..")
    ) {
      throw new Error("name-one-repository-target");
    }
    const url = new URL(urls[0]!);
    const matches = manifest.bindings.filter(({ client }) => {
      const repository = client.repository.toLowerCase();
      return (
        [client.gatewayOrigin, `https://${client.canonicalApiHost}`].includes(url.origin) &&
        [repository, `${repository}.git`].includes(url.pathname.slice(1).toLowerCase())
      );
    });
    const binding = selectBinding(matches);
    if (selected && selected !== binding) {
      throw new Error("name-one-repository-target");
    }
    selected = binding;
  }
  if (!selected) {
    throw new Error("name-one-repository-target");
  }
  return selected;
}
