import { defineConfig } from "vitest/config";

// The default vitest testTimeout is 5s. Several suites shell out to git in
// beforeAll hooks and the Windows runners regularly need more than that,
// which shows up as a flaky failure on one matrix leg and not the others.
// The suite is fast in wall-clock terms; a single long test is the norm here.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Measured, not aspirational: the suites import the built dist/, so without
    // this exclude every module is counted twice (src/*.ts through the source map
    // and the compiled dist/*.js next to it) and the reported number is roughly
    // half of the real one. See the coverage script in package.json.
    coverage: {
      provider: "v8",
      // A coverage report nobody has to meet is decoration: these floors turn
      // the run into a gate. They sit just under what the suite reaches today,
      // so an unrelated change is not punished, while a real regression fails
      // `npm run coverage` instead of showing up as a smaller number in a log
      // nobody reads. tests/workflow.test.ts keeps all four of them in place.
      thresholds: { statements: 80, branches: 70, functions: 85, lines: 80 },
      reporter: ["text"],
      exclude: ["dist/**", "tests/**", "scripts/**", "demo/**", "**/*.test.ts", "**/*.spec.ts"],
    },
  },
});
