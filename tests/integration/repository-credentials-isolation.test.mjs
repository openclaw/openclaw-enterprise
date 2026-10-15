import test from "node:test";

async function deliveredImages(t) {
  const serviceImage = process.env.REPOSITORY_CREDENTIALS_SERVICE_IMAGE;
  const clientImage = process.env.REPOSITORY_CREDENTIALS_CLIENT_IMAGE;
  if (!serviceImage && !clientImage) {
    t.skip(
      "requires delivered REPOSITORY_CREDENTIALS_SERVICE_IMAGE and REPOSITORY_CREDENTIALS_CLIENT_IMAGE",
    );
    return undefined;
  }
  if (!serviceImage || !clientImage) {
    throw new Error("both delivered isolation images are required");
  }
  const { qualifyIsolation } =
    await import("../fixtures/repository-credentials-isolation/harness.mjs");
  return { qualifyIsolation, serviceImage, clientImage };
}

test(
  "delivered service keeps provider credentials outside a separate Agent container",
  { timeout: 180000 },
  async (t) => {
    const delivered = await deliveredImages(t);
    if (delivered) {
      const { qualifyIsolation, ...images } = delivered;
      await qualifyIsolation(t, images);
    }
  },
);

test(
  "delivered development token service keeps the static token outside a separate Agent container",
  { timeout: 180000 },
  async (t) => {
    const delivered = await deliveredImages(t);
    if (delivered) {
      const { qualifyIsolation, ...images } = delivered;
      await qualifyIsolation(t, { ...images, authority: "github-token" });
    }
  },
);
