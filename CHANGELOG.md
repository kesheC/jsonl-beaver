# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `prepare` script so a checkout builds itself on install.
- `author`, `bugs` and `homepage` fields in `package.json`.

### Changed

- `engines.node` is now `>=20.11` for every release artefact, matching the oldest
  Node version the test matrix exercises.

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

[Unreleased]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/jsonl-beaver/releases/tag/v0.1.0
