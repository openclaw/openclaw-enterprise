// Edits carried through a save conflict are applied over the settings Reload draft rereads, so
// another browser's save stands except where the reader changed the same thing (findings 1509
// and 1512). `base` is what the reader's editor first showed, `mine` what they left in it, and
// `current` what the reread found.

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

// A list carries the entries the reader added and removed, not the whole list: entries another
// browser added stay, and ones it removed are not put back. `added` and `removed` name only the
// entries that change the reread list.
export function carryList(base, mine, current) {
  const removed = base.filter((item) => !mine.includes(item) && current.includes(item));
  const added = mine.filter((item) => !base.includes(item) && !current.includes(item));
  const value = [...current.filter((item) => !removed.includes(item)), ...added];
  return { value, added, removed };
}

// One value the reader changed. It is reapplied as is when the reread still holds what the
// reader first saw; otherwise both browsers changed it, and the caller shows the saved one too.
export function carryValue(base, mine, current) {
  return {
    value: mine,
    conflict: !sameValue(current, base) && !sameValue(current, mine),
  };
}

// A JSON document merges key by key: keys the reader did not change keep the reread value, and
// a value both browsers changed differently keeps the reader's, listed with the saved value.
// Arrays are single values: merging their items could reorder or duplicate entries.
export function carryDocument(base, mine, current, path = "") {
  if (sameValue(mine, base)) {
    return { value: current, conflicts: [] };
  }
  if (sameValue(current, base) || sameValue(current, mine)) {
    return { value: mine, conflicts: [] };
  }
  if (!isRecord(base) || !isRecord(mine) || !isRecord(current)) {
    return { value: mine, conflicts: [{ path: path || "/", saved: current }] };
  }
  const entries = [];
  const conflicts = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(mine), ...Object.keys(base)]);
  const own = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined);
  for (const key of keys) {
    const merged = carryDocument(
      own(base, key),
      own(mine, key),
      own(current, key),
      `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    );
    if (merged.value !== undefined) {
      entries.push([key, merged.value]);
    }
    conflicts.push(...merged.conflicts);
  }
  // fromEntries defines own keys, so a "__proto__" key in the document stays a key.
  return { value: Object.fromEntries(entries), conflicts };
}
