import { isAbsolute, resolve } from "node:path";
import { closed, nonempty, object } from "../../composition/installation-fields.ts";

export interface RemotePreparedGitConfiguration {
  readonly issuerEndpoint: string;
  readonly issuerCaPath: string;
  readonly workerCertificatePath: string;
  readonly workerPrivateKeyPath: string;
}

export function preparedGitFilePath(value: unknown, label: string): string {
  const path = nonempty(value, label);
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(label + " requires an absolute mounted-file path.");
  }
  return path;
}

export function remotePreparedGitConfiguration(input: unknown): RemotePreparedGitConfiguration {
  const label = "repository.preparedGitHub";
  const owner = object(input, label);
  closed(
    owner,
    ["issuerEndpoint", "issuerCaPath", "workerCertificatePath", "workerPrivateKeyPath"],
    label,
  );
  const raw = nonempty(owner.issuerEndpoint, label + ".issuerEndpoint");
  const url = new URL(raw);
  if (url.protocol !== "https:" || (raw !== url.origin && raw !== url.origin + "/")) {
    throw new Error(label + ".issuerEndpoint requires a canonical HTTPS origin.");
  }
  return Object.freeze({
    issuerEndpoint: url.origin,
    issuerCaPath: preparedGitFilePath(owner.issuerCaPath, label + ".issuerCaPath"),
    workerCertificatePath: preparedGitFilePath(
      owner.workerCertificatePath,
      label + ".workerCertificatePath",
    ),
    workerPrivateKeyPath: preparedGitFilePath(
      owner.workerPrivateKeyPath,
      label + ".workerPrivateKeyPath",
    ),
  });
}
