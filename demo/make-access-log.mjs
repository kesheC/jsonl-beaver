#!/usr/bin/env node
/**
 * Generates the deterministic nginx-style access log the README demos run on.
 * Same seed -> same bytes, so every documented output can be reproduced.
 *
 *   node demo/make-access-log.mjs --lines 20000 --out demo/access.jsonl
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const lines = Number(flag("--lines", "20000"));
const out = flag("--out", "demo/access.jsonl");
const seed = Number(flag("--seed", "7"));

// mulberry32: small deterministic PRNG so the file is identical on every machine.
let state = seed >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(list) {
  return list[Math.floor(random() * list.length)];
}

const PATHS = [
  "/api/login", "/api/logout", "/api/users", "/api/users/42", "/api/orders",
  "/api/orders/42/items", "/api/search", "/api/cart", "/api/checkout",
  "/static/app.js", "/static/app.css", "/healthz", "/metrics", "/favicon.ico",
];
const METHODS = ["GET", "GET", "GET", "POST", "POST", "PUT", "DELETE"];
const LEVELS = ["info", "info", "info", "info", "info", "warn", "error"];
const HOSTS = ["api-a", "api-b", "api-c"];
const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  "curl/8.4.0",
  "Mozilla/5.0 (X11; Linux x86_64)",
];

const START = Date.UTC(2026, 9, 1, 0, 0, 0);
const rows = [];
for (let i = 0; i < lines; i += 1) {
  const level = pick(LEVELS);
  const roll = random();
  // Errors correlate with 5xx so "level=error and status>=500" is a real query.
  const status = level === "error" ? pick([500, 502, 503]) : roll < 0.12 ? 404 : 200;
  const dur = 3 + Math.floor(random() * 900);
  rows.push({
    ts: new Date(START + i * 400).toISOString(),
    level,
    status,
    method: pick(METHODS),
    path: pick(PATHS),
    dur,
    bytes: 120 + Math.floor(random() * 65536),
    client_ip: `10.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`,
    req: { id: "r" + String(i).padStart(6, "0"), ua: pick(AGENTS) },
    upstream: { host: pick(HOSTS), attempts: roll < 0.05 ? 2 : 1 },
  });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
const bytes = fs.statSync(out).size;
console.log(`wrote ${out} (${lines} lines, ${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
