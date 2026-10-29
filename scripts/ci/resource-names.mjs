import { randomUUID } from "node:crypto";

export function randomSuffix() {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

export function slug(value, separator = "-") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

export function ownedName(
  prefix,
  label,
  { maxLength = 63, separator = "-", fallbackLabel = "resource" } = {},
) {
  const suffix = randomSuffix();
  const normalizedPrefix = slug(prefix, separator);
  const normalizedLabel = slug(label, separator) || fallbackLabel;
  const fixedLength = normalizedPrefix.length + suffix.length + 2;
  const labelLength = Math.max(1, maxLength - fixedLength);
  return [normalizedPrefix, normalizedLabel.slice(0, labelLength), suffix].join(separator);
}
