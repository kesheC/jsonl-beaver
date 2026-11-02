import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The published tarball ships dist/ and nothing else that could hold sources.
// A .js.map whose "sources" point at src/*.ts is therefore a pointer at a file
// the reader can never open: dead weight that roughly doubles the download.
// tsconfig.build.json is the config npm actually builds with, so this pins the
// published artifact rather than the editor experience.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

/** tsconfig files carry // comments, so parse them without a JSON5 dependency. */
function readConfig(path: string): {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
} {
  const raw = readFileSync(join(root, path), "utf8");
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(stripped) as {
    compilerOptions?: Record<string, unknown>;
    include?: string[];
    exclude?: string[];
  };
}

describe("published package", () => {
  it("builds without sourcemaps for the tarball", () => {
    const raw = readFileSync(join(root, "tsconfig.build.json"), "utf8");
    // Strip // comments so the config can be parsed without a JSON5 dependency.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(stripped) as {
      compilerOptions: { sourceMap?: boolean; declarationMap?: boolean };
    };
    expect(config.compilerOptions.sourceMap).toBe(false);
    expect(config.compilerOptions.declarationMap).toBe(false);
  });

  it("ships only dist, README and LICENSE", () => {
    const pkg = readJson("package.json") as { files: string[] };
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
  });

  it("leaves no .js.map behind in dist", () => {
    const dist = join(root, "dist");
    if (!existsSync(dist)) return; // build has not run yet in this checkout
    const maps = readdirSync(dist, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith(".js.map"));
    expect(maps).toEqual([]);
  });

  it("keeps the published entry points where package.json says they are", () => {
    const pkg = readJson("package.json") as { bin: Record<string, string>; main: string };
    expect(pkg.bin.jlb).toBe("./dist/cli.js");
    expect(pkg.main).toBe("./dist/index.js");
  });

  it("typechecks without emitting beside the sources", () => {
    // `npm run typecheck` passes --noEmit, but a bare `tsc` — what an editor and a
    // curious contributor run — obeys tsconfig.json alone. Without noEmit there it
    // writes .js and .d.ts next to every .ts: dozens of untracked files (72 in this
    // repository when the switch went missing) that the next `git add .` sweeps up.
    const base = readConfig("tsconfig.json");
    expect(base.compilerOptions?.noEmit).toBe(true);
    expect(base.compilerOptions?.outDir).toBeUndefined();
  });

  it("builds src/ only, and actually emits", () => {
    // The build config inherits the base, so every switch the base sets has to be
    // restated here. A missing noEmit: false emits nothing and still exits 0; an
    // inherited include lets a plain .ts under tests/ trip TS6059 on rootDir.
    const build = readConfig("tsconfig.build.json");
    expect(build.compilerOptions?.noEmit).toBe(false);
    expect(build.compilerOptions?.rootDir).toBeDefined();
    expect(build.include).toEqual(["src"]);
  });
});
