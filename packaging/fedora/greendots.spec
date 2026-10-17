# Build with packaging/fedora/build.sh: %%build downloads the web app's dependencies with bun.
%global app %{_prefix}/lib/greendots

# node_modules is shipped as is: no debuginfo, stripping, shebang mangling or dependency scanning
%global debug_package %{nil}
%global __strip /bin/true
%global __brp_mangle_shebangs_exclude_from ^%{app}/
%global __requires_exclude_from ^%{app}/
%global __provides_exclude_from ^%{app}/

Name:           greendots
Version:        0.2.0
Release:        1.%{?commits}%{!?commits:0}%{?dist}
Summary:        Live pytest matrix viewer
License:        MIT
URL:            https://github.com/noamzaks/GreenDots
Source0:        greendots.tar.gz

BuildRequires:  nodejs >= 22
BuildRequires:  python3-devel
BuildRequires:  pyproject-rpm-macros
BuildRequires:  systemd-rpm-macros
Requires:       nodejs >= 22
%{?systemd_requires}

%description
GreenDots shows pytest runs as a live test matrix: every test is a dot, rows and columns are test parameters, and
dots fill in while the run is going. This package runs the web app as the greendots service on port 7357, reading
runs from /var/opt/greendots2.

%package -n python3-pytest-greendots
Summary:        Pytest plugin that records live test status and complete logs for GreenDots
BuildArch:      noarch

%description -n python3-pytest-greendots
Run pytest with --greendots=<dir> to write a run's plan, live status and complete per-test logs for the GreenDots
viewer.

%prep
%autosetup -c

%generate_buildrequires
cd pytest-greendots
%pyproject_buildrequires

%build
cd web
bun install --frozen-lockfile
NEXT_TELEMETRY_DISABLED=1 bun run build
rm -rf node_modules .next/cache
bun install --frozen-lockfile --production
cd ../pytest-greendots
%pyproject_wheel

%install
install -d %{buildroot}%{app} %{buildroot}%{_bindir}
cp -a web/.next web/bin web/node_modules web/package.json web/next.config.ts %{buildroot}%{app}/
ln -s ../lib/greendots/bin/greendots.mjs %{buildroot}%{_bindir}/greendots
install -Dpm 644 packaging/fedora/config.json %{buildroot}%{_sysconfdir}/greendots/config.json
install -Dpm 644 packaging/fedora/greendots.service %{buildroot}%{_unitdir}/greendots.service
install -Dpm 644 packaging/fedora/greendots.sysusers %{buildroot}%{_sysusersdir}/greendots.conf
install -Dpm 644 packaging/fedora/greendots.tmpfiles %{buildroot}%{_tmpfilesdir}/greendots.conf
install -Dpm 644 packaging/fedora/firewalld.xml %{buildroot}%{_prefix}/lib/firewalld/services/greendots.xml
cd pytest-greendots
%pyproject_install
%pyproject_save_files greendots

%check
cd pytest-greendots
%pyproject_check_import

%post
%tmpfiles_create %{_tmpfilesdir}/greendots.conf
%systemd_post greendots.service

%preun
%systemd_preun greendots.service

%postun
%systemd_postun_with_restart greendots.service

%files
%doc README.md
%{app}
%{_bindir}/greendots
%dir %attr(0755, greendots, greendots) %{_sysconfdir}/greendots
%config(noreplace) %attr(0644, greendots, greendots) %{_sysconfdir}/greendots/config.json
%{_unitdir}/greendots.service
%{_sysusersdir}/greendots.conf
%{_tmpfilesdir}/greendots.conf
%{_prefix}/lib/firewalld/services/greendots.xml

%files -n python3-pytest-greendots -f %{pyproject_files}
%doc pytest-greendots/README.md

%changelog
* Sat Oct 17 2026 Noam Zaks <imnoamzaks@gmail.com> - 0.2.0-1
- Package the web app as a service, and the plugin
