#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeModules = ["database", "ui", "window"];
const missingModules = nativeModules.filter(
  (name) => !existsSync(resolve(rootDir, "modules", name, "index.node"))
);

if (missingModules.length === 0) {
  process.exit(0);
}

console.warn(
  `[native-modules] Missing native module builds: ${missingModules.join(", ")}`
);
console.warn("[native-modules] Running pnpm build:modules before startup.");

const result = spawnSync("pnpm", ["run", "build:modules"], {
  cwd: rootDir,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(`[native-modules] ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
