#!/bin/sh
set -eu
umask 022
mkdir -p /out
set -- /archives/*
[ -f "$1" ] || exit 0

prefix=/opt/devtools
root=/out$prefix
mkdir -p "$root/bin" /out/usr/local/bin
expose() {
  for tool do
    test -x "$root/bin/$tool"
    ln -s "$prefix/bin/$tool" "/out/usr/local/bin/$tool"
  done
}

if [ -f /archives/go.tar.gz ]; then
  # The direct go binary locates its GOROOT relative to its executable path.
  tar --no-same-owner -xzf /archives/go.tar.gz --strip-components=1 -C "$root"
  expose go gofmt
fi
if [ -f /archives/cargo.tar.xz ]; then
  for component in rustc rust-std cargo; do
    stage=$(mktemp -d)
    tar --no-same-owner -xJf "/archives/$component.tar.xz" --strip-components=1 -C "$stage"
    "$stage/install.sh" --prefix="$prefix" --destdir=/out --disable-ldconfig
    rm -rf "$stage"
  done
  expose cargo rustc rustdoc
fi
if [ -f /archives/rustup ]; then
  install -m 0755 /archives/rustup "$root/bin/rustup"
  expose rustup
fi
if [ -f /archives/bun.tgz ]; then
  tar --no-same-owner -xzf /archives/bun.tgz --strip-components=2 -C "$root/bin" package/bin/bun
  expose bun
fi
