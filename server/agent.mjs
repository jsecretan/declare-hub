// The agent bridge: one long-lived `pi --mode rpc` process working in apps/
// (one folder per app, each a git clone of the app's GitHub repo), its event
// stream turned into chat operations the shell applies, and the bookkeeping
// around each turn — a snapshot of every app before, verification after
// (with automatic repair), a look at each changed app, a commit in each
// changed app's repo, and publishing: the commit goes to a repo of yours on
// GitHub (forking the app first if it isn't yours), and the registry is
// pinned to it.
//
// HTTP surface (proxied from the Declare dev server under /api):
//   GET  /api/events            SSE: {op:"reset"|"push"|"append"|"patch"|"state"|"chats", …}
//   POST /api/prompt  {text}    start a turn
//   POST /api/abort             stop the running turn
//   POST /api/undo              revert the last agent change (and publish the revert)
//   POST /api/newchat {app?, title?}  fresh agent session + empty transcript (for an app: scoped to it)
//   POST /api/chats/open {id}   go back to a saved chat
//   POST /api/chats/forapp {app, title}  the chat attached to one app's window
//   POST /api/chats/delete {id} forget a saved chat
//   GET  /api/hub               { me, apps, rev } — the registry as the portal shows it
//   GET  /api/forks/<id>        the app's fork family, compared with what the hub runs
//   POST /api/preview {repo, sha}    fetch a fork to try it (→ its program path)
//   POST /api/use {id, repo, sha}    run that fork from now on (the registry follows)
//   POST /api/publish {id}      push an app's local change (after signing in)
//   GET  /api/explore?q=        Declare apps on GitHub (the declare-app topic)
//   POST /api/add {repo}        add one to the hub
//   POST /api/remove {id}       take one out (its repo stays on GitHub)
//   GET|PUT /api/store/<app>/<key>   a tiny JSON store for apps

import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

import { look } from "./look.mjs";
import * as gh from "./github.mjs";
import * as reg from "./registry.mjs";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = reg.APPS;                       // the agent's working directory
const STATE = path.join(ROOT, "state");
const STORE = path.join(STATE, "store");
const VERIFY = path.join(ROOT, "node_modules/declarelang/tools/verify.mjs");
const NOTES = path.join(ROOT, "hub", "AGENTS.md");

const PORT = +(process.env.AGENT_PORT || 8871);
const PROVIDER = process.env.PI_PROVIDER || "strata";
const MODEL = process.env.PI_MODEL || "qwen3.8-flash-next-iq3_s";
// the status dot polls Strata; a hosted model has no health endpoint to poll,
// so it shows as ready (set STRATA_HEALTH to poll a local server anyway)
const STRATA_HEALTH = process.env.STRATA_HEALTH || (PROVIDER === "strata" ? "http://127.0.0.1:8080/health" : "");
const MAX_REPAIRS = 2;
// after a clean verify, take pictures of the changed apps and let the model
// check them once (LOOK=0 turns it off; it needs an image-capable model)
const LOOK = process.env.LOOK !== "0";
const MAX_LOOKS = 3;

const CHATS = path.join(STATE, "chats");
const SESSIONS = path.join(STATE, "sessions");
const UNDO = path.join(STATE, "undo.json");
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(CHATS, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

let me = null;   // { login, name, avatar } once signed in to GitHub

// ── the transcript and its subscribers ──────────────────────────────────

const state = {
  blocks: [],            // { id, kind: user|assistant|thinking|tool|system, text, name?, status?, output? }
  busy: false,
  rev: 1,                // the portal re-reads the registry when this moves
  changed: [],           // the ids of the apps the last move changed (their windows reopen)
  model: "unknown",      // ready | asleep | loading | offline
  canUndo: false,
};
let seq = 0;
const clients = new Set();

function send(res, msg) { res.write(`data: ${JSON.stringify(msg)}\n\n`); }
function broadcast(msg) { for (const c of clients) send(c, msg); }
function stateMsg() {
  return { op: "state", busy: state.busy, rev: state.rev, scope: "apps", changed: state.changed,
    broken: "", model: state.model, modelName: MODEL, canUndo: state.canUndo };
}
function pushBlock(b) {
  foldThinking();
  const block = { id: "b" + ++seq, text: "", ...b };
  state.blocks.push(block);
  broadcast({ op: "push", block });
  saveSoon();
  return state.blocks.length - 1;
}
function patchBlock(i, fields) {
  flushAppends();
  Object.assign(state.blocks[i], fields);
  broadcast({ op: "patch", i, fields });
  saveSoon();
}
// a thinking block streams open; anything after it folds it to "Thought"
function foldThinking() {
  const i = state.blocks.length - 1;
  if (i >= 0 && state.blocks[i].kind === "thinking" && state.blocks[i].status !== "done") patchBlock(i, { status: "done" });
}
function system(text) { flushAppends(); return pushBlock({ kind: "system", text }); }
function setState(fields) { Object.assign(state, fields); broadcast(stateMsg()); }

// text deltas arrive per token; coalesce them to ~20 updates a second
const pending = new Map();   // block index → buffered text
let flushTimer = null;
function append(i, text) {
  state.blocks[i].text += text;
  pending.set(i, (pending.get(i) || "") + text);
  if (!flushTimer) flushTimer = setTimeout(flushAppends, 50);
}
function flushAppends() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const [i, text] of pending) broadcast({ op: "append", i, text });
  if (pending.size) saveSoon();
  pending.clear();
}

