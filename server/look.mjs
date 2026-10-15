// Takes a picture of one app the way it shows in its window: the app's
// program is compiled by the Declare dev server and rendered in headless
// Chrome at the window's content size (from its declare-app.json). The picture goes to
// state/looks/<id>.png, for the agent to read with its (image-capable) read
// tool. Runtime errors seen while it loads come back with it.
//
//   node ../server/look.mjs <app-id>      (from apps/, as the agent runs it)

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = path.join(ROOT, "apps");
const LOOKS = path.join(ROOT, "state", "looks");
const DEV = process.env.DECLARE_URL || "http://127.0.0.1:8870";
const BAR_H = 35;   // the window's title bar (AppWindow.barH); the app gets the rest

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  try {
    const builds = fs.readdirSync(cache).sort().reverse();
    for (const b of builds) {
      for (const exe of ["chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
        const p = path.join(cache, b, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"])
    if (fs.existsSync(p)) return p;
  throw new Error("no Chrome found (set CHROME to its path)");
}

export function appInfo(id) {
  const dir = path.join(APPS, id);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "declare-app.json"), "utf8")); }
  catch { throw new Error(`no app "${id}" (apps/${id}/declare-app.json is missing or not JSON)`); }
  if (!m.main) throw new Error(`apps/${id}/declare-app.json has no "main"`);
  return { id, title: m.title || id, program: `apps/${id}/${String(m.main).replace(/^\.\//, "").replace(/\.declare$/, "")}`,
    width: m.width || 480, height: m.height || 420 };
}

export async function look(id) {
  const a = appInfo(id);
  const size = { width: a.width, height: a.height - BAR_H };
  fs.mkdirSync(LOOKS, { recursive: true });
  const file = path.join(LOOKS, id + ".png");
  const errors = [];
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true,
    args: ["--no-sandbox", `--window-size=${size.width},${size.height}`], defaultViewport: size });
  try {
    const page = await browser.newPage();
    let built;
    const ready = new Promise((r) => { built = r; });
    page.on("console", (m) => {
      const t = m.text();
      if (/\[Declare\] built/.test(t)) built();
      else if (m.type() === "error" && !/favicon/.test(t)) errors.push(t);
    });
    page.on("pageerror", (e) => { errors.push(e.message); built(); });
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} for ${r.url().replace(DEV, "")}`); });
    await page.goto(`${DEV}/${a.program}.declare`, { waitUntil: "load", timeout: 30000 });
    let timer;
    await Promise.race([ready, new Promise((r) => { timer = setTimeout(r, 15000); })]);
    clearTimeout(timer);
    await new Promise((r) => setTimeout(r, 1200));   // let it settle and finish opening animations
    await page.screenshot({ path: file });
  } finally {
    await browser.close();
  }
  return { ...a, ...size, file, errors: [...new Set(errors)].slice(0, 10) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const id = process.argv[2];
  if (!id) { console.error("usage: node ../server/look.mjs <app-id>"); process.exit(2); }
  try {
    const r = await look(id);
    console.log(`Picture of ${r.title} at its window size (${r.width}×${r.height}): ${r.file}`);
    console.log("Read that file to see it.");
    if (r.errors.length) console.log("Errors while it loaded:\n" + r.errors.join("\n"));
  } catch (e) { console.error("look failed: " + e.message); process.exit(1); }
}
