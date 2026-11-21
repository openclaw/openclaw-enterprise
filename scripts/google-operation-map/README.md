# Regenerate the Google operation map

The controller loads the catalog shipped in the Google plugin release. A command can require several Google methods. For example, Gmail message search lists message IDs, looks up label names, and fetches metadata or a full message depending on the flags. The guard authorizes the actual outbound method and its parameters.

## Regeneration

Run on Linux amd64 with Go, Python 3 and the pinned gog executable and source tree. The command verifies the executable against the OCE release and checks the source digest before inspecting the upstream Go module. Go must have network access on the first run or a populated module cache and the appropriate toolchain.

```sh
python3 scripts/google-operation-map/generate.py /path/to/gogcli-0.46.0 /path/to/gog
python3 scripts/google-operation-map/generate.py --check /path/to/gogcli-0.46.0 /path/to/gog
```

The first command writes the catalog and its SHA-256 into the release. The second regenerates it and compares the output with both checked-in files. A gog upgrade requires reviewing the source and binary pins, changes to the hand-coded request cases, and the resulting catalog diff. [Upstream source](https://github.com/openclaw/gogcli/tree/e0e3cb9c80eb4f1fb8051766e52841b8cd7ab965) · [Google SDK Discovery definitions](https://github.com/googleapis/google-api-go-client/tree/0d9c67e59dc9291c6047cea77122907594b10994)

## Catalog coverage

- The generator starts at each command in the binary’s schema, including hidden paths. It follows typed Go function references, runtime service callbacks and local interface implementations to the Google SDK methods reachable across flags and branches. The map records the union of dependencies for a command. It also records the direct HTTP implementations for raw reads, Chat search, batch submission, Photos Library and Photos Picker. Google Sites uses the Drive API.
- Each admitted REST method has its exact origin, HTTP method, path template, query signature, accepted OAuth scopes and applicable JSON request schema. Paths of unused SDK methods are retained as reserved routes so a literal operation cannot be authorized by a neighboring ID template.
- `rest` identifies a mapped REST command. `partial` records commands that also have a known path requiring another transport, such as Docs tab exports and optional image downloads. `unsupported` records commands whose normal operation depends on a different credential, transfer format or service. Binary media uploads use a separate upload URL and body. A media download through an SDK method’s own `alt=media` route is distinct from a download from a URL returned by the provider.
- `local` commands require no Google bearer. `dynamic` commands such as `gog api call` select an operation at runtime and receive only the authority granted for the resulting request. For composite methods, the request guard also checks the submitted body. A command’s presence in the inventory is independent of the attached source’s destination, OAuth scopes and runtime policy.

The map captures the pinned source’s command dependencies. Per-command status describes known wire requirements. Only a test of a real request through an attached source establishes which variants work in a particular installation.
