// The registry: which apps this hub runs, each as a GitHub repo pinned to a
// commit, and the checkouts that hold them.
//
//   state/registry/registry.json   { apps: [ { id, repo: "owner/name", ref: <sha>, pending? } ] }
//   apps/<id>/                     a git clone of that repo at that commit
//   previews/<owner>--<name>--<sha7>/   a fork being tried out before it is chosen
//
// The registry is a git repository of its own (every change is a commit);
// with HUB_REGISTRY_REPO=owner/name it is also pulled at start and pushed on
// every change, so another machine signed in to the same account runs the
// same hub. Each app repo holds a `declare-app.json` manifest beside its
// program.

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import * as gh from "./github.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APPS = path.join(ROOT, "apps");
export const PREVIEWS = path.join(ROOT, "previews");
const REG_DIR = path.join(ROOT, "state", "registry");
const REG = path.join(REG_DIR, "registry.json");
const DEFAULT = path.join(ROOT, "registry.default.json");
const REG_REPO = process.env.HUB_REGISTRY_REPO || "";

export const appDir = (id) => path.join(APPS, id);
const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

// ── the registry file ───────────────────────────────────────────────────

async function regGit(...args) { return gh.git(REG_DIR, ...args); }

export async function initRegistry() {
  fs.mkdirSync(APPS, { recursive: true });
  if (!fs.existsSync(path.join(REG_DIR, ".git"))) {
    if (REG_REPO) {
      try { await gh.git(ROOT, "clone", "-q", gh.cloneUrl(REG_REPO), REG_DIR); }
      catch (e) { console.log(`[registry] could not clone ${REG_REPO} (${e.message.split("\n")[0]}); starting a local one`); }
    }
    if (!fs.existsSync(path.join(REG_DIR, ".git"))) {
      fs.mkdirSync(REG_DIR, { recursive: true });
      await regGit("init", "-q", "-b", "main");
      if (REG_REPO) await regGit("remote", "add", "origin", gh.cloneUrl(REG_REPO));
    }
    await ensureIdentity(REG_DIR);
    if (!fs.existsSync(REG)) {
      fs.copyFileSync(DEFAULT, REG);
      await regGit("add", "-A");
      await regGit("commit", "-q", "-m", "registry: the default apps");
      if (REG_REPO && gh.hasToken()) await regGit("push", "-q", "-u", "origin", "HEAD:main").catch((e) => console.log("[registry] push: " + e.message.split("\n")[0]));
    }
  } else if (REG_REPO) {
    try { await regGit("pull", "-q", "--ff-only", "origin", "main"); } catch (e) { console.log("[registry] pull: " + e.message.split("\n")[0]); }
  }
}

export function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REG, "utf8")); } catch { return { apps: [] }; }
}

export async function writeRegistry(reg, msg) {
  const text = JSON.stringify(reg, null, 2) + "\n";
  if (fs.existsSync(REG) && fs.readFileSync(REG, "utf8") === text) return;
  fs.writeFileSync(REG, text);
  await regGit("add", "-A");
  await regGit("commit", "-q", "-m", msg.slice(0, 200));
  if (REG_REPO && gh.hasToken()) regGit("push", "-q", "origin", "HEAD:main").catch((e) => console.log("[registry] push: " + e.message.split("\n")[0]));
}

export async function updateEntry(id, fields, msg) {
  const reg = readRegistry();
  const e = reg.apps.find((a) => a.id === id);
  if (!e) return null;
  Object.assign(e, fields);
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  await writeRegistry(reg, msg);
  return e;
}

// ── checkouts ───────────────────────────────────────────────────────────

async function ensureIdentity(dir) {
  // commits carry your own git identity; a machine without one gets a neutral one
  try { await gh.git(dir, "config", "user.email"); }
  catch { await gh.git(dir, "config", "user.name", "Declare Hub"); await gh.git(dir, "config", "user.email", "hub@localhost"); }
}

