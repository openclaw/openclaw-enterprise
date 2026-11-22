import { isAbsolute } from "node:path";
import { object, closed, nonempty } from "../../../../composition/installation-fields.ts";

/** Mounted key locations are configuration; key bytes stay with the credential owner. */
export function preparedGitHubConfiguration(input: unknown, repository: boolean) {
  const label = repository ? "repository.preparedGitHub" : "preparedGitHub";
  const owner = object(input, label);
  closed(
    owner,
    [
      "custodyKeyPath",
      ...(repository ? ["privateKeyPath", "tokenPath"] : []),
      "apiOrigin",
      "issuerCaPath",
    ],
    label,
  );
  // One repository authority per Installation: the App key or one token Secret, never both.
  if (repository && (owner.privateKeyPath === undefined) === (owner.tokenPath === undefined)) {
    throw new Error(label + " requires exactly one of privateKeyPath and tokenPath.");
  }
  const privatePath = (key: string): string => {
    const path = nonempty(owner[key], label + "." + key);
    if (!isAbsolute(path)) {
      throw new Error(label + "." + key + " requires an absolute mounted-file path.");
    }
    return path;
  };
  return Object.freeze({
    custodyKeyPath: privatePath("custodyKeyPath"),
    ...(repository && owner.privateKeyPath !== undefined
      ? { privateKeyPath: privatePath("privateKeyPath") }
      : {}),
    ...(repository && owner.tokenPath !== undefined ? { tokenPath: privatePath("tokenPath") } : {}),
    ...(owner.apiOrigin === undefined
      ? {}
      : { apiOrigin: nonempty(owner.apiOrigin, label + ".apiOrigin") }),
    ...(owner.issuerCaPath === undefined ? {} : { issuerCaPath: privatePath("issuerCaPath") }),
  });
}
