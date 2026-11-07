import { createHash } from "node:crypto";
import type { V1Container, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import {
  canonicalPluginPackageContent,
  type InspectedPluginPackage,
} from "@openclaw-enterprise/contracts";

export const IMPORTED_PLUGIN_DIRECTORY = "/run/oce/imported-plugins";
const SOURCE_DIRECTORY = "/run/oce/imported-plugin-input";
const CHUNK_BYTES = 576 * 1024;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;

export interface ImportedPluginMaterial {
  readonly ids: readonly string[];
  readonly chunks: readonly { readonly name: string; readonly content: string }[];
}

// The ConfigMap limit applies per object. Every named chunk belongs to one immutable Agent revision.
export function importedPluginMaterial(
  snapshotName: string,
  releases: Readonly<Record<string, InspectedPluginPackage>>,
): ImportedPluginMaterial {
  const ids = Object.keys(releases).sort();
  const names = new Map<string, string>();
  let skillBytes = 0;
  const payload = ids.map((id) => {
    const release = releases[id]!;
    const content = canonicalPluginPackageContent(release);
    const digest = createHash("sha256").update(content).digest("hex");
    if (id !== `occ-import:${digest}` || release.digest !== digest) {
      throw new Error(`Imported plugin ${id} does not match its approved digest.`);
    }
    for (const skill of release.skills) {
      const previous = names.get(skill.name);
      if (previous) {
        throw new Error(`Skill ${skill.name} is selected from both ${previous} and ${id}.`);
      }
      names.set(skill.name, id);
      for (const file of skill.files) {
        skillBytes += Buffer.byteLength(file.contentBase64, "base64");
        if (skillBytes > MAX_SKILL_BYTES) {
          throw new Error(
            "Selected imported skills exceed OpenClaw's combined 8 MiB turn resource limit.",
          );
        }
      }
    }
    return release;
  });
  const bytes = Buffer.from(JSON.stringify(payload));
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    chunks.push({
      name: `${snapshotName}-${chunks.length}`,
      content: bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
    });
  }
  return { ids, chunks };
}

export const IMPORTED_PLUGIN_INIT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const canonical = ${canonicalPluginPackageContent.toString()};
const [source, target, expected] = process.argv.slice(1);
const ids = JSON.parse(expected);
const chunks = fs.readdirSync(source).filter((name) => /^chunk-[0-9]+$/.test(name))
  .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
const releases = JSON.parse(Buffer.concat(chunks.map((name, index) => {
  if (name !== "chunk-" + index) throw new Error("Missing imported plugin material.");
  return Buffer.from(fs.readFileSync(path.join(source, name), "utf8"), "base64");
})).toString("utf8"));
if (!Array.isArray(releases) || releases.length !== ids.length) throw new Error("Incomplete imported plugin material.");
for (const [index, release] of releases.entries()) {
  const digest = createHash("sha256").update(canonical(release)).digest("hex");
  if (ids[index] !== "occ-import:" + digest || release.digest !== digest) throw new Error("Imported plugin material failed digest verification.");
}
// Restarting an init container reuses its private emptyDir. Only this init container can write it.
const skillsRoot = path.join(target, "skills");
fs.rmSync(skillsRoot, { recursive: true, force: true });
fs.mkdirSync(skillsRoot, { recursive: true });
const pins = Object.create(null);
for (const release of releases) {
  for (const skill of release.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || Object.hasOwn(pins, skill.name)) throw new Error("Invalid or duplicate imported skill name.");
    const directory = path.join(skillsRoot, skill.name);
    fs.mkdirSync(directory);
    for (const file of skill.files) {
      const parts = file.path.split("/");
      if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) throw new Error("Invalid imported skill path.");
      const destination = path.join(directory, ...parts);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: file.executable ? 0o555 : 0o444 });
    }
    if (!fs.statSync(path.join(directory, "SKILL.md")).isFile()) throw new Error("Missing imported SKILL.md.");
    pins[skill.name] = path.join(directory, "SKILL.md");
  }
}
fs.writeFileSync(path.join(target, "release.json"), JSON.stringify({ ids, pins }));
`;

export function importedPluginDeployment(material: ImportedPluginMaterial, image: string) {
  const volumes: V1Volume[] = [
    {
      name: "imported-plugin-source",
      projected: {
        sources: material.chunks.map(({ name }, index) => ({
          configMap: { name, items: [{ key: "content", path: `chunk-${index}` }] },
        })),
      },
    },
    { name: "imported-plugin-material", emptyDir: {} },
  ];
  const volumeMounts: V1VolumeMount[] = [
    { name: "imported-plugin-material", mountPath: IMPORTED_PLUGIN_DIRECTORY, readOnly: true },
  ];
  const initContainer: V1Container = {
    name: "prepare-imported-plugins",
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["node", "-e", IMPORTED_PLUGIN_INIT],
    args: [SOURCE_DIRECTORY, IMPORTED_PLUGIN_DIRECTORY, JSON.stringify(material.ids)],
    volumeMounts: [
      { name: "imported-plugin-source", mountPath: SOURCE_DIRECTORY, readOnly: true },
      { name: "imported-plugin-material", mountPath: IMPORTED_PLUGIN_DIRECTORY },
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  };
  return { volumes, volumeMounts, initContainer };
}
