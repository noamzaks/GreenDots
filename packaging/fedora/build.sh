#!/usr/bin/env bash
# Builds the GreenDots RPMs in a Fedora container into packaging/fedora/rpms/ (FEDORA=44 by default).
set -euo pipefail
here=$(dirname "$(realpath "$0")")
root=$(realpath "$here/../..")
out=$here/rpms
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# the working tree as it is, without ignored files
git -C "$root" ls-files -co --exclude-standard -z | tar -C "$root" --null -T - -czf "$work/greendots.tar.gz"
cp "$here/greendots.spec" "$work/"
commits=$(git -C "$root" rev-list --count HEAD)
mkdir -p "$out"

podman run --rm --security-opt label=disable -v "$work:/work" -v "$out:/out" \
  "registry.fedoraproject.org/fedora:${FEDORA:-44}" bash -euxc "
    dnf -y -q install rpm-build dnf-plugins-core unzip
    dnf -y -q builddep /work/greendots.spec
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v1.4.2
    define=(--define '_topdir /work/rpmbuild' --define '_sourcedir /work' --define 'commits $commits')
    # resolve the dynamic Python build requirements until there are no more
    until rpmbuild \"\${define[@]}\" -br /work/greendots.spec; do
      dnf -y -q builddep /work/rpmbuild/SRPMS/*.buildreqs.nosrc.rpm
      rm -f /work/rpmbuild/SRPMS/*.buildreqs.nosrc.rpm
    done
    rpmbuild \"\${define[@]}\" -ba /work/greendots.spec
    cp /work/rpmbuild/RPMS/*/*.rpm /work/rpmbuild/SRPMS/*.src.rpm /out/
  "
find "$out" -name '*.rpm'
