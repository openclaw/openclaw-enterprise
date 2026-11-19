import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeDumpRows } from "../helpers/postgres-dump.ts";

// Synthetic COPY text tests the snapshot comparator, not PostgreSQL persistence.
// The separate-migration k3d test applies it to complete, real pg_dump output.
const prefix = `-- PostgreSQL database dump
SET statement_timeout = 0;
CREATE TABLE public.sample (id text, payload text);
COPY public.sample (id, payload) FROM stdin;
`;
const suffix = `\\.
COPY public.empty_sample (id) FROM stdin;
\\.
COPY public.other_sample (id) FROM stdin;
x
y
\\.
-- PostgreSQL database dump complete
`;
const canonical = `${prefix}a\tmême
a\tmême
b\tline\\nsecond\\tfield
c\t2026-11-18 20:00:00+00
d\t\\N
${suffix}`;

test("database snapshots ignore only COPY row ordering", () => {
  const reordered = `${prefix}d\t\\N
b\tline\\nsecond\\tfield
a\tmême
c\t2026-11-18 20:00:00+00
a\tmême
${suffix.replace("x\ny\n", "y\nx\n")}`;
  assert.equal(canonicalizeDumpRows(reordered), canonical);
  assert.equal(canonicalizeDumpRows(canonical), canonical);
});

test("database snapshots retain values, duplicates, headers and non-COPY bytes", () => {
  const changes = {
    "changed value": canonical.replace("même", "different"),
    "removed duplicate": canonical.replace("a\tmême\n", ""),
    "added duplicate": canonical.replace("a\tmême\n", "a\tmême\na\tmême\n"),
    "null changed to empty": canonical.replace("d\t\\N", "d\t"),
    "changed timestamp": canonical.replace("20:00:00+00", "20:00:01+00"),
    "changed column order": canonical.replace("(id, payload)", "(payload, id)"),
    "changed table": canonical.replace("COPY public.sample", "COPY public.renamed"),
    "removed empty table": canonical.replace(
      "COPY public.empty_sample (id) FROM stdin;\n\\.\n",
      "",
    ),
    "changed schema": canonical.replace("payload text", "payload varchar(255)"),
    "changed non-COPY statement": canonical.replace(
      "statement_timeout = 0",
      "statement_timeout = 1",
    ),
  };
  for (const [name, changed] of Object.entries(changes)) {
    assert.notEqual(canonicalizeDumpRows(changed), canonical, name);
  }
});
