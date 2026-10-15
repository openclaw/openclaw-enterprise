import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createPlatformClock } from "../fixtures/repository-credentials/platform-clock.mjs";
import { createRegistryServiceOwner } from "../fixtures/repository-credentials/registry/service.mjs";
import { fixtureAppId } from "../fixtures/repository-credentials/github.mjs";
import {
  credentialCompositionModule,
  githubProviderModule,
} from "../fixtures/repository-credentials/runtime.mjs";

const resources = createResourceScope();
const clock = createPlatformClock();
let startup;
let offset = 0;
let advancing = false;
let stopping = false;

async function initialize(input) {
  const [
    { loadGitHubRepositoryRegistry },
    { createGitHubRegistryDriverFactory },
    { createGitHubKeyOwner },
    privateKey,
    key,
    cert,
  ] = await Promise.all([
    credentialCompositionModule("registry"),
    githubProviderModule("registry-factory"),
    githubProviderModule("material"),
    readFile(input.privateKeyFile),
    readFile(input.keyFile),
    readFile(input.certFile),
  ]);
  await clock.advance(input.offset);
  offset = input.offset;
  const keyOwner = createGitHubKeyOwner({
    privateKey: createPrivateKey(privateKey),
    appId: fixtureAppId,
    clock,
  });
  privateKey.fill(0);
  resources.after(() => keyOwner.close());
  const owner = createRegistryServiceOwner(resources, {
    ...input,
    loadGitHubRepositoryRegistry,
    createGitHubRegistryDriverFactory,
    key: keyOwner,
    clock,
    tls: { key, cert, ca: cert },
  });
  await owner.start();
  if (!stopping) {
    process.send({ type: "ready", offset });
  }
}

process.on("message", (message) => {
  if (stopping) {
    return;
  }
  if (message?.type === "start" && !startup) {
    startup = initialize(message.input);
    void startup.catch((error) => {
      // The listener's closed error code is safe to report; the parent retries on a new port.
      // It also covers the control socket bind, which a retry handles the same way.
      if (error?.message === "listener-startup-failed" && process.connected) {
        process.send({ type: "listener-unavailable" }, () => void stop(1));
      } else {
        void stop(1);
      }
    });
  } else if (
    message?.type === "advance" &&
    startup &&
    !advancing &&
    Number.isSafeInteger(message.offset) &&
    message.offset >= offset
  ) {
    advancing = true;
    void startup
      .then(() => clock.advance(message.offset - offset))
      .then(() => {
        offset = message.offset;
        advancing = false;
        if (!stopping) {
          process.send({ type: "advanced", offset });
        }
      })
      .catch(() => stop(1));
  } else {
    void stop(1);
  }
});

async function stop(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await startup;
  } catch {
    code = 1;
  }
  try {
    await resources.close();
    process.exit(code);
  } catch {
    // Private startup inputs and provider failures must not enter child output.
    process.exit(1);
  }
}

process.once("SIGTERM", () => void stop(0));
// Backend inventory belongs to the parent; a lost parent cannot support cleanup.
process.once("disconnect", () => process.exit(1));
