# Keep terms, identifiers, and limits precise

Apply this guidance before and after a terminology edit. Read the relevant
source, input validation, and diff before choosing a replacement. Use
ASD-STE100 (Simplified Technical English). Use one name for each concept and
state what an actor reads, changes, starts, or rejects.

## Distinguish names and identities

- Use **version** for a general configuration, deployment, or release version.
  Qualify it when the reader could confuse these meanings.
- Keep an official resource name. **Agent revision** and `AgentRevision` name
  the actual resource and are valid. Do not replace every occurrence of
  `revision` with `version`.
- Use **commit** or **commit SHA** for Git source identity. Keep the source
  commit separate from a package or image's release version. Check what release
  and recovery scripts validate, including whether commits must match or whether
  one can be an ancestor of the other.
- Name a provider's resource version or concurrency token as such. Do not
  describe that token as an Agent version or a release version.
- Preserve API field names, schema keys, routes, operation IDs, enum values,
  permission names, CLI commands and flags, and configuration keys. For example,
  keep `activeRevisionId`, `source_sha`, `vcs.revision`, and `resourceVersion`
  unchanged. Explain them in prose; a wording edit does not authorize a contract
  change.

Replace invented or unclear labels such as “exact-revision,” “admitted revision,”
“active revision,” or “revision ownership” with the actual resource, actor,
action, and condition. An established technical name can remain when it names a
specific concept; define that concept rather than using the name as shorthand
for several meanings.

Keep saved, selected, running, and ready states distinct. A selected Agent
revision or a stored `activeRevisionId` does not prove that its workload is
running or ready. State which source or observation supports each claim.

## Name what the system saves

- Use **Agent revision** for the resource. To explain what it preserves, name
  the value. For example, “Editing the draft does not change the configuration
  saved in an earlier Agent revision.”
- Use **settings saved for a deployment** when describing the values a reader
  can inspect. Name the relevant settings, such as the Harness or Backend ID.
- Use **queued operation** for an item the API enqueues and the worker claims.
  When persistence matters, name the store and transaction. For example,
  “The API saves the Agent revision and queues the deployment in the same
  PostgreSQL transaction.”

## State the constraint

Replace “bounded,” “limited,” “safe,” or “small” when these words hide a
constraint that the reader needs. State:

- The maximum, unit, and scope, such as bytes per file or entries per request.
- The owner that enforces it and any conditions or configuration that change it.
- What happens at the limit, such as rejection, truncation, paging, or expiry.

Distinguish input, retained data, and returned output. A response-size limit does
not establish a storage or retention limit. If source does not establish a
limit, state what is unknown; do not invent a number or promise a guarantee.

## Verify the complete edit

Check surrounding paragraphs and related references, summaries, examples, and
navigation for the same concept. Review each replacement in context, including
release and recovery instructions. Do not use a global replacement as proof
that terminology is correct.

Change generated prose in its owning metadata or generator, then regenerate and
check the outputs. Confirm that only the intended prose or display labels
changed. Compare schemas and other contracts separately to catch an accidental
field, enum, route, default, or behavior change.

Preserve source-backed requirements, permissions, failure paths, historical
specifications, and user-owned Manual Notes. Complete the skill's documentation
checks and report material verification gaps.