// ── chats: every conversation is kept ───────────────────────────────────
// state/chats/<id>.json holds a chat's transcript and the pi session file it
// belongs to, so going back to a chat brings back the agent's memory of it
// too. state/chats/index.json names the open one; a restart resumes it.
// A chat opened from an app window's ✦ belongs to that app (`app`, its id):
// its prompts tell the agent to stay inside the app, and whatever a turn
// changes outside it is put back.

const chat = { id: "", title: "", created: 0, updated: 0, sessionFile: "", app: "", appTitle: "" };
const chatFile = (id) => path.join(CHATS, id + ".json");
const newChatId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);

function readChat(id) {
  try { return JSON.parse(fs.readFileSync(chatFile(id), "utf8")); } catch { return null; }
}
function saveChat() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!chat.id || state.blocks.length === 0) return;   // an empty chat is not worth keeping
  chat.updated = Date.now();
  fs.writeFileSync(chatFile(chat.id), JSON.stringify({ ...chat, blocks: state.blocks }));
  fs.writeFileSync(path.join(CHATS, "index.json"), JSON.stringify({ current: chat.id }));
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveChat, 1000); }

function listChats() {
  const out = [];
  for (const f of fs.readdirSync(CHATS)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const c = readChat(f.slice(0, -5));
    if (c) out.push({ id: c.id, title: c.title || "Untitled chat", updated: c.updated, count: (c.blocks || []).filter((b) => b.kind === "user").length, app: c.app || "", appTitle: c.appTitle || "" });
  }
  if (chat.id && !out.some((c) => c.id === chat.id) && state.blocks.length) out.push({ id: chat.id, title: chat.title, updated: Date.now(), count: 1, app: chat.app, appTitle: chat.appTitle });
  return out.sort((a, b) => b.updated - a.updated);
}
function chatsMsg() { return { op: "chats", current: chat.id, app: chat.app, appTitle: chat.appTitle, chats: listChats() }; }
function announceChats() { broadcast(chatsMsg()); }

function beginChat(app = "", appTitle = "") {
  Object.assign(chat, { id: newChatId(), title: "", created: Date.now(), updated: Date.now(), sessionFile: "", app, appTitle });
  state.blocks = [];
  seq = 0;
}
// the chat to resume at startup: the last open one, else a fresh one
function resumeChat() {
  let cur = null;
  try { cur = readChat(JSON.parse(fs.readFileSync(path.join(CHATS, "index.json"), "utf8")).current); } catch {}
  if (!cur) { beginChat(); return; }
  Object.assign(chat, { id: cur.id, title: cur.title || "", created: cur.created || Date.now(), updated: cur.updated || Date.now(), sessionFile: cur.sessionFile || "", app: cur.app || "", appTitle: cur.appTitle || "" });
  state.blocks = cur.blocks || [];
  seq = state.blocks.reduce((n, b) => Math.max(n, +String(b.id).slice(1) || 0), 0);
}
// after pi starts or changes session: remember which file this chat lives in
async function noteSession() {
  const r = await command({ type: "get_state" });
  if (r.success && r.data?.sessionFile) chat.sessionFile = r.data.sessionFile;
}

// ── pi ──────────────────────────────────────────────────────────────────

let pi = null;
let cmdSeq = 0;
const waiting = new Map();   // command id → resolve

function systemPrompt() {
  return fs.readFileSync(NOTES, "utf8");
}

function startPi() {
  const args = [
    "--mode", "rpc", "--session-dir", SESSIONS,
    "--provider", PROVIDER, "--model", MODEL,
    "--no-context-files", "--no-skills", "--no-prompt-templates",
    "--append-system-prompt", systemPrompt(),
  ];
  if (!process.env.PI_EXTENSIONS) args.push("--no-extensions", "--no-mcp");
  // the open chat's session, so the agent remembers it (else pi starts a new one)
  if (chat.sessionFile && fs.existsSync(chat.sessionFile)) args.push("--session", chat.sessionFile);
  pi = spawn("pi", args, { cwd: WORK, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  let buf = "";
  pi.stdout.setEncoding("utf8");
  pi.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {   // records split on LF only (never readline)
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      onRecord(rec);
    }
  });
  pi.stderr.setEncoding("utf8");
  pi.stderr.on("data", (d) => process.stderr.write("[pi] " + d));
  pi.on("exit", (code) => {
    pi = null;
    if (state.busy) { system(`The agent process exited (code ${code}).`); finishTurn(true); }
  });
}

