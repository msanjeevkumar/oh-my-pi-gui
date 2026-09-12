# Fedora release readiness — `FEDORA-RELEASE-READY`

## Purpose

Make `omp GUI` installable and supportable on Fedora x86_64, beginning with a reproducible Linux release artifact. Later work may fix product bugs and add features; those are separate milestones after Fedora release readiness.

## Current state

- GUI fork: `msanjeevkumar/oh-my-pi-gui`, checked out at `packages/gui/`.
- Sidecar source fork: `msanjeevkumar/oh-my-pi`, checked out at the enclosing repository root.
- Both forks track their `nornzach/*` parents as `upstream`; `origin` is the `msanjeevkumar` fork.
- Fedora 44 x86_64 successfully built the GUI renderer and a bundled Linux OMP sidecar from the paired source tree.
- An unpacked Electron build launched on Fedora with `--no-sandbox`; the bundled sidecar and stats server started.

## Evidence

Observed on 2026-09-12 using GUI commit `67c3f3a`:

1. `bun run build:omp` built an ELF Linux x86_64 sidecar from the paired OMP fork.
2. `bun run build` completed.
3. `electron-builder --linux` produced an AppImage before `.deb` packaging stopped.
4. The built GUI window opened and spawned its bundled sidecar.

## Fedora release blockers

1. `package:linux` cannot resolve Electron from the range `^35.0.0`; electron-builder requires a fixed version or explicit `electronVersion`.
2. electron-builder derives an invalid Linux executable name from package name `@oh-my-pi/omp-gui`; Linux configuration must set a safe executable name.
3. `.deb` creation requires package `author.email` or a Linux maintainer value.
4. GitHub releases do not include `latest-linux.yml`, so the installed GUI updater receives a 404.
5. The current Linux launcher requires `--no-sandbox` on this Fedora environment. Determine whether a correctly configured Chromium sandbox can remove that flag before shipping.

## Scope

- Build and publish a Fedora-compatible x86_64 artifact.
- Make Linux packaging deterministic from the documented nested checkout.
- Provide desktop integration and a smoke-tested install path.
- Ensure the packaged GUI uses its bundled OMP sidecar, not the system `omp` executable.

## Non-goals

- Change OMP agent behavior or protocol solely to support an older system-installed `omp`.
- Add unrelated product features before Fedora artifact installation is reliable.
- Publish a release, tag, or GitHub release without separate explicit approval.

## Invariants

- `packages/gui/` is its own repository; GUI commits go only to its own `origin`.
- The enclosing OMP repository supplies the sidecar build source; agent-source changes belong there.
- A packaged GUI must contain a matching bundled Linux sidecar.
- Linux artifacts must work without a preinstalled system OMP, Bun, or Node.
- The updater must not advertise an artifact format that the repository does not publish.

## Milestones

- [x] Fork and clone paired repositories in the required nested layout.
- [x] Characterize Fedora x86_64 build, packaging, and launch behavior.
- [ ] Make AppImage packaging reproducible without command-line configuration overrides.
- [ ] Decide and implement `.deb` support, including maintainer metadata, or remove `.deb` from the release contract.
- [ ] Provide Linux release metadata and validate updater behavior.
- [ ] Run clean Fedora installation smoke test from the released artifact.
- [ ] Publish a Fedora release after explicit approval.
- [ ] Begin separately approved bug-fix and feature milestones.

## Validation record

- Fedora 44 x86_64: bundled sidecar build succeeded.
- Fedora 44 x86_64: renderer build succeeded.
- Fedora 44 x86_64: AppImage was produced after overriding electron-builder's Electron version and executable name.
- Fedora 44 x86_64: full `.deb` target failed because maintainer email is absent.
- Fedora 44 x86_64: unpacked application launched and opened a native window; bundled sidecar and stats server started.

## Rollback and recovery

No release has been published. Local development changes should remain in the GUI repository except when rebuilding or changing the paired OMP sidecar source. Remove generated `resources/omp*` artifacts rather than committing them.

## Decisions

- 2026-09-12: Maintain both paired forks under `msanjeevkumar`; the GUI needs the OMP fork to build its bundled sidecar.
- 2026-09-12: Treat a self-contained AppImage as the first Fedora artifact; `.deb` is not yet a working release target.

## Blocker

No current blocker. The next work is a source-level packaging configuration change after inspecting Linux release conventions and deciding the intended artifact set.

## Exact next action

Inspect `package.json` and `electron-builder.yml` against the current Electron Builder Linux requirements, then make the smallest source change that lets `bun run package:linux` finish its AppImage target without overrides.