export const appGit = (id, ...args) => gh.git(appDir(id), ...args);
async function setOrigin(id, url) {
  if ((await appGit(id, "remote", "get-url", "origin").catch(() => "")) === url) return;
  await appGit(id, "remote", "remove", "origin").catch(() => {});
  await appGit(id, "remote", "add", "origin", url);
}
export async function headOf(id) { return appGit(id, "rev-parse", "HEAD"); }
export async function isDirty(id) { return (await appGit(id, "status", "--porcelain")) !== ""; }

// Bring apps/<id> to its registry commit: clone it if it is missing, move
// it if the registry moved (unless it holds work that isn't published yet).
export async function checkout(entry) {
  const dir = appDir(entry.id);
  // made here and not published yet (no GitHub sign-in when it was made)
  if (entry.repo.startsWith("local/")) return { sha: await headOf(entry.id), moved: false };
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    await gh.git(ROOT, "clone", "-q", gh.cloneUrl(entry.repo), dir);
    await ensureIdentity(dir);
  }
  const url = gh.cloneUrl(entry.repo);
  if ((await appGit(entry.id, "remote", "get-url", "origin").catch(() => "")) !== url) {
    await appGit(entry.id, "remote", "remove", "origin").catch(() => {});
    await appGit(entry.id, "remote", "add", "origin", url);
  }
  const sha = /^[0-9a-f]{40}$/.test(entry.ref || "") ? entry.ref : null;
  if (sha && (await headOf(entry.id)) === sha) return { sha, moved: false };
  if (entry.pending || (await isDirty(entry.id))) return { sha: await headOf(entry.id), moved: false };
  if (sha) {
    try { await appGit(entry.id, "cat-file", "-e", sha + "^{commit}"); }
    catch { await appGit(entry.id, "fetch", "-q", "origin", sha).catch(() => appGit(entry.id, "fetch", "-q", "origin")); }
    await appGit(entry.id, "checkout", "-q", "-B", "main", sha);
    return { sha, moved: true };
  }
  // a branch name (the default registry says "main"): pin whatever it is now
  await appGit(entry.id, "fetch", "-q", "origin", entry.ref || "HEAD");
  await appGit(entry.id, "checkout", "-q", "-B", "main", "FETCH_HEAD");
  return { sha: await headOf(entry.id), moved: true };
}

// every registry app present at its commit; refs that were branch names get pinned
export async function syncAll() {
  const reg = readRegistry();
  const problems = [];
  let pinned = false;
  for (const e of reg.apps) {
    try {
      const { sha } = await checkout(e);
      if (e.ref !== sha && !e.pending) { e.ref = sha; pinned = true; }
    } catch (err) { problems.push(`${e.id} (${e.repo}): ${err.message.split("\n")[0]}`); }
  }
  if (pinned) await writeRegistry(reg, "registry: pin the apps' commits");
  return problems;
}

// ── manifests ───────────────────────────────────────────────────────────
// declare-app.json: { id, title, label?, main, glyph?, hue1?, hue2?, ink?, blurb?, width?, height? }

export function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "declare-app.json"), "utf8"));
  const main = String(m.main || "").replace(/^\.\//, "");
  if (!main.endsWith(".declare")) throw new Error(`declare-app.json: "main" should name the app's .declare file`);
  if (!fs.existsSync(path.join(dir, main))) throw new Error(`declare-app.json: main "${main}" does not exist`);
  return { ...m, main };
}

