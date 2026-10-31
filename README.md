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

`jsonl-beaver` is **not published to the npm registry** — that name belongs to an
unrelated package. Each release ships a tarball you can install directly:

```bash
npm install -g https://github.com/kesheC/jsonl-beaver/releases/download/v0.1.1/jsonl-beaver-0.1.1.tgz
jlb --version
```

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
quotes are doubled.

### Global options

| Option | Meaning |
| --- | --- |
| `--skip-invalid` | Skip malformed lines instead of failing on the first one |
| `--json` | Machine-readable JSON on stdout instead of a table |
| `--progress` | Progress tick on stderr every 1,000,000 lines |
| `--limit N` | Stop after N matching records |
| `--top N` | Rows in `stat` (fields) / `agg` (groups) output |
| `--out FILE` | Write output to a file instead of stdout |
| `--quiet` | Suppress the summary footer |

### Reading from stdin

`-` means stdin, so `jlb` composes with everything else:

```bash
cat demo/access.jsonl | jlb stat -
grep '"level":"error"' app.log | jlb agg - --by path --count
```

### When a line is not JSON

By default the first malformed line stops the run with an exit code of 1:

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

`stat` on the 1 GB file:

```text
$ time jlb stat bench-1gb.jsonl
Summary
  lines         4,567,729
  valid         4,567,729
  invalid       0
  size          1.0 GiB
  fields        10
  max depth     2

Line length (chars)
  p50 234   p95 242   max 247

real    0m11.583s
```

And a filtered pass over the same 1 GB (9.05 s, 138.9 MiB peak RSS):

```text
$ time jlb filter bench-1gb.jsonl --where "status>=500 and dur>500"
jlb: 291,093 matched of 4,567,729 scanned

real    0m9.054s
```

Ten times more data costs about 45 MiB more memory. That is the whole design goal.

---

## API

The streaming engine is exported as a library, so you can embed it instead of
shelling out. `index.ts` never touches `process.argv` or calls `process.exit`.

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
numeric observations and a deterministic reservoir estimate beyond that.

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

## 安装

`jsonl-beaver` **没有发布到 npm registry**（那个名字属于另一个不相干的包）。
每个 release 都附带可直接安装的 tarball：

```bash
npm install -g https://github.com/kesheC/jsonl-beaver/releases/download/v0.1.1/jsonl-beaver-0.1.1.tgz
jlb --version
```

或者从源码自己编译：

```bash
git clone https://github.com/kesheC/jsonl-beaver.git
cd jsonl-beaver
npm ci && npm run build && npm link
```

需要 Node >= 20.11。**零运行时依赖** —— 只用 Node 标准库。

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

## 用法

每个命令都接受文件路径**或 `-` 表示 stdin**，且全部是流式的 —— 管道接
`head` 时会立刻停止读取。

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

CSV 输出遵循 RFC 4180：逗号、引号、换行都会被转义，内嵌引号会被双写。

### 全局参数

| 参数 | 含义 |
| --- | --- |
| `--skip-invalid` | 跳过坏行而不是在第一行就失败 |
| `--json` | stdout 输出机器可读的 JSON 而非表格 |
| `--progress` | 每 1,000,000 行在 stderr 打一次进度 |
| `--limit N` | 匹配到 N 条后停止 |
| `--top N` | `stat`（字段）/ `agg`（分组）输出的行数 |
| `--out FILE` | 输出写入文件而不是 stdout |
| `--quiet` | 关闭汇总提示 |

### 从 stdin 读取

`-` 表示 stdin，所以 `jlb` 可以和任何命令组合：

```bash
cat demo/access.jsonl | jlb stat -
grep '"level":"error"' app.log | jlb agg - --by path --count
```

### 当某一行不是 JSON

默认情况下遇到第一行坏数据就停止，退出码 1：

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

对 1 GB 文件跑 `stat`：

```text
$ time jlb stat bench-1gb.jsonl
Summary
  lines         4,567,729
  valid         4,567,729
  invalid       0
  size          1.0 GiB
  fields        10
  max depth     2

Line length (chars)
  p50 234   p95 242   max 247

real    0m11.583s
```

对同一个 1 GB 文件跑一次带过滤的扫描（9.05 s，峰值 138.9 MiB）：

```text
$ time jlb filter bench-1gb.jsonl --where "status>=500 and dur>500"
jlb: 291,093 matched of 4,567,729 scanned

real    0m9.054s
```

数据量翻十倍，内存只多用了约 45 MiB。这就是整个设计目标。

## 库 API

流式引擎以库的形式导出，可以直接嵌入而不必起子进程。`index.ts` 从不读取
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

## FAQ / 边界

**会把整个文件读进内存吗？** 不会。逐行流式处理，4 GB 文件和 4 MB 文件占用同样
量级的堆内存。

**`--by` 基数很高怎么办？** 每个不同键都保留一份分组状态，所以百万级不同值的
分组键会占用相应内存。`stat` 把字段追踪限制在 5,000 个；`agg` 刻意不设上限，
内存敏感时请配合 `--top` 和低基数键使用。

**分位数是精确的吗？** 行长分位数在 4,096 字符以内精确，之上是分桶近似。
数值 p95 在每组 4,096 个观测以内精确，超出后是确定性蓄水池估计。

**会做 schema 校验吗？** 不会 —— 它只报告看到的东西。不支持 JSON Schema、不做
日期解析、不处理时区。时间戳一律当作不透明字符串。

**支持跨行 JSON 吗？** 不支持。JSONL 就是一行一个 JSON 值，格式化过的多行 JSON
日志无法处理。

**有什么硬限制？** 单条记录必须整行放进内存（这一点永远成立），没有额外大小限制。
非法 UTF-8 会被 Node 的流解码器替换为替换字符，而不是报错。

**为什么不用 `jq`？** `jq` 做临时查询非常好用，但它默认不流式、没有分位数聚合，
而且过滤语言需要真正花时间学。`jlb` 用通用表达力换取日志场景里每天都要用的
那几个操作，并给出一个可预测的内存上限。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 kesheC。