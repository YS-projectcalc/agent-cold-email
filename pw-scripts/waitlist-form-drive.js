const { chromium } = require("/Users/yaakovscher/.claude/skills/playwright-cli/node_modules/playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = "/Users/yaakovscher/dev/coldstart/site";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

const server = http.createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((r) => server.listen(8099, r));
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  let posted = null;
  await page.route("**/api/waitlist", async (route) => {
    posted = route.request().postData();
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });

  await page.goto("http://localhost:8099/", { waitUntil: "domcontentloaded" });
  await page.fill('form.waitlist input[type="email"]', "waitlist-test@example.com");
  await page.click("form.waitlist button");
  await page.waitForTimeout(1200);

  const status = (await page.textContent(".form-status")) || "";
  const inputVal = await page.inputValue('form.waitlist input[type="email"]');

  console.log("page errors      :", errors.length ? errors : "none");
  console.log("POST body sent   :", posted);
  console.log("status text      :", JSON.stringify(status.trim()));
  console.log("input cleared    :", inputVal === "");
  const pass = errors.length === 0 && posted && /on the list/i.test(status) && inputVal === "";
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");

  await browser.close();
  server.close();
  process.exit(pass ? 0 : 1);
})();
