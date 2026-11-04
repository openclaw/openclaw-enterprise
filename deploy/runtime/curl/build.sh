#!/bin/sh
set -eu

# TODO: Remove this backport when Bookworm publishes a CVE-2026-86414 fix.
# Keep Debian's ABI, feature selection, security patches, and package ownership.
version=7.88.1-10+deb12u15
mkdir -p /build/curl /out
cd /build/curl
for file in "curl_${version}.dsc" curl_7.88.1.orig.tar.gz curl_7.88.1.orig.tar.gz.asc "curl_${version}.debian.tar.xz"; do
  curl --fail --location --silent --show-error --retry 6 \
    "https://deb.debian.org/debian/pool/main/c/curl/$file" -o "$file"
done
sha256sum --check --strict <<'CHECKSUMS'
2744f12e3aef161c0361743fa1b318296b122e566e47f381e4a63320fbcc23f4  curl_7.88.1-10+deb12u15.dsc
cdb38b72e36bc5d33d5b8810f8018ece1baa29a8f215b4495e495ded82bbf3c7  curl_7.88.1.orig.tar.gz
7a5a55d7123149a1b357f298cf895bd0a601e3a2807005ef6c95f3752803485f  curl_7.88.1.orig.tar.gz.asc
961b78bc48492c5693e4decb352ddd176f343260a8956f48b2887874048ef23b  curl_7.88.1-10+deb12u15.debian.tar.xz
CHECKSUMS

apt-get update
# A newer Debian update may carry fixes absent from these pinned sources.
# Fail rather than silently replace it with an older local backport.
candidate=$(apt-cache policy curl | sed -n 's/^  Candidate: //p')
if [ "$candidate" != "$version" ]; then
  echo "Refresh the curl backport: Debian candidate is $candidate, source is $version" >&2
  exit 1
fi
# The upstream proxy/TLS cases below replace Debian's full multi-protocol suite.
apt-get build-dep -y --no-install-recommends -Pnocheck "./curl_${version}.dsc"
apt-get install -y --no-install-recommends python3 stunnel4
dpkg-source --no-check -x "curl_${version}.dsc" source
cd source
export QUILT_PATCHES=debian/patches
quilt pop -a
cp /tmp/curl/CVE-2026-86414.patch debian/patches/
# Debian copies the tree for each backend while applying its final two patches.
# The security fix must precede both, so it reaches OpenSSL and GnuTLS alike.
sed -i '/^90_gnutls.patch$/i CVE-2026-86414.patch' debian/patches/series
quilt push -a
cat > debian/changelog.oce <<'CHANGELOG'
curl (7.88.1-10+deb12u15+oce1) bookworm; urgency=medium

  * Backport upstream 2956af6c7451029fb12c12f8166dff211f930d52:
    reject origin authentication challenges in HTTP CONNECT responses
    (CVE-2026-86414). Retain Debian's OpenSSL and GnuTLS ABIs.

 -- OpenClaw Enterprise contributors <noreply@openclaw.ai>  Wed, 04 Nov 2026 00:00:00 +0000

CHANGELOG
cat debian/changelog >> debian/changelog.oce
mv debian/changelog.oce debian/changelog
dpkg-buildpackage --build=binary --no-sign --build-profiles=nocheck --jobs=2

for package in curl libcurl4 libcurl3-gnutls; do
  cp "../${package}_${version}+oce1_$(dpkg --print-architecture).deb" /out/
done
sha256sum ../*.dsc ../*.orig.tar.gz ../*.debian.tar.xz /tmp/curl/CVE-2026-86414.patch > /out/source.sha256
cd /out
sha256sum ./*.deb > packages.sha256
