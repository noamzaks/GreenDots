#!/usr/bin/env bash
# Builds the GreenDots RPMs in a Fedora container (FEDORA=44 by default) into packaging/fedora/rpms/, which then
# holds only this build's packages, so `sudo dnf install rpms/*.rpm` installs it (its source package is in rpms/src/).
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
mkdir -p "$out/src"

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
    rm -f /out/*.rpm /out/src/*.rpm
    cp /work/rpmbuild/RPMS/*/*.rpm /out/
    cp /work/rpmbuild/SRPMS/*.src.rpm /out/src/
  "
find "$out" -name '*.rpm'
