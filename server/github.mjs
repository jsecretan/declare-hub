// GitHub, as the hub uses it: who you are, an app repo's facts, its forks,
// forking, creating a repo, and git over HTTPS with your token (so no SSH
// setup is needed — the same on Linux and macOS).
//
// The token comes from GITHUB_TOKEN or GH_TOKEN, else `gh auth token` (the
// GitHub CLI, if you are signed in to it), else ~/.config/declare-hub/token.
// Without one the hub still runs: public app repos clone and their forks list
// (at GitHub's 60-requests-an-hour anonymous limit), but changes stay local
// until you sign in.
//
// GITHUB_API and GITHUB_GIT point it elsewhere (a test double).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const API = (process.env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
export const GIT = (process.env.GITHUB_GIT || "https://github.com/").replace(/\/?$/, "/");

// ── the token ───────────────────────────────────────────────────────────

let token = null;
export async function findToken() {
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!token) try { token = (await run("gh", ["auth", "token"], { timeout: 5000 })).stdout.trim(); } catch {}
  if (!token) try { token = fs.readFileSync(path.join(os.homedir(), ".config/declare-hub/token"), "utf8").trim(); } catch {}
  return token;
}
export const hasToken = () => !!token;

// ── the REST API ────────────────────────────────────────────────────────

export class GitHubError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export async function api(method, p, body) {
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "declare-hub" };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    let msg = data?.message || `HTTP ${r.status}`;
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0")
      msg = token ? "GitHub's rate limit is used up for now; try again in a few minutes" : "GitHub's anonymous rate limit is used up — sign in (see the README) to raise it";
    if (r.status === 401) msg = "GitHub refused the token (expired or revoked?)";
    throw new GitHubError(r.status, msg);
  }
  return data;
}

// small TTL cache for reads that a page view repeats
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function forget(prefix) { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); }

let me = null;
export async function login() {
  if (!token) return null;
  if (me) return me;
  try { const u = await api("GET", "/user"); me = { login: u.login, name: u.name || u.login, avatar: u.avatar_url }; }
  catch (e) { console.log("[github] " + e.message); me = null; }
  return me;
}

const slim = (r) => r && ({
  repo: r.full_name, owner: r.owner?.login || "", avatar: r.owner?.avatar_url || "", branch: r.default_branch || "main",
  description: r.description || "", pushed: r.pushed_at || "", stars: r.stargazers_count || 0, forks: r.forks_count || 0,
  fork: !!r.fork, parent: r.parent?.full_name || "", source: r.source?.full_name || "", url: r.html_url || "",
});

export function repoInfo(full, fresh = false) {
  if (fresh) forget("repo:" + full);
  return cached("repo:" + full, 10 * 60e3, async () => slim(await api("GET", `/repos/${full}`)));
}

// The app's whole family: the root of its fork network, the root's forks,
// and their forks one level further — each compared with `sha` (the commit
// the hub is on), newest push first.
export function forksOf(full, sha) {
  return cached(`forks:${full}:${sha}`, 2 * 60e3, async () => {
    const here = await repoInfo(full);
    const root = here.source || here.repo;
    const rootInfo = root === here.repo ? here : await repoInfo(root);
    const family = [rootInfo];
    const kids = (await api("GET", `/repos/${root}/forks?sort=newest&per_page=60`)).map(slim);
    family.push(...kids);
    for (const k of kids.filter((k) => k.forks > 0).slice(0, 8))
      try { family.push(...(await api("GET", `/repos/${k.repo}/forks?sort=newest&per_page=30`)).map(slim)); } catch {}
    const seen = new Set();
    const out = family.filter((f) => !seen.has(f.repo) && seen.add(f.repo));
    await Promise.all(out.slice(0, 40).map(async (f) => {
      try {
        const c = await api("GET", `/repos/${f.repo}/compare/${sha}...${f.branch}`);
        f.ahead = c.ahead_by; f.behind = c.behind_by;
        const last = c.commits?.[c.commits.length - 1];
        // its tip: the last commit it has that we don't, else (nothing ahead) the merge base
        f.head = c.ahead_by > 0 && last ? last.sha : (c.merge_base_commit?.sha || null);
        f.lastMessage = last?.commit?.message?.split("\n")[0] || "";
      } catch { f.ahead = null; f.behind = null; }
    }));
    out.sort((a, b) => (b.pushed || "").localeCompare(a.pushed || ""));
    return { root, forks: out };
  });
}

// your fork of a repo — GitHub hands back the existing one if you have it
export async function fork(full) {
  const r = await api("POST", `/repos/${full}/forks`, { default_branch_only: true });
  // forking is asynchronous: wait until its git data answers
  for (let i = 0; i < 30; i++) {
    try { await api("GET", `/repos/${r.full_name}/commits?per_page=1`); break; }
    catch { await new Promise((ok) => setTimeout(ok, 1000)); }
  }
  forget("repo:" + r.full_name);
  return slim(r);
}

export async function createRepo(name, description) {
  const r = await api("POST", "/user/repos", { name, description, auto_init: false, has_wiki: false, has_projects: false });
  try { await api("PUT", `/repos/${r.full_name}/topics`, { names: ["declare-app"] }); } catch {}
  return slim(r);
}

// apps anyone has published: repos tagged with the declare-app topic
export function searchApps(q = "") {
  return cached("search:" + q, 5 * 60e3, async () => {
    const r = await api("GET", `/search/repositories?q=${encodeURIComponent(("topic:declare-app " + q).trim())}+fork:true&sort=updated&per_page=40`);
    return (r.items || []).map(slim);
  });
}

// ── git, authenticated by header (the token never lands in a remote URL) ─

export const cloneUrl = (full) => GIT + full + ".git";

export async function git(cwd, ...args) {
  const auth = token && GIT.startsWith("https://")
    ? ["-c", `http.${GIT}.extraheader=AUTHORIZATION: basic ${Buffer.from("x-access-token:" + token).toString("base64")}`] : [];
  const { stdout } = await run("git", [...auth, ...args], { cwd, maxBuffer: 32 << 20, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}