function command(cmd) {
  if (!pi) { startPi(); if (cmd.type !== "get_state") noteSession(); }
  const id = "c" + ++cmdSeq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    pi.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
  });
}

// per assistant message: content index → transcript block
let blockOf = new Map();
const toolBlock = new Map();  // toolCallId → transcript block

// ── tool calls, told in the user's terms ─────────────────────────────────
// The person at the panel is using apps, not reading their source:
// "Changing the Dice app", not `edit dice/dice.declare`.

function appLabels() {
  const out = {};
  for (const a of reg.listApps(me)) out[a.id] = a.label || a.title || a.id;
  return out;
}
function rel(p) {
  if (!p) return "";
  p = String(p).replace(/^["']|["']$/g, "");
  if (path.isAbsolute(p)) p = path.relative(WORK, p);
  return p.replace(/^\.\//, "");
}
// what a file is, to the person using the hub
function thing(p) {
  p = rel(p);
  if (p.startsWith("..") || p.includes("node_modules/declarelang")) return /AGENTS/.test(p) ? "its notes" : "the Declare guide";
  // "todo.declare" run from inside the app's folder names the app too
  const bare = p.match(/^([\w-]+)\.(?:declare|json)$/);
  if (bare && appLabels()[bare[1]]) p = bare[1] + "/";
  const m = p.match(/^([\w-]+)(\/|$)/);
  if (m && m[1] !== "." ) {
    const label = appLabels()[m[1]] || m[1].replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
    return `the ${label} app`;
  }
  return "the apps";
}
function bashTarget(cmd) {
  const f = cmd.match(/(?:\.\.\/|\/)?[\w./-]*\.(?:declare|json|md)\b/);
  return f ? thing(f[0]) : "the apps";
}
function pictureOf(s) {
  const m = String(s || "").match(/looks\/(\w[\w-]*)\.png|look\.mjs\s+(\w[\w-]*)/);
  return m ? thing(`${m[1] || m[2]}/`) : null;
}
function describe(name, a = {}) {
  if (name === "read" && pictureOf(a.path)) return "Checking how " + pictureOf(a.path) + " looks";
  if (name === "bash" && /look\.mjs/.test(a.command || "")) return "Taking a picture of " + (pictureOf(a.command) || "the app");
  if (name === "read") return "Looking at " + thing(a.path);
  if (name === "edit") return "Changing " + thing(a.path);
  if (name === "write") {
    const exists = a.path && fs.existsSync(path.resolve(WORK, rel(a.path)));
    return (exists ? "Rewriting " : "Creating ") + thing(a.path);
  }
  if (name === "bash") {
    const c = a.command || "";
    if (/declare-verify|verify\.mjs/.test(c)) return "Testing " + bashTarget(c);
    if (/declare-help/.test(c)) return "Looking something up in the Declare guide";
    if (/^\s*(ls|cat|head|tail|grep|rg|find|sed -n|wc|tree)\b/.test(c)) return "Looking through " + bashTarget(c);
    if (/^\s*(mkdir|cp|mv)\b/.test(c)) return "Setting up files";
    return "Running a quick task";
  }
  if (name === "grep" || name === "find" || name === "ls") return "Looking through " + (a.path ? thing(a.path) : "the apps");
  return "Working";
}
function summaryOf(ids) {
  const names = [...new Set(ids.map((id) => thing(id + "/")))];
  if (names.length <= 1) return names[0] || "the apps";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function onRecord(r) {
  if (r.type === "response") {
    const done = waiting.get(r.id);
    if (done) { waiting.delete(r.id); done(r); }
    return;
  }
  switch (r.type) {
    case "message_start":
      if (r.message?.role === "assistant") blockOf = new Map();
      break;
    case "message_update": {
      const e = r.assistantMessageEvent || {};
      const ci = e.contentIndex;
      if (e.type === "text_start") blockOf.set(ci, pushBlock({ kind: "assistant" }));
      else if (e.type === "thinking_start") blockOf.set(ci, pushBlock({ kind: "thinking" }));
      else if (e.type === "thinking_end") { if (blockOf.has(ci)) patchBlock(blockOf.get(ci), { status: "done" }); }
      else if (e.type === "text_delta" || e.type === "thinking_delta") {
        if (!blockOf.has(ci)) blockOf.set(ci, pushBlock({ kind: e.type === "text_delta" ? "assistant" : "thinking" }));
        append(blockOf.get(ci), e.delta || "");
      }
      break;
    }
    case "message_end": {
      const m = r.message || {};
      if (m.role === "assistant" && m.stopReason === "aborted") break;
      if (m.role === "assistant" && (m.stopReason === "error" || m.errorMessage))
        system("Model error: " + (m.errorMessage || "unknown"));
      flushAppends();
      break;
    }
    case "tool_execution_start": {
      if (turn) noteLook(r.toolName, r.args || {});
      const text = describe(r.toolName, r.args);
      // the same step again right after itself ("Looking at the dock", twice) is one line
      const last = state.blocks.length - 1;
      const prev = state.blocks[last];
      if (prev && prev.kind === "tool" && prev.text === text && prev.status !== "running") {
        patchBlock(last, { status: "running" });
        toolBlock.set(r.toolCallId, last);
      } else toolBlock.set(r.toolCallId, pushBlock({ kind: "tool", name: r.toolName, text, status: "running" }));
      break;
    }
    case "tool_execution_end": {
      const i = toolBlock.get(r.toolCallId);
      toolBlock.delete(r.toolCallId);
      if (i == null) break;
      const b = state.blocks[i];
      // only a failed test is news to the person; a search that found nothing isn't
      if (r.isError && b.text.startsWith("Testing ")) patchBlock(i, { status: "error", text: b.text + " — found something to fix" });
      else patchBlock(i, { status: r.isError && r.toolName !== "bash" ? "error" : "ok" });
      break;
    }
    case "auto_retry_start":
      system(`Retrying (attempt ${r.attempt}/${r.maxAttempts}): ${r.errorMessage || ""}`);
      break;
    case "compaction_start":
      system("Compacting the conversation to fit the model's context…");
      break;
    case "agent_settled":
      flushAppends();
      afterTurn(r.aborted).catch((e) => { system("Post-turn check failed: " + e.message); finishTurn(false); });
      break;
    case "extension_ui_request":
      // no UI to answer with: decline so the agent never blocks
      if (pi) pi.stdin.write(JSON.stringify({ type: "extension_ui_response", id: r.id, cancelled: true }) + "\n");
      break;
  }
}
// ── a turn ──────────────────────────────────────────────────────────────
// Every app folder is its own git repository. A turn starts by noting each
// app's commit (saving any hand edits as a commit first); afterwards, an app
// whose folder moved is a changed app, and a folder that isn't in the
// registry is a new app.

let turn = null;   // { prompt, before: Map<id, sha>, repairs, looked, seen }
const undoStack = [];

const registered = () => new Set(reg.readRegistry().apps.map((a) => a.id));
const hasRepo = (id) => fs.existsSync(path.join(reg.appDir(id), ".git"));
function folders() {
  return fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
}

async function snapshot() {
  const before = new Map();
  let manual = false;
  for (const id of registered()) {
    if (!hasRepo(id)) continue;
    if (await reg.isDirty(id)) { await reg.appGit(id, "add", "-A"); await reg.appGit(id, "commit", "-q", "-m", "manual edits"); manual = true; }
    before.set(id, await reg.headOf(id));
  }
  return { before, manual };
}

async function changesSince(before) {
  const changed = [], created = [];
  const known = registered();
  for (const id of folders()) {
    if (!known.has(id)) { created.push(id); continue; }
    if (!before.has(id)) continue;
    if ((await reg.isDirty(id)) || (await reg.headOf(id)) !== before.get(id)) changed.push(id);
  }
  return { changed, created };
}

// files the agent left loose in apps/ (outside any app's folder)
function strays() {
  return fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => !d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
}

async function startTurn(text) {
  if (state.busy) return { ok: false, error: "busy" };
  setState({ busy: true });
  if (!chat.title) { chat.title = text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text; }
  pushBlock({ kind: "user", text });
  saveChat();
  announceChats();
  try {
    const { before, manual } = await snapshot();
    if (manual) system("Saved your manual edits as a snapshot first.");
    turn = { prompt: text, before, repairs: 0, looked: false, seen: new Set() };
    const r = await command({ type: "prompt", message: (chat.app ? scopeNote() : hubNote()) + text });
    if (!r.success) { system("The agent refused the prompt: " + r.error); finishTurn(); }
    else if (r.data?.disposition === "handled") finishTurn();
  } catch (e) {
    system("Could not start the agent: " + e.message);
    finishTurn();
  }
  return { ok: true };
}

// what the agent reads ahead of each prompt (the person sees only their words)
function hubNote() {
  const apps = reg.listApps(me).map((a) => `${a.id}/ (${a.title})`).join(", ");
  return `[The hub's apps, one folder each: ${apps || "none yet"}.]\n\n`;
}
function scopeNote() {
  return `[This chat is attached to the ${chat.appTitle || chat.app} app's window. Change only that app: the files in ${chat.app}/. ` +
    `Don't change or create any other app — if the request needs that, say so instead.]\n\n`;
}

// An app's chat changes only that app: any other app it changed goes back to
// its commit from before the turn, and a new app folder is removed. Loose
// files outside any app are removed in every chat. Returns what it put back.
async function confine(before, id) {
  const back = [];
  for (const f of strays()) { fs.rmSync(path.join(WORK, f), { force: true }); back.push(f); }
  if (!id) return back;
  const { changed, created } = await changesSince(before);
  for (const other of changed) {
    if (other === id) continue;
    await reg.appGit(other, "reset", "-q", "--hard", before.get(other));
    await reg.appGit(other, "clean", "-fdq");
    back.push(other + "/");
  }
  for (const c of created) { fs.rmSync(reg.appDir(c), { recursive: true, force: true }); back.push(c + "/"); }
  return back;
}

// each changed or new app: its manifest, and its program through the verifier
async function verifyApps(ids) {
  const problems = [];
  for (const id of ids) {
    const dir = reg.appDir(id);
    if (!reg.safeId(id)) { problems.push(`${id}/: an app's folder name must be lowercase letters, digits and dashes`); continue; }
    const mp = reg.checkManifest(dir);
    if (mp.length) { problems.push(`${id}/declare-app.json:\n` + mp.join("\n")); continue; }
    const main = `${id}/${reg.readManifest(dir).main}`;
    let out;
    try { out = (await run("node", [VERIFY, main], { cwd: WORK, timeout: 120000, maxBuffer: 8 << 20 })).stdout; }
    catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
    if (!/clean through R4/.test(out)) {
      const lines = out.split("\n").filter((l) => /✗|DECLARE|hint|FAILED|line \d|:\d+:\d+/.test(l)).join("\n");
      problems.push(`${main}:\n${lines || out.slice(-1500)}`);
    }
  }
  return problems;
}

async function afterTurn(aborted) {
  if (!turn) { finishTurn(); return; }
  const back = await confine(turn.before, chat.app);
  if (back.length) {
    console.log(`[scope] ${chat.app || "hub"}: put back ${back.join(", ")}`);
    const what = back.filter((b) => b.endsWith("/")).map((b) => b.slice(0, -1));
    if (what.length) system(`This chat only changes the ${chat.appTitle || chat.app} app, so I put back the change to ${summaryOf(what)}.`);
  }
  const { changed, created } = await changesSince(turn.before);
  const ids = [...changed, ...created];
  if (!ids.length) { finishTurn(); return; }
  const problems = await verifyApps(ids);
  if (problems.length && !aborted && turn.repairs < MAX_REPAIRS) {
    turn.repairs++;
    system(`The change to ${summaryOf(ids)} doesn't work yet — fixing it (try ${turn.repairs} of ${MAX_REPAIRS}).`);
    const msg = "The hub's checks found these problems with your change. Fix them, then run `npx declare-verify <app>/<main>.declare` again until it reports \"clean through R4\":\n\n" + problems.join("\n\n");
    const r = await command({ type: "prompt", message: msg });
    if (!r.success) { system("Repair prompt refused: " + r.error); await commitTurn(changed, created, problems); }
    return;
  }
  if (LOOK && !aborted && !turn.looked && !problems.length) {
    turn.looked = true;
    if (await lookAt(ids)) return;
  }
  await commitTurn(changed, created, problems, aborted);
}

// which apps the agent has already seen a picture of since it last changed them
function noteLook(name, a) {
  const pic = String(a.path || "").match(/looks\/([\w-]+)\.png$/);
  if (name === "read" && pic) { turn.seen.add(pic[1]); return; }
  const f = rel(a.path || "").match(/^([\w-]+)\//);
  if ((name === "edit" || name === "write") && f) turn.seen.delete(f[1]);
  else if (name === "bash" && !/look\.mjs|declare-verify|verify\.mjs|declare-help|^\s*(ls|cat|head|tail|grep|rg|find|sed -n|wc|tree)\b/.test(a.command || "")) turn.seen.clear();
}

async function lookAt(changedIds) {
  const ids = changedIds.filter((id) => !turn.seen.has(id)).slice(0, MAX_LOOKS);
  if (!ids.length) return false;
  const i = pushBlock({ kind: "tool", name: "look", text: "Checking how " + summaryOf(ids) + " looks", status: "running" });
  const shots = [];
  for (const id of ids) {
    try { shots.push(await look(id)); }
    catch (e) { console.log(`[look] ${id}: ${e.message}`); }
  }
  patchBlock(i, { status: "ok" });
  if (!shots.length) return false;
  const msg = "Your change verifies. Now check how it looks. Use the read tool on each picture below — each is the app exactly as it shows in its window — and look at it the way the person who asked would:\n" +
    "- is anything cut off, outside the window, or overlapping?\n- is any text unreadable (too small, too little contrast)?\n" +
    "- is anything blank or missing that the app should show, or misaligned?\n- does it look like what was asked for?\n\n" +
    shots.map((s) => `- ${s.title} (${s.width}×${s.height}): ${s.file}` + (s.errors.length ? `\n  errors while it loaded:\n  ${s.errors.join("\n  ")}` : "")).join("\n") +
    "\n\nFix only problems you can clearly see; matters of taste are not problems. After a fix, run declare-verify again, and you can take a new picture with `node ../server/look.mjs <app-id>` and read it. " +
    "End with one short sentence for the person about how it looks now.";
  const r = await command({ type: "prompt", message: msg });
  if (!r.success) { console.log("[look] prompt refused: " + r.error); return false; }
  return true;
}

function saveUndo() { try { fs.writeFileSync(UNDO, JSON.stringify(undoStack)); } catch {} }

// what publishing did, in a sentence
function told(id, r) {
  const t = thing(id + "/");
  if (r.local) return `Saved ${t} on this computer. Sign in to GitHub (see the README) and press Publish to put it there.`;
  if (r.created) return `Published ${t} as its own repo, ${r.repo}.`;
  if (r.forked) return `${t[0].toUpperCase() + t.slice(1)} wasn't yours, so I forked it to ${r.repo} and saved the change there.`;
  return `Saved ${t} to ${r.repo}${r.branch && r.branch !== "main" ? ` (on a new branch, ${r.branch}, since main had moved on)` : ""}.`;
}

async function commitTurn(changed, created, problems, aborted = false) {
  const label = (aborted ? "hub (stopped): " : "hub: ") + turn.prompt;
  const entry = { prompt: turn.prompt, apps: [], created: [] };
  for (const id of changed) {
    if (await reg.isDirty(id)) { await reg.appGit(id, "add", "-A"); await reg.appGit(id, "commit", "-q", "-m", label.slice(0, 200)); }
    entry.apps.push({ id, before: turn.before.get(id), after: await reg.headOf(id) });
  }
  console.log(`[turn] ${label} → ${[...changed, ...created].join(", ")}${problems.length ? "\n" + problems.join("\n") : ""}`);
  if (problems.length) system(`The change to ${summaryOf([...changed, ...created])} still has a problem I couldn't fix. It's kept so you can try it — Undo takes it back.`);
  else system("Done — " + [changed.length ? "updated " + summaryOf(changed) : "", created.length ? "made " + summaryOf(created) : ""].filter(Boolean).join(", and ") + ".");
  for (const id of changed) {
    try { system(told(id, await reg.publish(id, me))); }
    catch (e) { await reg.updateEntry(id, { ref: await reg.headOf(id), pending: true }, `${id}: local change`); system(`Couldn't put ${thing(id + "/")} on GitHub: ${e.message}. It's saved here; Publish tries again.`); }
  }
  for (const id of created) {
    if (!reg.safeId(id) || reg.checkManifest(reg.appDir(id)).length) { fs.rmSync(reg.appDir(id), { recursive: true, force: true }); continue; }
    try {
      const r = await reg.adopt(id, me, label);
      entry.created.push(id);
      system(told(id, { ...r, created: !r.local }));
    } catch (e) { entry.created.push(id); system(`Couldn't put ${thing(id + "/")} on GitHub: ${e.message}. It's saved here; Publish tries again.`); }
  }
  undoStack.push(entry);
  saveUndo();
  finishTurn({ rev: state.rev + 1, changed: [...changed, ...created] });
}

function finishTurn(extra = {}) {
  turn = null;
  flushAppends();
  foldThinking();
  setState({ busy: false, canUndo: undoStack.length > 0, ...extra });
  saveChat();
}

async function undo() {
  if (state.busy) return { ok: false, error: "busy" };
  const last = undoStack.pop();
  if (!last) return { ok: false, error: "nothing to undo" };
  saveUndo();
  for (const a of last.apps) {
    if (!hasRepo(a.id)) continue;
    if (await reg.isDirty(a.id)) { await reg.appGit(a.id, "add", "-A"); await reg.appGit(a.id, "commit", "-q", "-m", "manual edits"); }
    await reg.appGit(a.id, "revert", "--no-edit", `${a.before}..${a.after}`);
    try { await reg.publish(a.id, me); }
    catch (e) { await reg.updateEntry(a.id, { ref: await reg.headOf(a.id), pending: true }, `${a.id}: local undo`); }
  }
  for (const id of last.created) await reg.removeApp(id, true);
  system(`Undid: “${last.prompt}”` + (last.created.length ? " (the new app's repo stays on GitHub; delete it there if you like)" : ""));
  setState({ rev: state.rev + 1, canUndo: undoStack.length > 0, changed: [...last.apps.map((a) => a.id), ...last.created] });
  return { ok: true };
}

// the registry moved outside a turn (a fork chosen, an app added): the portal re-reads it
function moved(ids) { setState({ rev: state.rev + 1, changed: ids }); }

async function newChat(app = chat.app, appTitle = chat.appTitle) {
  if (state.busy) return { ok: false, error: "busy" };
  if (state.blocks.length === 0) {
    Object.assign(chat, { app, appTitle });
    announceChats();
    return { ok: true };
  }
  saveChat();
  if (pi) await command({ type: "new_session" });
  beginChat(app, appTitle);
  if (pi) await noteSession();
  broadcast({ op: "reset", blocks: [] });
  announceChats();
  return { ok: true };
}

async function openChat(id) {
  if (state.busy) return { ok: false, error: "busy" };
  if (id === chat.id) return { ok: true };
  const c = readChat(String(id));
  if (!c) return { ok: false, error: "no such chat" };
  saveChat();
  Object.assign(chat, { id: c.id, title: c.title || "", created: c.created, updated: c.updated, sessionFile: c.sessionFile || "", app: c.app || "", appTitle: c.appTitle || "" });
  state.blocks = c.blocks || [];
  seq = state.blocks.reduce((n, b) => Math.max(n, +String(b.id).slice(1) || 0), 0);
  if (pi) {
    if (chat.sessionFile && fs.existsSync(chat.sessionFile)) await command({ type: "switch_session", sessionPath: chat.sessionFile });
    else { await command({ type: "new_session" }); await noteSession(); }
  }
  fs.writeFileSync(path.join(CHATS, "index.json"), JSON.stringify({ current: chat.id }));
  broadcast({ op: "reset", blocks: state.blocks });
  announceChats();
  return { ok: true };
}

async function chatForApp(app, appTitle) {
  app = String(app || ""); appTitle = String(appTitle || "");
  if (app && !/^[\w-]+$/.test(app)) return { ok: false, error: "bad app id" };
  if (chat.app === app) {
    if (app && appTitle && chat.appTitle !== appTitle) { chat.appTitle = appTitle; announceChats(); }
    return { ok: true };
  }
  if (state.busy) return { ok: false, error: "busy" };
  const latest = listChats().find((c) => c.app === app && c.id !== chat.id);
  if (latest) return openChat(latest.id);
  return newChat(app, appTitle);
}

async function deleteChat(id) {
  id = String(id);
  if (!/^[\w-]+$/.test(id)) return { ok: false, error: "bad id" };
  if (id === chat.id) {
    if (state.busy) return { ok: false, error: "busy" };
    const sf = chat.sessionFile;
    try { fs.unlinkSync(chatFile(id)); } catch {}
    if (sf) try { fs.unlinkSync(sf); } catch {}
    state.blocks = [];
    if (pi) await command({ type: "new_session" });
    beginChat(chat.app, chat.appTitle);
    if (pi) await noteSession();
    broadcast({ op: "reset", blocks: [] });
  } else {
    const c = readChat(id);
    try { fs.unlinkSync(chatFile(id)); } catch {}
    if (c?.sessionFile && c.sessionFile.startsWith(SESSIONS)) try { fs.unlinkSync(c.sessionFile); } catch {}
  }
  announceChats();
  return { ok: true };
}

// ── the model's health, for the panel's status dot ──────────────────────

async function pollModel() {
  if (!STRATA_HEALTH) { if (state.model !== "ready") setState({ model: "ready" }); return; }
  let model = "offline";
  try {
    const r = await fetch(STRATA_HEALTH, { signal: AbortSignal.timeout(2500) });
    const h = await r.json();
    model = h.status !== "ok" ? "loading" : h.loaded ? "ready" : (state.busy ? "loading" : "asleep");
  } catch {}
  if (model !== state.model) setState({ model });
}

// ── the hub's GitHub side, for the portal ───────────────────────────────

function entryOf(id) { return reg.readRegistry().apps.find((a) => a.id === id); }

async function forksOf(id) {
  const e = entryOf(id);
  if (!e) return { ok: false, error: "no such app" };
  if (e.repo.startsWith("local/")) return { ok: false, error: "This app isn't on GitHub yet — publish it first." };
  const { root, forks } = await gh.forksOf(e.repo, e.ref);
  return { ok: true, id, repo: e.repo, ref: e.ref, root, signedIn: !!me,
    forks: forks.map((f) => ({ ...f, current: f.repo === e.repo, mine: !!me && f.owner === me.login })) };
}

async function locked(fn) {
  if (state.busy) return { ok: false, error: "The assistant is working — try again when it's done." };
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { return { ok: false, error: e.message.split("\n")[0] }; }
}

// ── HTTP ────────────────────────────────────────────────────────────────

function body(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
const safe = (s) => /^[A-Za-z0-9_.-]{1,80}$/.test(s) && !s.startsWith(".");
let syncProblems = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const post = req.method === "POST";
  try {
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 1500\n\n");
      send(res, { op: "reset", blocks: state.blocks });
      send(res, stateMsg());
      send(res, chatsMsg());
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (post && p === "/api/prompt") {
      const { text } = await body(req);
      if (!text || !String(text).trim()) return json(res, 400, { ok: false, error: "empty" });
      return json(res, 200, await startTurn(String(text).trim()));
    }
    if (post && p === "/api/abort") { if (pi && state.busy) await command({ type: "abort" }); return json(res, 200, { ok: true }); }
    if (post && p === "/api/undo") return json(res, 200, await undo());
    if (post && p === "/api/newchat") { const b = await body(req); return json(res, 200, await newChat(b.app ?? chat.app, b.title ?? chat.appTitle)); }
    if (post && p === "/api/chats/forapp") { const b = await body(req); return json(res, 200, await chatForApp(b.app, b.title)); }
    if (post && p === "/api/chats/open") return json(res, 200, await openChat((await body(req)).id));
    if (post && p === "/api/chats/delete") return json(res, 200, await deleteChat((await body(req)).id));

    if (p === "/api/hub") return json(res, 200, { me, signedIn: !!me, apps: reg.listApps(me), rev: state.rev, problems: syncProblems });
    const fm = p.match(/^\/api\/forks\/([\w-]+)$/);
    if (fm) { try { return json(res, 200, await forksOf(fm[1])); } catch (e) { return json(res, 200, { ok: false, error: e.message }); } }
    if (post && p === "/api/preview") {
      const b = await body(req);
      try { const r = await reg.preview(String(b.repo), String(b.ref || b.sha)); return json(res, 200, { ok: true, ...r, dir: undefined }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message.split("\n")[0] }); }
    }
    if (post && p === "/api/use") {
      const b = await body(req);
      return json(res, 200, await locked(async () => { const r = await reg.choose(String(b.id), String(b.repo), String(b.ref || b.sha)); moved([String(b.id)]); return r; }));
    }
    if (post && p === "/api/publish") {
      const b = await body(req);
      return json(res, 200, await locked(async () => {
        if (!me) throw new Error("Sign in to GitHub first (see the README)");
        const r = await reg.publish(String(b.id), me); moved([]); return r;
      }));
    }
    if (p === "/api/explore") {
      try {
        const inHub = new Set(reg.readRegistry().apps.map((a) => a.repo));
        const items = (await gh.searchApps(url.searchParams.get("q") || "")).map((r) => ({ ...r, inHub: inHub.has(r.repo) }));
        return json(res, 200, { ok: true, items });
      } catch (e) { return json(res, 200, { ok: false, error: e.message, items: [] }); }
    }
    if (post && p === "/api/add") {
      const b = await body(req);
      return json(res, 200, await locked(async () => { const id = await reg.addApp(String(b.repo), me); moved([id]); return { id }; }));
    }
    if (post && p === "/api/remove") {
      const b = await body(req);
      return json(res, 200, await locked(async () => { await reg.removeApp(String(b.id)); moved([]); return {}; }));
    }

    const m = p.match(/^\/api\/store\/([^/]+)\/([^/]+)$/);
    if (m && safe(m[1]) && safe(m[2])) {
      const file = path.join(STORE, m[1], m[2] + ".json");
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return json(res, 200, null);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "PUT" || post) {
        const v = await body(req);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(v));
        return json(res, 200, v);
      }
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

await gh.findToken();
me = await gh.login();
console.log(me ? `[github] signed in as ${me.login}` : `[github] not signed in — apps run, but changes stay on this computer (see the README)`);
await reg.initRegistry();
syncProblems = await reg.syncAll();
for (const s of syncProblems) console.log("[registry] " + s);
resumeChat();
try { undoStack.push(...JSON.parse(fs.readFileSync(UNDO, "utf8"))); state.canUndo = undoStack.length > 0; } catch {}
await pollModel();
setInterval(pollModel, 10000);
server.listen(PORT, "127.0.0.1", () => console.log(`agent bridge → http://127.0.0.1:${PORT}/api  (pi: ${PROVIDER}/${MODEL}, apps: ${WORK})`));
