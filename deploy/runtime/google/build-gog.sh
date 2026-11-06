#!/usr/bin/env bash
# Build in the verified upstream source directory after applying the OCE transport patch.
set -euo pipefail
export CGO_ENABLED=0 GOOS=linux GOARCH="${1:?target architecture}" GOAMD64=v1 GOARM64=v8.0
export GOWORK=off GOENV=off GOTOOLCHAIN=local GOFLAGS= GOEXPERIMENT= GOFIPS140=off
go build -mod=readonly -trimpath -buildvcs=false \
  -ldflags '-s -w -buildid= -X github.com/openclaw/gogcli/internal/cmd.version=v0.46.0 -X github.com/openclaw/gogcli/internal/cmd.commit=e0e3cb9-oce' \
  -o "${2:?output path}" ./cmd/gog
