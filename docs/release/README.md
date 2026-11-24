# Release

<a id="overview"></a>

## Release guides

- [Publish container images](containers.md#prepare-and-publish)
- [Publish images with the Helm chart](chart-publication.md#publish)
- [Publish the OCC CLI](cli-publication.md#publish)

Other tasks:

- [Configure release access and registries](configuration.md)
- [Check published images before an upgrade](staging-qualification.md): check
  startup or rehearse controller sign-in on a disposable runner.
- [Promote images to private Docker Hub repositories](container-promotion.md#promote)
- [Recover a partial image publication](containers.md#recover-a-partial-publication)

## Implementation flows

- [Container publication](../flows/container-publication.md)
- [Package bootstrap](../flows/container-package-bootstrap.md)
- [CLI publication](../flows/cli-publication.md)
