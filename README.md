# jsonl-beaver

**Stream gigabytes of JSONL logs without writing another throwaway `jq` pipeline.**
**几个 G 的 JSONL 日志，不用再写一次性的 jq 管道。**

[![CI](https://github.com/kesheC/jsonl-beaver/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/jsonl-beaver/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kesheC/jsonl-beaver?color=blue)](https://github.com/kesheC/jsonl-beaver/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](#faq--boundaries)

---

## The problem

Production logs and event streams are NDJSON, and they are measured in gigabytes.
With `jq` you either write an unreadable one-liner or `grep` first and hope. With
Python you write a script that you throw away tomorrow. With a spreadsheet you
run out of memory at 50 MB.

What you actually want is a tool that **streams**, keeps **bounded memory**, and
lets you filter and aggregate in one shot. That is `jlb`.

---

## Install

`jsonl-beaver` is **not published to the npm registry.** The name is still free;
this project just has no publishing credentials yet. Each release ships a tarball
you can install directly:

```bash
npm install -g https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz
jlb --version
```

Every release publishes the same tarball under a stable name (`jsonl-beaver.tgz`) alongside a
`jsonl-beaver.tgz.sha256` checksum. To verify the download before running it:

```bash
curl -sLO https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz
curl -sLO https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz.sha256
sha256sum -c jsonl-beaver.tgz.sha256          # jsonl-beaver.tgz: OK
npm install -g ./jsonl-beaver.tgz
```

On macOS use `shasum -a 256 -c jsonl-beaver.tgz.sha256` — there is no `sha256sum` by default.

Or build it from a checkout:

```bash
git clone https://github.com/kesheC/jsonl-beaver.git
cd jsonl-beaver
npm ci && npm run build && npm link
```

Requires Node >= 20.11. **Zero runtime dependencies** — everything is built on the
Node standard library.

> Avoid `npm install -g git+https://github.com/...`: the checkout has no build
> output and a global install skips `devDependencies`, so there is no `tsc` to
> build it with.

---

## Quick start (60 seconds)

The repository ships the generator for the access log used throughout this page,
so every output below can be reproduced byte-for-byte:

```bash
git clone https://github.com/kesheC/jsonl-beaver.git
cd jsonl-beaver
npm ci && npm run build && npm link
npm run demo                           # writes demo/access.jsonl
```

Now point `jlb` at it:

```bash
jlb stat demo/access.jsonl
```

That is 20,000 realistic nginx-style access records (4.8 MiB):

```text
Summary
  lines         20,000
  valid         20,000
  invalid       0
  size          4.8 MiB
  fields        10
  max depth     2

Line length (chars)
  p50 252   p95 268   max 278

Top fields (10 of 10)
FIELD       COUNT    RATE  TYPES
─────────  ──────  ──────  ───────────
bytes      20,000  100.0%  number:100%
client_ip  20,000  100.0%  string:100%
dur        20,000  100.0%  number:100%
level      20,000  100.0%  string:100%
method     20,000  100.0%  string:100%
path       20,000  100.0%  string:100%
req        20,000  100.0%  object:100%
status     20,000  100.0%  number:100%
ts         20,000  100.0%  string:100%
upstream   20,000  100.0%  object:100%
```

One pass, no index, no schema, no configuration.

---

## Usage

Every command takes a file path **or `-` for stdin**, and every command is
streaming — you can pipe into `head` and it stops reading.

A command name that does not exist is reported as such, before anything is said
about its arguments — and `--help` does not make it disappear:

```text
$ jlb bogus
jlb: unknown command: bogus (try jlb --help)
$ jlb bogus --help
jlb: unknown command: bogus (try jlb --help)
$ jlb stat
jlb: stat: missing <file|-> argument
$ jlb --versoin
jlb: unknown option: --versoin (try jlb --help)
```

### `jlb stat` — what is in this file?

```bash
jlb stat <file|-> [--top N] [--json] [--skip-invalid]
```

Line count, valid/invalid count, file size, top-30 field presence rate, per-field
type distribution, line-length p50/p95/max, and maximum nesting depth — in a
single pass with memory proportional to the number of distinct fields.

### `jlb head` — the first N records

```bash
jlb head <file|-> [-n 10] [--pretty]
```

```bash
jlb head demo/access.jsonl -n 1 --pretty
```

```json
{
  "ts": "2026-10-01T00:00:00.000Z",
  "level": "info",
  "status": 404,
  "method": "POST",
  "path": "/api/cart",
  "dur": 882,
  "bytes": 26696,
  "client_ip": "10.119.61.141",
  "req": {
    "id": "r000000",
    "ua": "curl/8.4.0"
  },
  "upstream": {
    "host": "api-a",
    "attempts": 1
  }
}
```

It stops reading as soon as N records are emitted, so it is instant on a 1 GB file.

### `jlb filter` — select records with an expression

```bash
jlb filter <file|-> --where "<expr>" [--limit N] [--pretty] [--where-file <f>]
```

```bash
jlb filter demo/access.jsonl --where "status>=500 and dur>500" --limit 2
```

The expression language supports `=` `==` `!=` `>` `>=` `<` `<=` `includes`,
the boolean operators `and` / `or` / `not`, and parentheses:

```text
status>=500
level=error and dur>500
(status = 500 or status = 502) and not cached
path includes "/api/" and user.role = admin
items[0].id = 7
```

Bare words on the right-hand side are string literals, so `level=error` and
`level="error"` are the same thing. Missing fields never throw — they simply do
not match (except `!=`, which is true for an absent field, matching SQL intuition).

A filtered run reports its own cost on stderr:

```text
jlb: 2 matched of 12 scanned
```

### `jlb agg` — group and aggregate

```bash
jlb agg <file|-> [--by <field>] [--count | --sum <f> | --avg <f> | --p95 <f>] \
        [--top 20] [--where "<expr>"] [--json]
```

Status code distribution:

```bash
jlb agg demo/access.jsonl --by status --count
```

```text
STATUS   COUNT
──────  ──────
200     15,005
404      2,122
503        986
500        945
502        942
```

p95 latency per endpoint:

```bash
jlb agg demo/access.jsonl --by path --p95 dur --top 5
```

```text
PATH             COUNT  P95
───────────────  ─────  ───
/api/login       1,453  852
/api/search      1,445  860
/static/app.css  1,445  860
/favicon.ico     1,444  861
/static/app.js   1,444  861

Showing top 5 of 14 groups.
```

Nested paths work as group keys, and `--where` composes:

```bash
jlb agg demo/access.jsonl --by upstream.host --avg dur
```

```text
UPSTREAM.HOST  COUNT     AVG
─────────────  ─────  ──────
api-a          6,844  453.41
api-b          6,652  452.23
api-c          6,504  455.71
```

### `jlb to-csv` / `jlb to-jsonl` — reshape

```bash
jlb to-csv <file|-> --fields a,b.c [--where "<expr>"] [--limit N] [-o out.csv]
jlb to-jsonl <file|-> --fields a,b.c [--where "<expr>"] [--pretty]
```

```bash
jlb to-csv demo/access.jsonl --fields ts,level,status,path --limit 3
```

```text
ts,level,status,path
2026-10-01T00:00:00.000Z,info,404,/api/cart
2026-10-01T00:00:00.400Z,info,200,/api/orders/42/items
2026-10-01T00:00:00.800Z,info,200,/api/cart
```

CSV output is RFC 4180: commas, quotes and newlines are escaped and embedded
quotes are doubled. The CLI writes LF line endings (`od -c` of the output above shows
`a \n 1 \n 2 \n`) so it behaves the same on Windows and on Linux. The library
function `toCsv(fields, rows)` defaults to CRLF per RFC 4180; pass `"\n"` as the third
argument if you want what the CLI emits.

`-o FILE` is written atomically: `jlb` creates a temp file next to the target and
renames it into place only after the command succeeded. A wrong flag, a missing input
or a `--where` that does not compile therefore leaves an existing file untouched —
and `jlb head -o demo/access.jsonl demo/access.jsonl` is refused instead of truncating its own input.
Surrounding whitespace on the `-o` value is trimmed first, so `-o "out.csv "` writes
`out.csv` and still hits the self-overwrite guard.

Because the work goes to a temp file, an interrupted run can leave one behind. `jlb`
tracks every temp file it opens and deletes them on `SIGINT` / `SIGTERM`. Windows
terminates a process without running JavaScript, so for a hard kill the next run with
the same `-o` sweeps any leftover whose owning pid is no longer alive — a temp file
belonging to a concurrently running `jlb` is left strictly alone:

```text
$ touch .out.csv.zzzzz.abc123.jlb-tmp   # pid 60466175 in base36: not running
$ ls -a | grep -c jlb-tmp
1
$ jlb head demo/access.jsonl -n 1 -o out.csv
jlb: stopped after 1 record(s)
$ ls -a | grep -c jlb-tmp
0
```

A consumer that quits early does not turn into a failure either. Piping into `head`
closes the writing side of the pipe; `jlb` treats that as "the reader has what it
wanted", finishes the file it was asked to write, and exits 0:

```text
$ head -n 52 demo/access.jsonl | sed '2s/.*/not json/; 10s/.*/not json either/' > half.jsonl
$ jlb to-csv half.jsonl --fields status --skip-invalid -o out.csv 2>&1 | head -1
jlb: skipping line 2: Unexpected token 'o', "not json" is not valid JSON
$ echo ${PIPESTATUS[0]}   # the writer, not head
0
$ wc -l < out.csv
51
```

### Global options

| Option | Meaning | Commands that read it |
| --- | --- | --- |
| `--skip-invalid` | Skip malformed lines instead of failing on the first one | every command |
| `--progress` | Progress tick on stderr every 1,000,000 lines | every command |
| `--out FILE` | Write output to a file instead of stdout | every command |
| `--quiet` | Suppress the summary footer | every command |
| `--json` | Machine-readable JSON on stdout instead of a table | `stat`, `head`, `filter`, `agg` |
| `--top N` | Rows in the report, must be >= 1 | `stat`, `agg` |
| `--lines N` | Records to print, default 10 | `head` |
| `--limit N` | Stop after N records | `filter`, `to-csv`, `to-jsonl` |
| `--pretty` | Indent the JSON output | `head`, `filter`, `to-jsonl` |
| `--fields a,b.c` | Columns to emit | `to-csv`, `to-jsonl` |
| `--where / --where-file` | Filter expression | `filter`, `agg`, `to-csv`, `to-jsonl` |
| `--by / --count / --sum / --avg / --p95` | The grouping and the metric | `agg` |

Using an option outside its column is exit 2, not a silently ignored flag:

```text
$ jlb stat demo/access.jsonl --where "status>=500"
jlb: --where is not supported by stat; it applies to filter, agg, to-csv and to-jsonl
$ jlb head demo/access.jsonl --top 2
jlb: --top is not supported by head; it applies to stat and agg
```

`stat --where` used to print the whole file, which reads as a filter that
matched everything — the output was identical either way, so the mistake was
invisible. `--version` is a standalone command (`jlb --version`) and is
rejected after a command name; `--help` is the exception and still wins over
anything else on the line.

A failure is a document too. When `--json` is on the line, every exit path
writes the same shape to stdout, so a wrapper parses one thing and never has to
guess from an empty stream:

```text
$ jlb stat --json ./missing.jsonl 2>/dev/null; echo "exit=$?"
{
  "error": {
    "message": "no such file: ./missing.jsonl",
    "exitCode": 2
  }
}
exit=2
```

Without `--json` stdout stays empty; the `jlb: ...` sentence on stderr is the
same either way.

`--fields` is split on commas and trimmed. Empty segments are dropped, so
`--fields a,,b` and `--fields a,b,` both select the same two fields — a stray comma
is a typo, not a request for an unnamed column. A value with nothing left in it
(`--fields ""`, `--fields "   "`, `--fields ",,"`) is rejected with exit 2. An
otherwise-valid list is still checked segment by segment, so `--fields a..b` fails
with `invalid --fields path` instead of printing a bogus column header.

### Reading from stdin

`-` means stdin, so `jlb` composes with everything else:

```bash
cat demo/access.jsonl | jlb stat -
grep '"level":"error"' demo/access.jsonl | jlb agg - --by path --count
```

### When a line is not JSON

By default the first malformed line stops the run with an exit code of 1:

```bash
printf '{"a":1}\n{oops\n' > bad.jsonl
jlb stat bad.jsonl
```

```text
jlb: line 2: Expected property name or '}'
     {oops
     (pass --skip-invalid to skip malformed lines)
```

With `--skip-invalid` the bad line is reported on stderr and the run continues:

```text
jlb: skipping line 2: Expected property name or '}'
     {oops
```

---

## How it works

- **One pass, bounded memory.** `node:readline` over `createReadStream`, decoded
  line by line. Nothing ever holds the whole file — peak RSS grows with field
  cardinality, not with file size.
- **Expressions compile once.** A hand-written recursive-descent parser turns
  `--where` into an AST, which is compiled into a closure. Ten million records
  means ten million closure calls, not ten million parses.
- **Percentiles without storing data.** Line lengths use an exact histogram below
  4096 chars and quarter-octave buckets above it (fixed 16 KiB). Numeric p95 uses
  a deterministic reservoir of at most 4096 samples per group — exact below that
  count, an unbiased estimate above it.
- **Field tracking is capped.** At most 5,000 distinct top-level field names are
  tracked; overflow is counted and reported, never silently dropped.

### Measured performance

Real numbers on the development machine — **Windows 11 (10.0.26300), Node
v24.22.1, 13th Gen Intel Core i5-13500H (16 cores), x64, local SSD**. Generate
the same two files, then time them yourself:

```bash
npm run bench -- --out bench-100mb.jsonl --mb 100
npm run bench -- --out bench-1gb.jsonl --gb 1
```

| File | Lines | Bytes | `stat` | Throughput | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| `bench-100mb.jsonl` | 446,063 | 100.0 MiB | 1.23 s | 81.4 MiB/s | 82.5 MiB |
| `bench-1gb.jsonl` | 4,567,729 | 1.0 GiB | 11.58 s | 88.4 MiB/s | 127.3 MiB |

The line counts and byte sizes are exact and identical on every machine — the
generator is seeded. The wall-clock times are not: they were taken on an idle
box, and a loaded machine will be slower. Compare your own runs to each other,
not to this row.

`stat` on the 1 GB file. `head -10` stops right before the per-field table that
`stat` prints next, so the transcript below is stable on any machine:

```text
$ jlb stat bench-1gb.jsonl | head -10
Summary
  lines         4,567,729
  valid         4,567,729
  invalid       0
  size          1.0 GiB
  fields        10
  max depth     2

Line length (chars)
  p50 234   p95 242   max 247
```

`time` is a bash builtin and prints three tab-separated lines (`real`/`user`/`sys`),
so the wall-clock column comes from `TIMEFORMAT='real    %R s'; time jlb stat
bench-1gb.jsonl > /dev/null`. The seconds will not match the table exactly.

And a filtered pass over the same 1 GB. The matching rows go to stdout, so the
transcript redirects them into a file; the summary line is what `filter` writes
to stderr:

```text
$ jlb filter bench-1gb.jsonl --where "status>=500 and dur>500" > hits.jsonl
jlb: 291,093 matched of 4,567,729 scanned
```

That pass took 9.05 s with a 138.9 MiB peak RSS on the machine in the table.

Ten times more data costs about 45 MiB more memory. That is the whole design goal.

---

## API

The streaming engine is exported as a library, so you can embed it instead of
shelling out. `src/index.ts` never touches `process.argv` or calls `process.exit`.

```ts
import { collectStat, runFilter, runAgg, streamJsonl, compileExpr } from "jsonl-beaver";

// One-pass statistics over a huge file.
const stat = await collectStat("demo/access.jsonl");
console.log(stat.total, stat.invalid, stat.lengthP95);

// Stream records yourself; the callback is awaited per line.
await streamJsonl("demo/access.jsonl", (record, lineNumber) => {
  // ...
});

// Reusable predicate — compile once, call per record.
const isError = compileExpr("status >= 500 and level = error");
isError({ status: 503, level: "error" }); // true

// Aggregation into memory-bounded groups.
const { groups } = await runAgg("demo/access.jsonl", { by: "path", sum: "bytes", top: 10 });
```

### Exports

| Export | Signature |
| --- | --- |
| `streamJsonl` | `(input, onRecord, options?) => Promise<StreamStats>` |
| `collectStat` | `(input, options?) => Promise<StatResult>` |
| `runHead` | `(input, count, options) => Promise<HeadResult>` |
| `runFilter` | `(input, options) => Promise<FilterResult>` |
| `runAgg` | `(input, options) => Promise<AggResult>` |
| `runToCsv` / `runToJsonl` | `(input, options) => Promise<{ rows: number }>` |
| `compileExpr` | `(source) => CompiledExpr` |
| `parsePath` / `getByPath` | path helpers |
| `csvEscape` / `toCsv` / `renderStat` / `renderAgg` | formatting helpers |
| `StatAccumulator` / `Aggregator` / `LengthHistogram` / `Reservoir` | building blocks |

---

## FAQ / boundaries

**Does it load the whole file?** No. It streams line by line. A 4 GB file and a
4 MB file use the same amount of heap.

**Is `--by` with high cardinality safe?** Group state is kept per distinct key, so
a group key with millions of distinct values will grow memory. `stat` caps field
tracking at 5,000 names; `agg` has no cap by design, so prefer `--top` and a
low-cardinality key when memory matters.

**Are percentiles exact?** Line-length percentiles are exact below 4,096 chars and
bucket-approximated above. Numeric p95 is exact for groups with up to 4,096
numeric observations; beyond that it is a deterministic reservoir estimate, so the
same input always gives the same answer but the answer can be slightly off. Measured
on 200,000 records of `{"v":1..200000}` the true nearest-rank p95 is 190,000 and
`jlb agg --p95 v` reports 191,240 — about 0.6% high. Re-running prints the identical
number.

**What does `--sum` do with non-numeric values?** `toNumber` coerces the way JavaScript
does: `true` becomes 1, numeric strings are parsed, and everything else (`null`, `"abc"`,
objects) is ignored rather than counted as 0. On
`{"v":"10"},{"v":20},{"v":"abc"},{"v":null},{"v":true}` you get `COUNT 5 / SUM 31` and
`AVG 10.33` — the count is of records, the average is over the 3 numeric observations.

**Does it validate against a schema?** No — it reports what it sees. There is no
JSON Schema support, no date parsing, no timezone handling. Timestamps are
treated as opaque strings.

**Does it handle multi-line JSON?** No. JSONL means exactly one JSON value per
line. Pretty-printed JSON logs are not supported.

**What are the limits?** A single record must fit in one line in memory (it does,
always); there is no hard size limit. Malformed UTF-8 is read with replacement
characters by Node's stream decoder rather than rejected.

**Why not `jq`?** `jq` is wonderful for ad-hoc queries but it is not streaming by
default, has no percentile aggregates, and its filter language takes real effort
to learn. `jlb` trades general expressiveness for exactly the log-shaped
operations you run every day, with a memory ceiling you can predict.

---

## Security and changes

Found a vulnerability? Please do not open a public issue — [SECURITY.md](SECURITY.md)
explains the private reporting channel and what to include. Every release is written
up in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 kesheC.
---

# 中文文档

## 痛点

线上日志和事件流都是 NDJSON，动不动就是几个 G。

用 `jq`：要么写出天书般的一行命令，要么先 `grep` 再猜。
用 Python：现写一个明天就扔掉的脚本。
用 Excel / 表格：50 MB 就爆内存。

你真正想要的是：**流式读取、内存有界、随手过滤和聚合**。这就是 `jlb`。

---

## 安装

`jsonl-beaver` **没有发布到 npm registry**。这个名字目前还是空的，只是本项目还没有发布凭据。
每个 release 都附带可直接安装的 tarball：

```bash
npm install -g https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz
jlb --version
```

每个 release 都用固定名字（`jsonl-beaver.tgz`）发布同一个 tarball，并附一份
`jsonl-beaver.tgz.sha256` 校验和。运行之前先验一下：

```bash
curl -sLO https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz
curl -sLO https://github.com/kesheC/jsonl-beaver/releases/latest/download/jsonl-beaver.tgz.sha256
sha256sum -c jsonl-beaver.tgz.sha256          # jsonl-beaver.tgz: OK
npm install -g ./jsonl-beaver.tgz
```

macOS 上没有 `sha256sum`，用 `shasum -a 256 -c jsonl-beaver.tgz.sha256`。

或者从源码自己编译：

```bash
git clone https://github.com/kesheC/jsonl-beaver.git
cd jsonl-beaver
npm ci && npm run build && npm link
```

需要 Node >= 20.11。**零运行时依赖** —— 只用 Node 标准库。

> 不要用 `npm install -g git+https://github.com/...`：仓库里没有构建产物，
> 而全局安装会跳过 `devDependencies`，因此根本没有 `tsc` 可以拿来构建。

---

## 60 秒上手

仓库里带着下面这份访问日志的生成器，所以本文每一个输出你都能逐字节复现：

```bash
git clone https://github.com/kesheC/jsonl-beaver.git
cd jsonl-beaver
npm ci && npm run build && npm link
npm run demo                           # 生成 demo/access.jsonl
```

然后让 `jlb` 指向它：

```bash
jlb stat demo/access.jsonl
```

下面是 20,000 条 nginx 风格访问日志（4.8 MiB）的真实输出：

```text
Summary
  lines         20,000
  valid         20,000
  invalid       0
  size          4.8 MiB
  fields        10
  max depth     2

Line length (chars)
  p50 252   p95 268   max 278

Top fields (10 of 10)
FIELD       COUNT    RATE  TYPES
─────────  ──────  ──────  ───────────
bytes      20,000  100.0%  number:100%
client_ip  20,000  100.0%  string:100%
dur        20,000  100.0%  number:100%
level      20,000  100.0%  string:100%
method     20,000  100.0%  string:100%
path       20,000  100.0%  string:100%
req        20,000  100.0%  object:100%
status     20,000  100.0%  number:100%
ts         20,000  100.0%  string:100%
upstream   20,000  100.0%  object:100%
```

一遍扫描，不需要索引、不需要 schema、不需要任何配置文件。

---

## 用法

每个命令都接受文件路径**或 `-` 表示 stdin**，且全部是流式的 —— 管道接
`head` 时会立刻停止读取。

命令名写错时报的是命令名，而不是先抱怨参数 —— 而且 `--help` 不会让它消失：

```text
$ jlb bogus
jlb: unknown command: bogus (try jlb --help)
$ jlb bogus --help
jlb: unknown command: bogus (try jlb --help)
$ jlb stat
jlb: stat: missing <file|-> argument
$ jlb --versoin
jlb: unknown option: --versoin (try jlb --help)
```

### `jlb stat` —— 这个文件里有什么？

```bash
jlb stat <file|-> [--top N] [--json] [--skip-invalid]
```

一遍扫描给出：行数、合法/非法行数、文件大小、Top 30 字段出现率、每个字段的
类型分布、行长度的 p50/p95/max、最大嵌套深度。内存只与字段数量相关，与文件
大小无关。

### `jlb head` —— 取前 N 条

```bash
jlb head <file|-> [-n 10] [--pretty]
```

```bash
jlb head demo/access.jsonl -n 1 --pretty
```

```json
{
  "ts": "2026-10-01T00:00:00.000Z",
  "level": "info",
  "status": 404,
  "method": "POST",
  "path": "/api/cart",
  "dur": 882,
  "bytes": 26696,
  "client_ip": "10.119.61.141",
  "req": {
    "id": "r000000",
    "ua": "curl/8.4.0"
  },
  "upstream": {
    "host": "api-a",
    "attempts": 1
  }
}
```

取够 N 条立刻停止读取，所以在 1 GB 文件上也是瞬间返回。

### `jlb filter` —— 用表达式筛选

```bash
jlb filter <file|-> --where "<expr>" [--limit N] [--pretty] [--where-file <f>]
```

```bash
jlb filter demo/access.jsonl --where "status>=500 and dur>500" --limit 2
```

表达式支持 `=` `==` `!=` `>` `>=` `<` `<=` `includes`，布尔运算符
`and` / `or` / `not`，以及括号：

```text
status>=500
level=error and dur>500
(status = 500 or status = 502) and not cached
path includes "/api/" and user.role = admin
items[0].id = 7
```

右侧的裸词就是字符串字面量，所以 `level=error` 等价于 `level="error"`。
字段缺失不会报错，只是不匹配（`!=` 除外 —— 缺失字段视为"不等于"，符合 SQL 直觉）。

筛选过程会在 stderr 汇报自己的开销：

```text
jlb: 2 matched of 12 scanned
```

### `jlb agg` —— 分组聚合

```bash
jlb agg <file|-> [--by <field>] [--count | --sum <f> | --avg <f> | --p95 <f>] \
        [--top 20] [--where "<expr>"] [--json]
```

状态码分布：

```bash
jlb agg demo/access.jsonl --by status --count
```

```text
STATUS   COUNT
──────  ──────
200     15,005
404      2,122
503        986
500        945
502        942
```

每个接口的 p95 延迟：

```bash
jlb agg demo/access.jsonl --by path --p95 dur --top 5
```

```text
PATH             COUNT  P95
───────────────  ─────  ───
/api/login       1,453  852
/api/search      1,445  860
/static/app.css  1,445  860
/favicon.ico     1,444  861
/static/app.js   1,444  861

Showing top 5 of 14 groups.
```

嵌套字段可以直接当分组键，`--where` 也能组合使用：

```bash
jlb agg demo/access.jsonl --by upstream.host --avg dur
```

```text
UPSTREAM.HOST  COUNT     AVG
─────────────  ─────  ──────
api-a          6,844  453.41
api-b          6,652  452.23
api-c          6,504  455.71
```

### `jlb to-csv` / `jlb to-jsonl` —— 重塑字段

```bash
jlb to-csv <file|-> --fields a,b.c [--where "<expr>"] [--limit N] [-o out.csv]
jlb to-jsonl <file|-> --fields a,b.c [--where "<expr>"] [--pretty]
```

```bash
jlb to-csv demo/access.jsonl --fields ts,level,status,path --limit 3
```

```text
ts,level,status,path
2026-10-01T00:00:00.000Z,info,404,/api/cart
2026-10-01T00:00:00.400Z,info,200,/api/orders/42/items
2026-10-01T00:00:00.800Z,info,200,/api/cart
```

CSV 输出遵循 RFC 4180：逗号、引号、换行都会被转义，内嵌引号会被双写。命令行输出用 LF
换行（上面那份输出的 `od -c` 是 `a \n 1 \n 2 \n`），所以在 Windows 和 Linux 上行为
一致。库函数 `toCsv(fields, rows)` 按 RFC 4180 默认 CRLF，想要和命令行一样就在第三个参数
传 `"\n"`。

`-o FILE` 是原子写入：`jlb` 先在目标旁边建临时文件，命令成功后才 rename 覆盖目标。
因此参数写错、输入文件不存在、`--where` 编译失败都不会破坏已有的输出文件；
`jlb head -o demo/access.jsonl demo/access.jsonl` 会被直接拒绝，而不是把自己的输入截断成空文件。
`-o` 两侧的空白会先被裁掉，所以 `-o "out.csv "` 写的是 `out.csv`，也照样会走
自覆盖保护。

正因为真正的写入发生在临时文件上，一次被打断的运行可能留下残留。`jlb` 会记录自己
打开过的每个临时文件，并在 `SIGINT` / `SIGTERM` 时删掉它们。Windows 结束进程时
不会执行任何 JavaScript，所以对硬杀的情况，下一次用同一个 `-o` 运行时，会清理掉
属主进程已经不在的残留——而属于另一个仍在运行的 `jlb` 的临时文件绝不会被碰：

```text
$ touch .out.csv.zzzzz.abc123.jlb-tmp   # 60466175 的 36 进制，该进程并不存在
$ ls -a | grep -c jlb-tmp
1
$ jlb head demo/access.jsonl -n 1 -o out.csv
jlb: stopped after 1 record(s)
$ ls -a | grep -c jlb-tmp
0
```

下游消费者提前退出也不会被当成失败。管道接 `head` 时写端会被关闭，`jlb` 把这种
情况理解为"读取方已经拿到它要的东西"，于是把自己被要求写的文件写完，然后以 0 退出：

```text
$ head -n 52 demo/access.jsonl | sed '2s/.*/not json/; 10s/.*/not json either/' > half.jsonl
$ jlb to-csv half.jsonl --fields status --skip-invalid -o out.csv 2>&1 | head -1
jlb: skipping line 2: Unexpected token 'o', "not json" is not valid JSON
$ echo ${PIPESTATUS[0]}   # 这是写端的状态，不是 head 的
0
$ wc -l < out.csv
51
```

### 全局参数

| 参数 | 含义 | 哪些命令会读它 |
| --- | --- | --- |
| `--skip-invalid` | 跳过坏行而不是在第一行就失败 | 所有命令 |
| `--progress` | 每 1,000,000 行在 stderr 打一次进度 | 所有命令 |
| `--out FILE` | 输出写入文件而不是 stdout | 所有命令 |
| `--quiet` | 关闭汇总提示 | 所有命令 |
| `--json` | stdout 输出机器可读的 JSON 而非表格 | `stat` / `head` / `filter` / `agg` |
| `--top N` | 输出的行数，必须 >= 1 | `stat` / `agg` |
| `--lines N` | 打印多少条，默认 10 | `head` |
| `--limit N` | 匹配到 N 条后停止 | `filter` / `to-csv` / `to-jsonl` |
| `--pretty` | 缩进输出 JSON | `head` / `filter` / `to-jsonl` |
| `--fields a,b.c` | 要输出的列 | `to-csv` / `to-jsonl` |
| `--where / --where-file` | 过滤表达式 | `filter` / `agg` / `to-csv` / `to-jsonl` |
| `--by / --count / --sum / --avg / --p95` | 分组方式和指标 | `agg` |

在不属于它的命令上用这些参数是 exit 2，而不是静默忽略：

```text
$ jlb stat demo/access.jsonl --where "status>=500"
jlb: --where is not supported by stat; it applies to filter, agg, to-csv and to-jsonl
$ jlb head demo/access.jsonl --top 2
jlb: --top is not supported by head; it applies to stat and agg
```

`stat --where` 以前会把整个文件原样打出来，读起来就像"过滤匹配了全部"——两种
情况的输出一模一样，所以这个错误根本看不出来。`--version` 是一个独立命令
（`jlb --version`），写在命令名后面会被拒绝；`--help` 是例外，仍然优先于
同一行上的其它任何参数。

失败也是一个文档：只要行上有 `--json`，每条退出路径都会把同一个形状写进 stdout——`{"error":{"message":"no such file: ./missing.jsonl","exitCode":2}}`——脚本不必再从空流里猜成败；不带 `--json` 时 stdout 一个字节都不写，stderr 的 `jlb: ...` 那句话两种情况下完全一样。

`--fields` 按逗号切分并逐段 trim。空段会被丢弃，所以 `--fields a,,b` 和
`--fields a,b,` 选的是同样两个字段——多打一个逗号是手误，不是在要一个无名列。
全部为空的值（`--fields ""`、`--fields "   "`、`--fields ",,"`）会以 exit 2 拒绝。
非空的列表仍然逐段校验，所以 `--fields a..b` 报 `invalid --fields path`，
而不是把错误的列名直接打出来。

### 从 stdin 读取

`-` 表示 stdin，所以 `jlb` 可以和任何命令组合：

```bash
cat demo/access.jsonl | jlb stat -
grep '"level":"error"' demo/access.jsonl | jlb agg - --by path --count
```

### 当某一行不是 JSON

默认情况下遇到第一行坏数据就停止，退出码 1：

```bash
printf '{"a":1}\n{oops\n' > bad.jsonl
jlb stat bad.jsonl
```

```text
jlb: line 2: Expected property name or '}'
     {oops
     (pass --skip-invalid to skip malformed lines)
```

加上 `--skip-invalid` 后，坏行会在 stderr 报告并继续处理：

```text
jlb: skipping line 2: Expected property name or '}'
     {oops
```

---

## 实现要点

- **一遍扫描、内存有界。** `node:readline` 消费 `createReadStream`，逐行解码。
  任何时刻都不会把整个文件放进内存 —— 峰值内存随字段基数增长，不随文件大小增长。
- **表达式只编译一次。** 手写递归下降 parser 把 `--where` 变成 AST，再编译成闭包。
  一千万条记录就是一千万次闭包调用，而不是一千万次解析。
- **不存数据也能算分位数。** 行长在 4096 字符以内是精确直方图，之上是四分之一
  倍频程分桶（固定 16 KiB）。数值 p95 使用每组最多 4096 个样本的确定性蓄水池 ——
  样本量以内精确，超出则无偏估计。
- **字段追踪有上限。** 最多追踪 5,000 个不同的顶层字段名，超出部分会被计数并
  报告，绝不静默丢弃。

### 实测性能

开发机真实数据 —— **Windows 11 (10.0.26300)、Node v24.22.1、13th Gen Intel
Core i5-13500H（16 核）、x64、本地 SSD**。同样的两个文件你可以自己生成再计时：

```bash
npm run bench -- --out bench-100mb.jsonl --mb 100
npm run bench -- --out bench-1gb.jsonl --gb 1
```

| 文件 | 行数 | 大小 | `stat` 耗时 | 吞吐 | 峰值 RSS |
| --- | --- | --- | --- | --- | --- |
| `bench-100mb.jsonl` | 446,063 | 100.0 MiB | 1.23 s | 81.4 MiB/s | 82.5 MiB |
| `bench-1gb.jsonl` | 4,567,729 | 1.0 GiB | 11.58 s | 88.4 MiB/s | 127.3 MiB |

行数和字节数在任何机器上都完全一致（生成器是定种子的）；但墙上时间不是 ——
那是在空载机器上测的，机器一忙就会变慢。请用你自己几次运行的相对值比较，
而不是拿绝对秒数对照这张表。

对 1 GB 文件跑 `stat`。`head -10` 正好停在紧随其后的字段表之前，所以下面这段转录在任何机器上都一致：

```text
$ jlb stat bench-1gb.jsonl | head -10
Summary
  lines         4,567,729
  valid         4,567,729
  invalid       0
  size          1.0 GiB
  fields        10
  max depth     2

Line length (chars)
  p50 234   p95 242   max 247
```

`time` 是 bash 内建，默认打 `real`/`user`/`sys` 三行（TAB 分隔）；表格里那一列用 `TIMEFORMAT='real    %R s'; time jlb stat bench-1gb.jsonl > /dev/null` 得到，秒数不会与表格完全一致。

对同一个 1 GB 文件跑一次带过滤的扫描。匹配行走 stdout，所以转录里把它们重定向进了文件；汇总那一句是 `filter` 写到 stderr 的：

```text
$ jlb filter bench-1gb.jsonl --where "status>=500 and dur>500" > hits.jsonl
jlb: 291,093 matched of 4,567,729 scanned
```

在表格那台机器上这次扫描耗时 9.05 s，峰值 RSS 138.9 MiB。

数据量翻十倍，内存只多用了约 45 MiB。这就是整个设计目标。

---

## 库 API

流式引擎以库的形式导出，可以直接嵌入而不必起子进程。`src/index.ts` 从不读取
`process.argv`，也从不调用 `process.exit`。

```ts
import { collectStat, runFilter, runAgg, streamJsonl, compileExpr } from "jsonl-beaver";

// 对超大文件做一遍统计
const stat = await collectStat("demo/access.jsonl");
console.log(stat.total, stat.invalid, stat.lengthP95);

// 自己消费流；回调会按行 await
await streamJsonl("demo/access.jsonl", (record, lineNumber) => {
  // ...
});

// 可复用的谓词 —— 编译一次，逐条调用
const isError = compileExpr("status >= 500 and level = error");
isError({ status: 503, level: "error" }); // true

// 内存有界的分组聚合
const { groups } = await runAgg("demo/access.jsonl", { by: "path", sum: "bytes", top: 10 });
```

### 导出清单

| 导出 | 签名 |
| --- | --- |
| `streamJsonl` | `(input, onRecord, options?) => Promise<StreamStats>` |
| `collectStat` | `(input, options?) => Promise<StatResult>` |
| `runHead` | `(input, count, options) => Promise<HeadResult>` |
| `runFilter` | `(input, options) => Promise<FilterResult>` |
| `runAgg` | `(input, options) => Promise<AggResult>` |
| `runToCsv` / `runToJsonl` | `(input, options) => Promise<{ rows: number }>` |
| `compileExpr` | `(source) => CompiledExpr` |
| `parsePath` / `getByPath` | 路径工具 |
| `csvEscape` / `toCsv` / `renderStat` / `renderAgg` | 格式化工具 |
| `StatAccumulator` / `Aggregator` / `LengthHistogram` / `Reservoir` | 构建模块 |

---

## FAQ / 边界

**会把整个文件读进内存吗？** 不会。逐行流式处理，4 GB 文件和 4 MB 文件占用同样
量级的堆内存。

**`--by` 基数很高怎么办？** 每个不同键都保留一份分组状态，所以百万级不同值的
分组键会占用相应内存。`stat` 把字段追踪限制在 5,000 个；`agg` 刻意不设上限，
内存敏感时请配合 `--top` 和低基数键使用。

**分位数是精确的吗？** 行长分位数在 4,096 字符以内精确，之上是分桶近似。
数值 p95 在每组 4,096 个观测以内精确；超出后是确定性蓄水池估计，同样的输入永远给出
同样的结果，但结果本身可能略有偏差。实测 200,000 条 `{"v":1..200000}`：真实的最近秩
p95 是 190,000，`jlb agg --p95 v` 给出 191,240，偏高约 0.6%，重复运行结果完全相同。

**`--sum` 遇到非数值怎么办？** `toNumber` 按 JavaScript 的方式转换：`true` 变成 1，
数字字符串会被解析，其余（`null`、`"abc"`、对象）直接忽略而不是当 0 计。对
`{"v":"10"},{"v":20},{"v":"abc"},{"v":null},{"v":true}` 运行结果是 `COUNT 5 / SUM 31`、
`AVG 10.33` —— COUNT 数的是记录数，AVG 除的是那 3 个数值观测。

**会做 schema 校验吗？** 不会 —— 它只报告看到的东西。不支持 JSON Schema、不做
日期解析、不处理时区。时间戳一律当作不透明字符串。

**支持跨行 JSON 吗？** 不支持。JSONL 就是一行一个 JSON 值，格式化过的多行 JSON
日志无法处理。

**有什么硬限制？** 单条记录必须整行放进内存（这一点永远成立），没有额外大小限制。
非法 UTF-8 会被 Node 的流解码器替换为替换字符，而不是报错。

**为什么不用 `jq`？** `jq` 做临时查询非常好用，但它默认不流式、没有分位数聚合，
而且过滤语言需要真正花时间学。`jlb` 用通用表达力换取日志场景里每天都要用的
那几个操作，并给出一个可预测的内存上限。

---

## 安全与变更

发现安全问题请**不要**开公开 issue —— [SECURITY.md](SECURITY.md) 说明了私密上报渠道以及
需要提供哪些信息。每个版本的改动都记在 [CHANGELOG.md](CHANGELOG.md)。

---

## 许可证

MIT —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 kesheC。