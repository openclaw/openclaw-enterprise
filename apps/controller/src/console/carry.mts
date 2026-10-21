// Edits carried through a save conflict are applied over the settings Reload draft rereads, so
// another browser's save stands except where the reader changed the same thing (findings 1509
// and 1512). `base` is what the reader's editor first showed, `mine` what they left in it, and
// `current` what the reread found.

type RecordValue = Record<string, unknown>;
type Conflict = { path: string; saved: unknown };

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function sameValue(left: unknown, right: unknown): boolean {
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
export function carryList<T>(base: readonly T[], mine: readonly T[], current: readonly T[]) {
  const removed = base.filter((item) => !mine.includes(item) && current.includes(item));
  const added = mine.filter((item) => !base.includes(item) && !current.includes(item));
  const value = [...current.filter((item) => !removed.includes(item)), ...added];
  return { value, added, removed };
}

// One value the reader changed. It is reapplied as is when the reread still holds what the
// reader first saw; otherwise both browsers changed it, and the caller shows the saved one too.
export function carryValue<T>(base: T, mine: T, current: T) {
  return {
    value: mine,
    conflict: !sameValue(current, base) && !sameValue(current, mine),
  };
}

// A JSON document merges key by key: keys the reader did not change keep the reread value, and
// a value both browsers changed differently keeps the reader's, listed with the saved value.
// Arrays are single values: merging their items could reorder or duplicate entries. `mixed`
// names each object below the top level where the reader changed some keys and the other
// browser others, since such keys may belong together (`auth.mode` and `auth.token`): the
// merge keeps both, and the reader is asked to review the object (finding 1524).
export function carryDocument(
  base: unknown,
  mine: unknown,
  current: unknown,
  path = "",
): { value: unknown; conflicts: Conflict[]; mixed: string[] } {
  if (sameValue(mine, base)) {
    return { value: current, conflicts: [], mixed: [] };
  }
  if (sameValue(current, base) || sameValue(current, mine)) {
    return { value: mine, conflicts: [], mixed: [] };
  }
  if (!isRecord(base) || !isRecord(mine) || !isRecord(current)) {
    return { value: mine, conflicts: [{ path: path || "/", saved: current }], mixed: [] };
  }
  const entries: [string, unknown][] = [];
  const conflicts: Conflict[] = [];
  const mixed: string[] = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(mine), ...Object.keys(base)]);
  const own = (record: RecordValue, key: string) =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  // Keys each browser changed that the other side does not already hold.
  const changedBy = (side: RecordValue, other: RecordValue) =>
    [...keys].filter(
      (key) =>
        !sameValue(own(side, key), own(base, key)) && !sameValue(own(side, key), own(other, key)),
    );
  const mineKeys = changedBy(mine, current);
  const theirKeys = changedBy(current, mine);
  // An object whose changed keys all hold objects only groups them (`channels.slack` and
  // `channels.discord`); the recursion names any of those that mix.
  const grouping = [...mineKeys, ...theirKeys].every((key) =>
    [base, mine, current].every((side) => own(side, key) === undefined || isRecord(own(side, key))),
  );
  // A key that holds an object on every side is the recursion's to name, so it does not mix
  // with a plain sibling: `gateway.auth.mode` against `gateway.port` names nothing (finding 1541).
  // An object one browser added still counts as plain, since an added `auth.token` reference
  // beside a changed `auth.mode` is the pair finding 1524 must name.
  const plain = (key: string) =>
    [base, mine, current].some((side) => {
      const value = own(side, key);
      // A Secret reference is a setting, even though its JSON value is an object.
      return !isRecord(value) || (value.source === "env" && typeof value.id === "string");
    });
  const minePlain = mineKeys.filter(plain);
  const theirPlain = theirKeys.filter(plain);
  if (path && !grouping && minePlain.length && theirPlain.some((key) => !minePlain.includes(key))) {
    mixed.push(path);
  }
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
    mixed.push(...merged.mixed);
  }
  // fromEntries defines own keys, so a "__proto__" key in the document stays a key.
  return { value: Object.fromEntries(entries), conflicts, mixed };
}
