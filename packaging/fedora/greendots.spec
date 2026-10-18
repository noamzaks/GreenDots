# Build with packaging/fedora/build.sh: %%build downloads the web app's dependencies with bun.
%global app %{_prefix}/lib/greendots

# node_modules is shipped as is: no debuginfo, stripping, shebang mangling or dependency scanning
%global debug_package %{nil}
%global __strip /bin/true
%global __brp_mangle_shebangs_exclude_from ^%{app}/
%global __requires_exclude_from ^%{app}/
%global __provides_exclude_from ^%{app}/

Name:           greendots
Version:        0.3.0
Release:        1.%{?commits}%{!?commits:0}%{?dist}
Summary:        Live pytest matrix viewer
License:        MIT
URL:            https://github.com/noamzaks/GreenDots
Source0:        greendots.tar.gz

BuildRequires:  nodejs >= 22
BuildRequires:  python3-devel
BuildRequires:  pyproject-rpm-macros
BuildRequires:  python3-pytest
BuildRequires:  systemd-rpm-macros
BuildRequires:  firewalld-filesystem
Requires:       nodejs >= 22
%{?systemd_requires}
Requires(post): firewalld-filesystem

%description
GreenDots shows pytest runs as a live test matrix: every test is a dot, rows and columns are test parameters, and
dots fill in while the run is going. This package runs the web app as the greendots service on port 7357, reading
runs from /var/opt/greendots2.

%package -n python3-greendots
Summary:        The files GreenDots runs are made of: typed models and layout
BuildArch:      noarch

%description -n python3-greendots
Typed models of a GreenDots run's plan, status streams and logs, and their layout, shared by the plugin and the
client (greendots.core).

%package -n python3-pytest-greendots
Summary:        Pytest plugin that records live test status and complete logs for GreenDots
BuildArch:      noarch

%description -n python3-pytest-greendots
Run pytest with --greendots=<dir> to write a run's plan, live status and complete per-test logs for the GreenDots
viewer (greendots.plugin).

%package -n python3-greendots-client
Summary:        Read GreenDots runs from Python
BuildArch:      noarch

%description -n python3-greendots-client
List a project's runs, get a test's result, read or follow its log, or wait for a run to finish
(greendots.client).

%prep
%autosetup -c

%generate_buildrequires
# build tools only: the packages need each other, which these subpackages provide
for package in greendots pytest-greendots greendots-client; do
  cd $package
  %pyproject_buildrequires -R
  cd ..
done

%build
cd web
bun install --frozen-lockfile
NEXT_TELEMETRY_DISABLED=1 bun run build
rm -rf node_modules .next/cache
bun install --frozen-lockfile --production
cd ..
for package in greendots pytest-greendots greendots-client; do
  cd $package
  %pyproject_wheel
  cd ..
done

%install
install -d %{buildroot}%{app} %{buildroot}%{_bindir}
cp -a web/.next web/bin web/node_modules web/package.json web/next.config.ts %{buildroot}%{app}/
ln -s ../lib/greendots/bin/greendots.mjs %{buildroot}%{_bindir}/greendots
install -Dpm 644 packaging/fedora/config.json %{buildroot}%{_sysconfdir}/greendots/config.json
install -Dpm 644 packaging/fedora/greendots.service %{buildroot}%{_unitdir}/greendots.service
install -Dpm 644 packaging/fedora/greendots.sysusers %{buildroot}%{_sysusersdir}/greendots.conf
install -Dpm 644 packaging/fedora/greendots.tmpfiles %{buildroot}%{_tmpfilesdir}/greendots.conf
install -Dpm 644 packaging/fedora/firewalld.xml %{buildroot}%{_prefix}/lib/firewalld/services/greendots.xml
%pyproject_install

%check
%py3_check_import greendots.core greendots.plugin greendots.client

%post
%tmpfiles_create %{_tmpfilesdir}/greendots.conf
%systemd_post greendots.service
%firewalld_reload

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

%files -n python3-greendots
%doc greendots/README.md
%dir %{python3_sitelib}/greendots
%{python3_sitelib}/greendots/core
%{python3_sitelib}/greendots-%{version}.dist-info

%files -n python3-pytest-greendots
%doc pytest-greendots/README.md
%{python3_sitelib}/greendots/plugin
%{python3_sitelib}/pytest_greendots-%{version}.dist-info

%files -n python3-greendots-client
%doc greendots-client/README.md
%{python3_sitelib}/greendots/client
%{python3_sitelib}/greendots_client-%{version}.dist-info

%changelog
* Sun Oct 18 2026 Noam Zaks <imnoamzaks@gmail.com> - 0.3.0-1
- Split the plugin's file models into python3-greendots, and add python3-greendots-client

* Sat Oct 17 2026 Noam Zaks <imnoamzaks@gmail.com> - 0.2.0-1
- Package the web app as a service, and the plugin
