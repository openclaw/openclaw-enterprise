// Node exposes require.resolve with an arbitrary parent, but import.meta.resolve's
// parent argument still requires an experimental flag. This bounded compatibility
// layer selects workspace ESM export URLs only; it does not resolve files.
// https://nodejs.org/api/esm.html#resolution-algorithm-specification
export function selectPackageExport(exports, subpath, conditions) {
  function invalid() {
    throw new Error("Invalid or unsupported package export target.");
  }
  function target(value, wildcard) {
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      if (!value.startsWith("./")) {
        return invalid();
      }
      const selected = wildcard === undefined ? value : value.replaceAll("*", wildcard);
      let decoded;
      try {
        decoded = decodeURIComponent(selected);
      } catch {
        return invalid();
      }
      if (
        /%2f|%5c/i.test(selected) ||
        decoded.includes("\\") ||
        decoded
          .slice(2)
          .split(/[/?#]/)
          .some((part) => ["..", ".", "node_modules"].includes(part))
      ) {
        return invalid();
      }
      return selected;
    }
    if (Array.isArray(value)) {
      let lastError;
      for (const item of value) {
        try {
          const result = target(item, wildcard);
          if (result !== undefined && result !== null) {
            return result;
          }
          if (result === null) {
            lastError = undefined;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) {
        throw lastError;
      }
      return null;
    }
    if (!value || typeof value !== "object") {
      return invalid();
    }
    if (Object.keys(value).some((key) => key.startsWith(".") || /^(0|[1-9][0-9]*)$/.test(key))) {
      return invalid();
    }
    for (const [condition, branch] of Object.entries(value)) {
      if (condition === "default" || conditions.has(condition)) {
        const selected = target(branch, wildcard);
        if (selected !== undefined) {
          return selected;
        }
      }
    }
    return undefined;
  }
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const keys = Object.keys(exports);
    const paths = keys.filter((key) => key.startsWith("."));
    if (paths.length && paths.length !== keys.length) {
      return invalid();
    }
    if (paths.length) {
      if (Object.hasOwn(exports, subpath) && !subpath.includes("*") && !subpath.endsWith("/")) {
        return target(exports[subpath]);
      }
      const patterns = paths
        .filter((key) => key.includes("*") && key.indexOf("*") === key.lastIndexOf("*"))
        .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
      for (const pattern of patterns) {
        const [prefix, suffix] = pattern.split("*");
        if (
          subpath.startsWith(prefix) &&
          subpath.endsWith(suffix) &&
          subpath.length >= pattern.length
        ) {
          return target(
            exports[pattern],
            subpath.slice(prefix.length, subpath.length - suffix.length),
          );
        }
      }
      return undefined;
    }
  }
  return subpath === "." ? target(exports) : undefined;
}
