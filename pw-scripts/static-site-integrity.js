const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve("site");
const htmlFiles = fs.readdirSync(root).filter((name) => name.endsWith(".html"));
const failures = [];

function localTarget(fromFile, rawValue) {
  const value = rawValue.split("#")[0].split("?")[0];
  if (!value || value.startsWith("#") || /^(https?:|mailto:|tel:|data:)/.test(value)) return null;
  if (value === "/app" || value.startsWith("/app/")) return null;
  let target = value.startsWith("/") ? path.join(root, value.slice(1)) : path.resolve(path.dirname(fromFile), value);
  if (value === "/") target = path.join(root, "index.html");
  if (!path.extname(target) && !fs.existsSync(target)) target = `${target}.html`;
  return target;
}

for (const name of htmlFiles) {
  const file = path.join(root, name);
  const html = fs.readFileSync(file, "utf8");
  if (!/<title>[^<]+<\/title>/i.test(html)) failures.push(`${name}: missing non-empty title`);
  if (!/<h1(?:\s|>)[\s\S]*?<\/h1>/i.test(html)) failures.push(`${name}: missing h1`);
  const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html);
  if (!noindex && !/<link[^>]+rel=["']canonical["']/i.test(html)) failures.push(`${name}: indexable page missing canonical`);

  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const target = localTarget(file, match[1]);
    if (target && !fs.existsSync(target)) failures.push(`${name}: missing local target ${match[1]}`);
  }
}

const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
for (const match of sitemap.matchAll(/<loc>https:\/\/coldrig\.dev\/([^<]*)<\/loc>/g)) {
  const route = match[1];
  const target = route === "" ? path.join(root, "index.html") : path.join(root, path.extname(route) ? route : `${route}.html`);
  if (!fs.existsSync(target)) failures.push(`sitemap.xml: missing route target /${route}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  process.stdout.write(`OK — ${htmlFiles.length} HTML pages, local links/assets, canonical coverage, and sitemap targets verified.\n`);
}
