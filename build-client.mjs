#!/usr/bin/env node
/**
 * Bundle `src/client/standalone-app.tsx` into `dist/client/app.js` and copy
 * `src/client/index.html` into `dist/client/index.html` using esbuild.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(rootDir, "dist", "client");

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "client", "standalone-app.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(outDir, "app.js"),
  jsx: "automatic",
  sourcemap: false,
  minify: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

fs.copyFileSync(
  path.join(rootDir, "src", "client", "index.html"),
  path.join(outDir, "index.html"),
);

console.log("[build-client] Built dist/client/app.js and dist/client/index.html");
