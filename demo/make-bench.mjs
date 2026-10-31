#!/usr/bin/env node
/**
 * Writes the synthetic files behind the "Measured performance" table in the
 * README, so those numbers can be reproduced on your own machine.
 *
 *   node demo/make-bench.mjs --out bench-100mb.jsonl --mb 100
 *   node demo/make-bench.mjs --out bench-1gb.jsonl --gb 1
 *
 * The output is not identical to the demo log: it trades realism for size and
 * presses slightly larger rows, which is what makes the throughput budget.
 */
import fs from "node:fs";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const out = flag("--out", "bench-100mb.jsonl");
const megabytes = Number(flag("--gb", "0")) * 1024 || Number(flag("--mb", "100"));
const target = megabytes * 1024 * 1024;
const seed = Number(flag("--seed", "11"));

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
const START = Date.UTC(2026, 9, 1, 0, 0, 0);

const fd = fs.openSync(out, "w");
let written = 0;
let line = 0;
const buffer = [];
const FLUSH = 4096;
while (written < target) {
  const level = pick(LEVELS);
  const status = level === "error" ? pick([500, 502, 503]) : random() < 0.12 ? 404 : 200;
  const row = {
    ts: new Date(START + line * 400).toISOString(),
    level,
    status,
    method: pick(METHODS),
    path: pick(PATHS),
    dur: 3 + Math.floor(random() * 900),
    bytes: 120 + Math.floor(random() * 65536),
    client_ip: `10.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`,
    req: { id: "r" + String(line).padStart(8, "0"), ua: "curl/8.4.0" },
    upstream: { host: pick(HOSTS), attempts: random() < 0.05 ? 2 : 1 },
  };
  const text = JSON.stringify(row) + "\n";
  buffer.push(text);
  written += Buffer.byteLength(text);
  line += 1;
  if (buffer.length >= FLUSH) {
    fs.writeSync(fd, buffer.join(""));
    buffer.length = 0;
  }
}
if (buffer.length > 0) fs.writeSync(fd, buffer.join(""));
fs.closeSync(fd);
console.log(`wrote ${out} (${line.toLocaleString("en-US")} lines, ${(written / 1024 / 1024).toFixed(1)} MiB)`);