export function checkManifest(dir) {
  const problems = [];
  let m;
  try { m = readManifest(dir); } catch (e) { return [e.message]; }
  if (!m.title) problems.push("declare-app.json needs a title");
  for (const k of ["width", "height"]) if (m[k] != null && !(m[k] >= 200 && m[k] <= 1600)) problems.push(`declare-app.json: ${k} should be 200–1600`);
  for (const k of ["hue1", "hue2", "ink"]) if (m[k] != null && !/^#[0-9a-fA-F]{6}$/.test(m[k])) problems.push(`declare-app.json: ${k} should look like "#RRGGBB"`);
  return problems;
}

// what the portal shows: registry entries joined with their manifests
export function listApps(me) {
  const out = [];
  for (const e of readRegistry().apps) {
    let m = {};
    try { m = readManifest(appDir(e.id)); } catch { m = { title: e.id, main: "", broken: true }; }
    const owner = e.repo.split("/")[0];
    out.push({
      id: e.id, label: m.label || m.title, title: m.title, glyph: m.glyph || "", hue1: m.hue1 || "", hue2: m.hue2 || "", ink: m.ink || "",
      blurb: m.blurb || "", width: m.width || 480, height: m.height || 420,
      program: m.main ? `apps/${e.id}/${m.main.replace(/\.declare$/, "")}` : "",
      repo: e.repo, owner, ref: e.ref || "", mine: !!me && owner === me.login, pending: !!e.pending, broken: !!m.broken,
    });
  }
  return out;
}

// ── publishing: your change goes to a repo of yours ─────────────────────
// The app's repo if it is yours; else your repo in its fork network (the
// root, if you own that; else your fork, made now if needed). The commit
// lands on that repo's default branch when it follows on from it, else on
// a new branch, so nothing there is ever overwritten. The registry follows.

export async function publish(id, me) {
  const reg = readRegistry();
  const e = reg.apps.find((a) => a.id === id);
  if (!e) throw new Error("no such app");
  const sha = await headOf(id);
  if (!me) {
    await updateEntry(id, { ref: sha, pending: true }, `${id}: local change (not signed in to GitHub)`);
    return { repo: e.repo, sha, local: true };
  }
  if (e.repo.startsWith("local/")) {
    // a new app: its own repo, declare-app-<id> (or -2, -3… if that name is taken)
    const m = readManifest(appDir(id));
    let name = "declare-app-" + id;
    for (let n = 2; ; n++) {
      try { e.repo = (await gh.createRepo(name, m.blurb || m.title)).repo; break; }
      catch (err) { if (err.status === 422 && n < 8) { name = `declare-app-${id}-${n}`; continue; } throw err; }
    }
    await writeRegistry(reg, `${id}: published as ${e.repo}`);
  }
  let target = e.repo, forked = false;
  if (e.repo.split("/")[0] !== me.login) {
    const info = await gh.repoInfo(e.repo);
    const root = info.source || info.repo;
    if (root.split("/")[0] === me.login) target = root;
    else { target = (await gh.fork(e.repo)).repo; forked = true; }
  }
  const tInfo = await gh.repoInfo(target, true);
  const url = gh.cloneUrl(target);
  let branch = tInfo.branch;
  try {
    await appGit(id, "push", "-q", url, `HEAD:refs/heads/${branch}`);
  } catch {
    // their branch has moved on (or a fresh fork carries newer commits): keep both
    branch = "hub-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    await appGit(id, "push", "-q", url, `HEAD:refs/heads/${branch}`);
  }
  await setOrigin(id, url);
  gh.forget("forks:");
  await updateEntry(id, { repo: target, ref: sha, pending: undefined }, `${id}: ${forked ? "fork to" : "update"} ${target}@${sha.slice(0, 7)}`);
  return { repo: target, sha, branch, forked };
}

// a new app the agent made in apps/<id>/: its own repo, then the registry
export async function adopt(id, me, msg = "A new Declare app") {
  const dir = appDir(id);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await gh.git(dir, "init", "-q", "-b", "main");
    await ensureIdentity(dir);
  }
  await gh.git(dir, "add", "-A");
  try { await gh.git(dir, "commit", "-q", "-m", msg.slice(0, 200)); } catch {}
  readManifest(dir);
  const reg = readRegistry();
  if (!reg.apps.some((a) => a.id === id)) reg.apps.push({ id, repo: `local/${id}`, ref: await headOf(id), pending: true });
  await writeRegistry(reg, `${id}: new app`);
  return publish(id, me);
}

