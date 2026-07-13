// apps/platform/public/README.md's M2 responsibility: keep public/index.html
// (the SPA-fallback target `not_found_handling = "single-page-application"`
// serves for any unmatched path under /app/*) in sync with the real build's
// public/app/index.html. Run as this package's `build` postbuild step, not a
// manually-maintained file.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../platform/public");
copyFileSync(resolve(publicDir, "app/index.html"), resolve(publicDir, "index.html"));
console.log("synced public/app/index.html -> public/index.html");
