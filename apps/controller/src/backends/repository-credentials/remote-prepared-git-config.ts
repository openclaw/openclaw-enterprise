import { isAbsolute, resolve } from "node:path";
import { closed, nonempty, object } from "../../composition/installation-fields.ts";

export interface RemotePreparedGitConfiguration {
  readonly issuerEndpoint: string;
  readonly issuerCaPath: string;
  readonly workerCertificatePath: string;
  readonly workerPrivateKeyPath: string;
}

export interface RemotePreparedGitSelection extends RemotePreparedGitConfiguration {
  readonly enrollment: Readonly<{
    namespaceId: string;
    agentId: string;
    servicePrincipalId: string;
  }>;
}

export function preparedGitFilePath(value: unknown, label: string): string {
  const path = nonempty(value, label);
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(label + " requires an absolute mounted-file path.");
  }
  return path;
}

export function remotePreparedGitConfiguration(input: unknown): RemotePreparedGitSelection {
  const label = "repository.preparedGitHub";
  const owner = object(input, label);
  closed(
    owner,
    [
      "issuerEndpoint",
      "issuerCaPath",
      "workerCertificatePath",
      "workerPrivateKeyPath",
      "enrollment",
    ],
    label,
  );
  const enrollmentLabel = label + ".enrollment";
  const enrollment = object(owner.enrollment, enrollmentLabel);
  closed(enrollment, ["namespaceId", "agentId", "servicePrincipalId"], enrollmentLabel);
  const raw = nonempty(owner.issuerEndpoint, label + ".issuerEndpoint");
  const url = new URL(raw);
  if (url.protocol !== "https:" || (raw !== url.origin && raw !== url.origin + "/")) {
    throw new Error(label + ".issuerEndpoint requires a canonical HTTPS origin.");
  }
  return Object.freeze({
    issuerEndpoint: url.origin,
    enrollment: Object.freeze({
      namespaceId: nonempty(enrollment.namespaceId, enrollmentLabel + ".namespaceId"),
      agentId: nonempty(enrollment.agentId, enrollmentLabel + ".agentId"),
      servicePrincipalId: nonempty(
        enrollment.servicePrincipalId,
        enrollmentLabel + ".servicePrincipalId",
      ),
    }),
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