// ── other forks: try one, then choose it ────────────────────────────────

export async function preview(repo, ref) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]{1,100}$/.test(ref) || ref.includes("..")) throw new Error("bad fork");
  // a branch name is fetched to learn its commit; a commit we already have is reused
  let sha = /^[0-9a-f]{40}$/.test(ref) ? ref : "";
  let dir = sha ? path.join(PREVIEWS, repo.replace("/", "--") + "--" + sha.slice(0, 7)) : "";
  if (!dir || !fs.existsSync(path.join(dir, "declare-app.json"))) {
    const tmp = path.join(PREVIEWS, ".fetching-" + process.pid + "-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await gh.git(tmp, "init", "-q");
      await gh.git(tmp, "fetch", "-q", "--depth", "1", gh.cloneUrl(repo), ref);
      await gh.git(tmp, "checkout", "-q", "FETCH_HEAD");
      sha = await gh.git(tmp, "rev-parse", "HEAD");
      dir = path.join(PREVIEWS, repo.replace("/", "--") + "--" + sha.slice(0, 7));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const m = readManifest(dir);
  return { ...m, sha, program: path.relative(ROOT, path.join(dir, m.main.replace(/\.declare$/, ""))).split(path.sep).join("/"), dir };
}

export async function choose(id, repo, ref) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]{1,100}$/.test(ref) || ref.includes("..")) throw new Error("bad fork");
  const reg = readRegistry();
  const e = reg.apps.find((a) => a.id === id);
  if (!e) throw new Error("no such app");
  if (e.pending) throw new Error("this app has a change that isn't on GitHub yet — publish it first, or it would be lost");
  if (await isDirty(id)) throw new Error("this app has unsaved edits");
  await appGit(id, "fetch", "-q", gh.cloneUrl(repo), ref);
  const sha = await appGit(id, "rev-parse", "FETCH_HEAD");
  await readManifestAt(id, sha);
  await appGit(id, "checkout", "-q", "-B", "main", sha);
  await setOrigin(id, gh.cloneUrl(repo));
  await updateEntry(id, { repo, ref: sha }, `${id}: use ${repo}@${sha.slice(0, 7)}`);
  return { sha };
}

// refuse a commit that isn't a Declare app before moving to it
async function readManifestAt(id, sha) {
  try { JSON.parse(await appGit(id, "show", `${sha}:declare-app.json`)); }
  catch { throw new Error("that version has no declare-app.json — it isn't a Declare app"); }
}

export async function addApp(repo, me) {
  const info = await gh.repoInfo(repo);
  const reg = readRegistry();
  if (reg.apps.some((a) => a.repo === repo)) throw new Error("already in your hub");
  let base = repo.split("/")[1].replace(/^declare-app-/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30) || "app";
  let id = base;
  for (let n = 2; reg.apps.some((a) => a.id === id) || fs.existsSync(appDir(id)); n++) id = `${base}-${n}`;
  const e = { id, repo: info.repo, ref: info.branch };
  const { sha } = await checkout(e);
  readManifest(appDir(id));          // refuse a repo that isn't a Declare app
  reg.apps.push({ id, repo: info.repo, ref: sha });
  await writeRegistry(reg, `${id}: add ${info.repo}`);
  return id;
}

export async function removeApp(id, force = false) {
  const reg = readRegistry();
  const e = reg.apps.find((a) => a.id === id);
  if (!e) throw new Error("no such app");
  if (!force && (e.pending || (fs.existsSync(path.join(appDir(id), ".git")) && await isDirty(id))))
    throw new Error("this app has changes that aren't on GitHub yet — publish them first, or they'd be lost");
  reg.apps = reg.apps.filter((a) => a.id !== id);
  await writeRegistry(reg, `${id}: remove`);
  fs.rmSync(appDir(id), { recursive: true, force: true });
}

export { safeId };
