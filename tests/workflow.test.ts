import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The release pipeline is the one part of this project no unit test can reach:
 * it only runs on a tag push. Every guard in `.github/workflows` is therefore
 * a guard nobody exercises, which is exactly how tag/version drift went
 * unnoticed. The only version assertion the pipeline used to have compared
 * `jlb --version` against the version inside the package that the same job had
 * just packed, and those two are equal by construction.
 *
 * So this file pins the guards two ways:
 *   1. structurally, against the YAML text - the guard exists, and it is
 *      ordered before the thing it protects;
 *   2. behaviourally, by cutting the guard's shell body out of the workflow and
 *      running it for real against a throwaway package.json.
 *
 * Only node's stdlib and vitest are used: the project ships zero runtime
 * dependencies and does not add a parser just to read two files it owns.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readWorkflow(name: string): string {
  return readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
}

/**
 * Cut the body of one step out of a workflow, keyed by its "- name:" line.
 * Every step here is a bash "run: |" block, so the body is whatever follows,
 * de-indented, up to the first line indented less than the first body line.
 */
function stepBody(workflow: string, stepName: string): string {
  const marker = "- name: " + stepName;
  const at = workflow.indexOf(marker);
  if (at < 0) throw new Error("step not found in workflow: " + stepName);
  const runAt = workflow.indexOf("run: |", at);
  if (runAt < 0) throw new Error("step has no run block: " + stepName);
  const bodyStart = workflow.indexOf("\n", runAt) + 1;
  const lines = workflow.slice(bodyStart).split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => (line.match(/^ */) as RegExpMatchArray)[0].length);
  const bodyIndent = Math.min(...indents);
  const body: string[] = [];
  for (const line of lines) {
    const indent = line.trim() === "" ? Number.POSITIVE_INFINITY : (line.match(/^ */) as RegExpMatchArray)[0].length;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join("\n").trimEnd();
}

/** Extract the JavaScript out of an inline "node -e '...' "$ARG"" invocation. */
function inlineNodeScript(shell: string, nth = 0): string {
  const opener = "node -e '";
  let from = -1;
  for (let i = 0; i <= nth; i += 1) {
    from = shell.indexOf(opener, from + 1);
    if (from < 0) throw new Error("inline node -e number " + String(nth) + " not found");
  }
  const start = from + opener.length;
  const end = shell.indexOf("' \"$", start);
  if (end < 0) throw new Error("inline node -e has no closing quote and argument");
  return shell.slice(start, end);
}

interface GateResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the real release gate against a synthetic package.json.
 *
 * The gate uses process.argv[1], which is the first user argument under
 * "node -e" but the script path when node is handed a file. Reproduce the
 * workflow exactly: pass the body to -e and the tag after it.
 */
function runGate(tag: string, version: string): GateResult {
  const gate = inlineNodeScript(stepBody(readWorkflow("release.yml"), "Publish release assets"), 0);
  const dir = mkdtempSync(path.join(tmpdir(), "jlb-gate-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "jsonl-beaver", version }), "utf8");
  const result = spawnSync(process.execPath, ["-e", gate, tag], { cwd: dir, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("release workflow: the tag must agree with package.json", () => {
  it("accepts a tag that matches package.json", () => {
    const result = runGate("v0.1.6", "0.1.6");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("matches package.json version 0.1.6");
    expect(result.code).toBe(0);
  });

  it("rejects a tag that drifted, and prints both sides", () => {
    const result = runGate("v0.1.7", "0.1.6");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag/version mismatch: tag says 0.1.7, package.json says 0.1.6");
  });

  it("rejects a tag that is not vX.Y.Z at all", () => {
    const result = runGate("nightlies", "0.1.6");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag is not a vX.Y.Z tag: nightlies");
  });

  it("rejects a prerelease tag, which can never equal a plain version", () => {
    const result = runGate("v0.1.6-rc.1", "0.1.6");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag says 0.1.6-rc.1");
  });

  it("gates before the CHANGELOG lookup and before any gh call", () => {
    const publish = stepBody(readWorkflow("release.yml"), "Publish release assets");
    const gateAt = publish.indexOf("tag/version mismatch");
    const changelogAt = publish.indexOf("CHANGELOG.md");
    const ghAt = publish.indexOf("gh release");
    expect(gateAt).toBeGreaterThan(-1);
    expect(changelogAt).toBeGreaterThan(-1);
    expect(ghAt).toBeGreaterThan(-1);
    // Otherwise a drifted tag is reported as "CHANGELOG has no section for ...",
    // which sends the reader to the wrong file entirely.
    expect(gateAt).toBeLessThan(changelogAt);
    expect(gateAt).toBeLessThan(ghAt);
  });
});

describe("CI workflow: the packed artifact is the thing under test", () => {
  const smoke = stepBody(readWorkflow("ci.yml"), "Smoke test the packed tarball");

  it("inspects the tarball from the repo root, before changing directory", () => {
    const packAt = smoke.indexOf("npm pack --dry-run --json > pack-meta.json");
    const cdAt = smoke.indexOf('cd "$SMOKE"');
    expect(packAt).toBeGreaterThan(-1);
    expect(cdAt).toBeGreaterThan(-1);
    // npm pack packs the current directory; inspecting after cd would check a
    // throwaway empty package and stay green forever.
    expect(packAt).toBeLessThan(cdAt);
  });

  it("asserts the required entries, the leak prefixes and the absence of maps", () => {
    for (const needle of [
      "dist/index.js",
      "dist/cli.js",
      "dist/index.d.ts",
      "the tarball leaks ",
      "'tests/', 'src/', 'node_modules/'",
      ".js.map",
    ]) {
      expect(smoke).toContain(needle);
    }
  });

  it("imports the installed package instead of the checkout", () => {
    expect(smoke).toContain("node --input-type=module");
    expect(smoke).toContain("await import('jsonl-beaver')");
    expect(smoke.indexOf("await import('jsonl-beaver')")).toBeGreaterThan(smoke.indexOf('cd "$SMOKE"'));
  });

  it("names library exports that this package actually exports", async () => {
    const entry = path.join(repoRoot, "dist", "index.js");
    const api = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    const required = [
      "collectStat",
      "runHead",
      "runFilter",
      "runAgg",
      "runToCsv",
      "runToJsonl",
      "streamJsonl",
      "compileExpr",
      "toCsv",
      "renderStat",
      "openOutputSink",
    ];
    for (const name of required) {
      expect(smoke, name + " is asserted by CI but is not exported").toContain("'" + name + "'");
      expect(typeof api[name], name + " must be a function").toBe("function");
    }
  });

  it("keeps the generated pack-meta.json out of version control", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("pack-meta.json");
  });
});

describe("build config: no sourcemaps for sources that are not shipped", () => {
  it("turns sourceMap and declarationMap off in the build layer", () => {
    const build = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.build.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(build.compilerOptions.sourceMap).toBe(false);
    expect(build.compilerOptions.declarationMap).toBe(false);
  });

  it("leaves the editor config with sourcemaps", () => {
    const base = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(base.compilerOptions.sourceMap).toBe(true);
  });

  it("does not publish a source tree that the tarball does not contain", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    // A .js.map points at src/*.ts; "src" is not in "files", so every map that
    // used to ship was a dead link to a file the user never receives.
    expect(pkg.files).not.toContain("src");
  });
});
