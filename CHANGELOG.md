# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A misspelled command is reported as a misspelled command.** `jlb bogus` was
  answered with `jlb: bogus: missing <file|-> argument`, which reads as "the
  command is fine, you forgot the operand" and never says the command does not
  exist; the real message only appeared once a file was also supplied. The
  command name is now judged before its arguments.

## [0.1.9] - 2026-11-01

### Added

- **The Chinese README covers the same ground as the English one.** The usage
  section gained the eighteen lines of real `jlb head` output the English text
  already showed, plus the warning against installing from `git+https://` and
  the section separators that were missing. 2,278 CJK characters, up from
  2,093.

### Fixed

- **An option the command never reads is now an error, not a no-op.** Only
  `--limit` was scoped; everything else was accepted and dropped, so
  `stat --where 'status >= 500'` printed the whole file and `head --by level`
  printed the first N records, both with exit 0. A table of what each command
  actually reads now backs the check, and the message names the commands that
  do take the option: `--where is not supported by stat; it applies to filter,
  agg, to-csv and to-jsonl`. `--json` is kept where a branch reads it
  (`stat`; `head`, where it suppresses the stopped-early note; `filter`;
  `agg`) and rejected on `to-csv`/`to-jsonl`, whose row-count footer is
  unconditional. `--version` is a standalone command and is rejected
  everywhere else. `--help` still wins over every other argument.
- **The 0.1.8 entry claimed three guards the old test never had.** None of the
  three was asserted at v0.1.7; they are new, not restored. Version headings
  had no link definitions, so `[0.1.7]` and `[0.1.8]` rendered as literal text,
  and `[Unreleased]` still compared against v0.1.6.

### Changed

- **`--help` lists which commands read each option** instead of leaving it to
  the reader to guess, and the `jlb head` usage line now shows the `--json` it
  has always accepted.

### Quality

- 164 tests across 9 spec files, 2,568 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

## [0.1.8] - 2026-11-01

### Added

- **The release gates are executed, not spell-checked.** `tests/workflow.test.ts`
  used to assert that certain strings appeared in `release.yml` and `ci.yml`.
  Each guard's own shell body is now cut out of the workflow and run against
  throwaway fixtures -- the tag gate against matching, drifted, non-semver and
  prerelease tags; the package-contents assertion against a complete manifest,
  a stray `.js.map`, a tarball with no `dist/` at all, and a leaked `src/`.
  21 cases, up from 13.
- **Three guards the old test did not have.** The release is re-published with
  `gh release edit --draft=false` before any upload, the `jlb` bin is smoke
  tested from the installed package, and the build clears `dist/` before
  compiling -- none of the three was asserted at v0.1.7.

## [0.1.7] - 2026-11-01

### Fixed

- **`-o` no longer truncates an existing file on a rejected run.** The output
  sink wrote straight to the target, so a run that failed halfway had already
  destroyed what was there. It now writes a temp file and renames on success,
  and writing over the input file is refused outright.
- **A closed stderr pipe no longer kills the run.** `jlb to-csv ... 2>&1 |
  head -2` turned stderr writes into an unhandled `EPIPE` event, terminating
  the process before `commit()` — a false non-zero exit plus a stray
  `.jlb-tmp`. The guard is now on both pipes: stdout ends the run successfully
  (the reader has what it asked for), stderr is logging and is swallowed.
- **Temp files survive a hard kill.** A registry removes them on SIGINT and
  SIGTERM, and because Windows kills a process without running JavaScript, the
  next run sweeps leftovers whose owning pid is gone.
- **Arguments are validated before the input is opened.** `--limit` scope,
  `--top >= 1`, required `--fields`/`--where`, and one agg metric at a time all
  fail as exit 2 with one line, not as a Node stack after the file was read.
- **`--fields` is validated by the same path parser `--by` uses**, and a bad
  `--by` is exit 2 instead of an uncaught error with exit 1.
- **Prototype-named fields no longer leak.** Field lookup uses
  `Object.hasOwn`, so `filter --where constructor` stopped matching every
  record and `agg --by` no longer crashes on a prototype key.
- **Malformed-line reports name the physical line** and only claim 'skipping'
  when `--skip-invalid` is actually on.
- **`-o` trims surrounding whitespace**, so it cannot miss the self-overwrite
  guard or create a sibling file ending in a space.

### Changed

- **The tarball no longer ships dead sourcemaps.** `sourceMap` and
  `declarationMap` are off in `tsconfig.build.json`; the maps had no
  `sourcesContent` and pointed at `src/*.ts`, which `files` does not publish,
  so every one was a dead link: 33 to 23 entries, 213,298 to 137,519 bytes
  unpacked.
- **Every README example is reproducible from a fresh clone.** The pipe and
  self-overwrite examples referenced `d.jsonl` / `half.jsonl` / `data.jsonl`,
  which the repo never ships; they now derive from `demo/access.jsonl` with the
  fixture-creating line shown inline, and the malformed-line sections gained
  the `printf` that writes the bad file.
- The benchmark row and the rough edges of `--sum`, `p95` and `-o` are
  documented: `--sum` ignores non-numeric values instead of counting them as
  zero, `p95` beyond the 4,096-observation reservoir can be a fraction of a
  percent off, the CLI writes LF while the `toCsv` helper defaults to CRLF,
  and `--limit` applies only to the three commands that use it.
- `--fields` treats a doubled or trailing comma as a mistyped list and drops
  the empty segment, in the source and in both README languages.

### Security

- The release job refuses to publish when the tag and `package.json`
  disagree, and CI now parses `npm pack --dry-run --json` to assert the dist
  entry points, no leaked `tests/`/`src/`/`node_modules/` prefixes and no
  `.js.map`, then imports the installed package and checks its exports.

## [0.1.6] - 2026-11-01

### Fixed

- **The README claimed the npm name was taken.** It said the `jsonl-beaver` name on npm belonged to an unrelated package. It does not: `npm view jsonl-beaver` returns 404, the name is unregistered. The README now says this project has no publishing credentials yet, instead of blaming a squatter.

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

[Unreleased]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kesheC/jsonl-beaver/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/jsonl-beaver/releases/tag/v0.1.0