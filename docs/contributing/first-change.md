# Make your first platform change

Make a small edit to the OpenClaw Control Plane (OCC) CLI, then run it and see
the result. This example does not need a running controller, database, or account.
Run the commands from the repository root. For changes that need a running
platform, see [Local development](local-development.md).

## 1. Prepare a checkout

You need Git, Node.js 24.22.1 or newer, the pnpm
version pinned in [`package.json`](../../package.json), and Go 1.27 as selected by
[`go.mod`](../../go.mod). If you do not have a checkout yet:

```sh
git clone https://github.com/openclaw/openclaw-enterprise.git
cd openclaw-enterprise
```

Start from an up-to-date `main` in your own clean checkout:

```sh
git switch main
git pull --ff-only
git switch -c chore/first-platform-change
pnpm install --frozen-lockfile
```

Use a branch name allowed by your repository access, and choose a new name if
that branch already exists. Installation also sets up
the repository's pre-push hook; if a custom hook already exists or other work is
using the same dependencies, follow the [contribution policy](../../CONTRIBUTING.md#set-up-a-development-checkout).
The first Go command may download the Go toolchain or module dependencies.

## 2. Edit and run the CLI

Run the existing command:

```sh
go run ./cmd/occ --help
```

Its first line is `Manage OpenClaw Control Plane resources`. In
[`internal/occcli/cli.go`](../../internal/occcli/cli.go), find that `Short` value
in `New` and change it to:

```go
Short: "Manage OpenClaw Control Plane (OCC) resources",
```

Run `go run ./cmd/occ --help` again. The first line should now read
`Manage OpenClaw Control Plane (OCC) resources`; the command and flag lists
should still appear below it. Help is generated locally, so it does not contact
a platform installation.

## 3. Check the change

```sh
gofmt -d internal/occcli/cli.go
pnpm cli:check
git diff --check
```

`gofmt -d` and `git diff --check` should print nothing. `pnpm cli:check` should
exit successfully; it checks Go formatting and runs `go vet`. Review the patch
with `git diff`. If formatting differs, run `gofmt -w internal/occcli/cli.go` and
repeat the checks. If the help output still shows the old text, check that you
saved the `Short` value in the root `New` command, then rerun it from this checkout.

For a real change, choose checks for the code you touched: see [local checks](../testing/local.md)
and [integration tests](../testing/README.md#integration-tests). New platform
functionality requires integration coverage through its actual workflow; this
help-text exercise does not use a live service. Documentation changes use the
[documentation checks](documentation.md#preview-and-check). Before opening a
pull request, follow the [contribution policy](../../CONTRIBUTING.md#prepare-a-pull-request)
and describe the change and what you ran.
