import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publicationAlias, verifyGhcr } from "./admission.ts";
import { digestPattern, fileDigest, identity, images, validatePreparedImage } from "./metadata.ts";
import type { Producer } from "./metadata.ts";
import { readArchivePlatforms } from "./oci.ts";
import { inspectDigest, remoteTagDigest, skopeo, skopeoLogin } from "./registry.ts";

export async function seal(directory: string | undefined, env: NodeJS.ProcessEnv) {
  const digest = env.IMAGE_DIGEST ?? "";
  assert.match(digest, digestPattern);
  assert.ok(directory !== undefined, "An OCI layout directory is required.");
  const platformDigests = readArchivePlatforms(join(directory, "image.tar"), digest);
  const metadata = {
    platformDigests,
    ...identity(env, env.IMAGE),
    digest,
    archiveSha256: await fileDigest(join(directory, "image.tar")),
  };
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function publishPrepared(
  directory: string | undefined,
  env: NodeJS.ProcessEnv,
  producer: Producer,
  verify: () => unknown | Promise<unknown>,
  requestedAlias?: string,
) {
  const aliasTag = requestedAlias === undefined ? undefined : publicationAlias(requestedAlias);
  await verify();
  assert.ok(directory !== undefined, "A prepared image directory is required.");
  const tag = `sha-${env.SOURCE_SHA}`;
  const prepared = [];
  for (const image of images) {
    const dir = join(directory, `container-${image}-${producer.runId}-${producer.attempt}`);
    const metadata: unknown = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
    validatePreparedImage(metadata, { ...producer, image });
    const archive = join(dir, "image.tar");
    assert.equal(await fileDigest(archive), metadata.archiveSha256, "OCI archive bytes changed.");
    assert.equal(inspectDigest(`oci-archive:${archive}`), metadata.digest, "OCI digest changed.");
    const destination = env[`GHCR_${image.toUpperCase()}_IMAGE`];
    await verifyGhcr(destination, metadata.digest, tag);
    assert.ok(destination !== undefined);
    prepared.push({ ...metadata, image, destination, archive });
  }
  assert.notEqual(
    prepared[0]?.destination,
    prepared[1]?.destination,
    "Images need separate packages.",
  );
  const authDirectory = await mkdtemp(join(tmpdir(), "enterprise-registry-"));
  const authfile = join(authDirectory, "auth.json");
  try {
    skopeoLogin("ghcr.io", authfile, env.GITHUB_ACTOR, env.GH_TOKEN);
    for (const image of prepared) {
      // Source, CI and visibility may change while large images are being copied.
      await verify();
      const listed = await verifyGhcr(image.destination, image.digest, tag);
      const remoteDigest = remoteTagDigest(image.destination, tag, authfile, listed);
      if (remoteDigest !== null) {
        assert.equal(remoteDigest, image.digest, "Remote source tag has different image bytes.");
      } else {
        skopeo(
          [
            "copy",
            "--all",
            "--preserve-digests",
            "--authfile",
            authfile,
            `oci-archive:${image.archive}`,
            `docker://${image.destination}:${tag}`,
          ],
          { stdio: "inherit" },
        );
      }
      assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
      console.log(
        `Verified ${image.destination}:${tag} @ ${image.digest}${remoteDigest ? " (already published)" : ""}`,
      );
    }
    if (aliasTag !== undefined) {
      // Both immutable tags must be verified before either mutable alias moves.
      for (const image of prepared) {
        await verify();
        await verifyGhcr(image.destination, image.digest, tag);
        assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
        skopeo(
          [
            "copy",
            "--all",
            "--preserve-digests",
            "--authfile",
            authfile,
            `oci-archive:${image.archive}`,
            `docker://${image.destination}:${aliasTag}`,
          ],
          { stdio: "inherit" },
        );
        assert.equal(
          inspectDigest(`docker://${image.destination}:${aliasTag}`, authfile),
          image.digest,
        );
      }
      // A second check catches drift while the other package was being copied.
      for (const image of prepared) {
        assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
        assert.equal(
          inspectDigest(`docker://${image.destination}:${aliasTag}`, authfile),
          image.digest,
        );
        console.log(`Verified ${image.destination}:${aliasTag} @ ${image.digest}`);
      }
    }
  } finally {
    await rm(authDirectory, { recursive: true, force: true });
  }
  const receipt = prepared.map(({ archive, ...image }) => ({
    ...image,
    tag,
    ...(aliasTag === undefined ? {} : { aliasTag }),
  }));
  assert.ok(env.GITHUB_STEP_SUMMARY !== undefined, "GITHUB_STEP_SUMMARY is required.");
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    receipt
      .map(
        (image) =>
          `- ${image.image}: \`${image.destination}@${image.digest}\`${aliasTag ? ` (tag: \`${aliasTag}\`)` : ""}\n`,
      )
      .join(""),
  );
  return receipt;
}
