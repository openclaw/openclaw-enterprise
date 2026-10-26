# Release

## Overview

Publish OCE container images, Helm charts, and OCC CLI binaries. Complete the
release configuration before dispatching a publication workflow.

## Release guides

| Guide                                          | Purpose                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| [Configuration](configuration.md)              | Set environment policies, registry destinations, credentials, and native runners. |
| [Containers](containers.md)                    | Bootstrap packages, publish images, and recover partial publication.              |
| [Helm chart](chart-publication.md)             | Publish a versioned chart with matching image tags and install it.                |
| [OCC CLI](cli-publication.md)                  | Publish versioned macOS and Linux binaries.                                       |
| [Docker Hub promotion](container-promotion.md) | Copy verified GHCR image digests to private Docker Hub repositories.              |

## Implementation flows

- [Container publication](../flows/container-publication.md)
- [Package bootstrap](../flows/container-package-bootstrap.md)
- [CLI publication](../flows/cli-publication.md)
