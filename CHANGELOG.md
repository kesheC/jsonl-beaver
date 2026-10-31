# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-11-01

### Changed

- **The release page now explains the release.** The workflow used to publish a body containing only a compare link, so the one page a prospective user lands on said nothing about what changed. The body is now the `CHANGELOG.md` section for the tag, and a tag with no written section fails the job instead of shipping an empty release.

## [0.1.4] - 2026-11-01

### Changed

- The install section documents the `jsonl-beaver.tgz.sha256` checksum every release publishes, so a download can be verified before it is executed.

## [0.1.3] - 2026-11-01

### Changed

- **CI and the release job now assert the version the binary prints**, not just
  that it exited 0. A broken entry guard can make a CLI exit 0 having printed
  nothing, and the old step passed anyway. This package's entry point never had
  that bug, but the assertion is what would catch it if it appeared.

## [0.1.2] - 2026-11-01

### Changed

- **CI runs every Node version the package claims to support.** The matrix was
  Node 20 and 22; it is now 20, 22 and 24. The floor still matches `engines`,
  and 24 is the current active LTS.
- **CI now installs the packed tarball and runs the binary from it.** Tests
  prove the source compiles; this proves the thing users download works.
- GitHub Actions moved from `checkout@v4` / `setup-node@v4` to `v5`, which runs
  on Node 24 and clears the Node 20 deprecation warning on every job.
- The README install commands point at
  `releases/latest/download/NAME.tgz` instead of a version-pinned URL, so the
  documented command keeps working across releases. Each release now uploads a
  stable-named copy next to the versioned tarball.

## [0.1.1] - 2026-10-31

### Fixed

- **Install instructions that could not work.** The README told you to run
  `npm install -g github:kesheC/jsonl-beaver`, which resolves to an SSH URL, and in
  the case of `jsonl-beaver` also implied an npm registry package that does not exist.
  Both paths are gone. The documented install path is now the release tarball,
  which is built, smoke-tested and uploaded by CI on every tag.

### Added

- `.github/workflows/release.yml`: on a `v*` tag, build, test, `npm pack`, install
  the resulting tarball in a clean directory, run the packaged binary, then upload
  the tarball and its `.sha256` to the GitHub Release.
- `SECURITY.md` with a supported-versions table, a private reporting channel and an
  explicit in-scope / out-of-scope list.
- `prepack` script, so `npm pack` always ships a freshly built `dist/`.
- `author`, `bugs` and `homepage` fields in `package.json`.

### Changed

- `engines.node` is now `>=20.11` for every release artefact, matching the oldest
  Node version the test matrix exercises.
- The build hook moved from `prepare` to `prepack`. `prepare` ran on every
  consumer's machine during install — where `devDependencies` are absent — and npm
  11 warns loudly about unreviewed install scripts, so the documented install path
  printed a warning for no benefit. The tarball now ships a prebuilt `dist/`.

### Removed

- npm registry badges and `npm install -D jsonl-beaver` snippets that pointed at an
  unrelated (or non-existent) registry package.

## [0.1.0] - 2026-10-29

### Added

- Initial release: Streaming JSONL log analytics for gigabyte NDJSON logs.

- `jlb stat` summarises a JSONL stream: line count, field coverage, types, min/max, and invalid-line counts.
- `jlb head` prints the first N records; `jlb filter` evaluates a `--where` predicate without loading the file.
- `jlb agg` groups and counts by field with `--top`.
- `jlb to-csv` and `jlb to-jsonl` convert between formats with a stable, ordered column set.
- Streaming line reader with a bounded buffer, so a 5 GB log is processed in constant memory.
- `--skip-invalid` for dirty logs, `--json` for machine output, `--progress` for long runs.

### Quality

- 97 tests across 6 spec files, 2032 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

[Unreleased]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/jsonl-beaver/releases/tag/v0.1.0