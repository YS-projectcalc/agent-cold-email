/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPEC.md §19.1 — built with base '/app/' into apps/platform/public/app/, so
// the platform Worker's [assets] binding serves it same-origin under /app/*
// (see apps/platform/wrangler.toml + apps/platform/public/README.md). The
// root public/index.html copy (SPA-fallback target) is produced by
// scripts/sync-root-index.mjs, run as this package's `build` postbuild step.
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../platform/public/app",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
