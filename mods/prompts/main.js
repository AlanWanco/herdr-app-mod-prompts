// Every message the person sent to an agent, with its time, read from the agent's own omp session log
// (~/.omp/agent/sessions/<folder>/<session>.jsonl) on this or a remote machine. Click a message for the
// whole text and what it pointed at: pictures as thumbnails, text files as code, links as links.
import { View, div, image } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { agents, panes, spaces, focused, exec, home, appHome, readTextFile, settings, theme, window, layout, run } from "herdr";

const LINES = 400;      // messages read per pass
const KEEP = 4000;      // messages kept per session on disk
const TAIL = 2000000;   // bytes read from the end at first; "older" multiplies it
const SHOWN = 150;      // rows drawn at once
const FILES = 12;       // sessions offered per folder
const TICK = 20000;     // a safety refresh; agent changes drive the rest
const CHIPS = 8;        // links and files offered per message

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const leaf = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const ext = (p) => (String(p).includes(".") ? String(p).split(".").pop().toLowerCase() : "");
const ps = (p) => "'" + String(p).replace(/'/g, "''") + "'";
const rows = (s) => String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const uniq = (a) => [...new Set(a)];

// Local time, "14:23" today and "11-02 14:23" before that.
function clock(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  return d.toDateString() === new Date().toDateString() ? hm : p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + hm;
}

// A session file's start time, "11-02 14:55", from its "2026-11-02T06-55-12-345Z_<id>.jsonl" name.
function sessionLabel(name, files = []) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return String(name).replace(/\.jsonl$/, "").slice(0, 13);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = (n) => String(n).padStart(2, "0");
  const label = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  // Sessions begun in the same minute need something to tell them apart.
  const same = files.filter((f) => String(f).slice(0, 16) === String(name).slice(0, 16));
  const id = String(name).split("_")[1] ?? "";
  return same.length > 1 && id ? label + " ·" + id.slice(-4) : label;
}

// Width and height out of a PNG, GIF or WebP header, in the hex a shell printed for us.
function fromHeader(hex) {
  if (typeof hex !== "string" || hex.length < 24) return null;
  const be32 = (at) => parseInt(hex.slice(at, at + 8), 16);
  const le16 = (at) => parseInt(hex.slice(at, at + 4).match(/../g).reverse().join(""), 16);
  const be16 = (at) => parseInt(hex.slice(at, at + 4), 16);
  if (hex.startsWith("89504e47") && hex.slice(24, 32) === "49484452") return { w: be32(32), h: be32(40) };
  if (hex.startsWith("474946")) return { w: le16(12), h: le16(16) };
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") {
    const chunk = hex.slice(24, 32);
    if (chunk === "56503858") return { w: be24(hex, 48) + 1, h: be24(hex, 54) + 1 };
    if (chunk === "56503820") return { w: be16(52) & 0x3fff, h: be16(56) & 0x3fff };
    if (chunk === "5650384c") {
      const v = parseInt(hex.slice(42, 50).match(/../g).reverse().join(""), 16);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

// A 24-bit little-endian value at byte offset `at`.
function be24(hex, at) {
  const b = hex.slice(at, at + 6).match(/../g).reverse().join("");
  return parseInt(b, 16);
}

// "space · tab": the tab only when the space has more than one, or someone named it.
function tabLabel(a) {
  const space = spaces().find((x) => x.id === a.space);
  const many = (space?.tabs?.length ?? 1) > 1;
  const named = Boolean(a.tab_name) && a.tab_name !== String(a.tab_index);
  return many || named ? a.tab_name : null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function said(m) {
  const parts = Array.isArray(m?.content) ? m.content : [];
  const out = [];
  for (const p of parts) if (p?.type === "text" && p.text) out.push(p.text);
  return out.join("\n").trim();
}

function pictures(m) {
  const parts = Array.isArray(m?.content) ? m.content : [];
  const out = [];
  for (const p of parts) {
    if (p?.type !== "image") continue;
    const hash = String(p.data ?? "").replace(/^blob:sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    out.push({ hash, mime: String(p.mimeType ?? "image/png") });
  }
  return out;
}

function parse(line) {
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "message" || entry.message?.role !== "user") return null;
    const text = said(entry.message);
    const images = pictures(entry.message);
    return text || images.length ? { t: entry.timestamp, text, images } : null;
  } catch {
    return null;
  }
}

// Absolute paths and links a message points at, in the order they appear.
function parseLines(text) {
  return String(text ?? "").split(/\r?\n/).filter((line) => line.includes('"role":"user"')).map(parse).filter(Boolean).reverse().slice(0, LINES);
}

function pointers(text) {
  const out = [];
  const add = (raw) => {
    const p = String(raw).replace(/[)\],.;:'"!?]+$/, "");
    if (p.length > 3 && !out.includes(p)) out.push(p);
  };
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"'`]+/g)) add(m[0]);
  for (const m of String(text).matchAll(/[A-Za-z]:\\[^\s"'`<>|*?\n]+/g)) add(m[0]);
  for (const m of String(text).matchAll(/(?:^|[\s"'`(\[])(\/[^\s"'`<>|*?\n]+)/g)) add(m[1]);
  return out.slice(0, CHIPS);
}

export default class Prompts extends View {
  init(_props, cx) {
    this.state = {};     // address -> read session
    this.seen = {};      // address -> agent seq already asked for
    this.busy = {};
    this.pick = {};      // address -> session file the person chose
    this.roots = {};
    this.pinned = [];    // agent addresses the person pinned in the agents list
    this.open = {};      // row id -> shown in full
    this.links = {};     // row id -> files and links the message points at
    this.thumbs = {};    // row id -> pictures copied where the image loader reaches
    this.preview = null; // {kind, title, path, rel, state, error}
    this.code = null;
    this.hoverRow = null;  // row the pointer is on
    this.pickAgent = localStorage.getItem("prompts.agents") === "1";
    this.copied = null;    // row whose text was just copied
    this.copiedMsg = null; // what the preview's copy button said
    this.readPins(cx);
    cx.timer.every(TICK, (cx) => { this.readPins(cx); this.load(cx, this.selected); });
  }

  // Pins the person set in the agents list; the store keeps its values JSON-encoded as strings.
  async readPins(cx) {
    try {
      const text = await readTextFile(appHome() + "\\data\\agents\\store.json");
      let pins = text ? JSON.parse(text).pins : null;
      if (typeof pins === "string") pins = JSON.parse(pins);
      if (Array.isArray(pins) && pins.join() !== this.pinned.join()) { this.pinned = pins; cx?.notify(); }
    } catch { /* no pins yet */ }
  }

  // The app's own platform decides the shell: PowerShell on Windows, sh elsewhere.
  windows(machine) {
    return machine === null && (window()?.platform ?? "windows") === "windows";
  }

  join(dir, name) {
    return dir + (dir.includes("\\") ? "\\" : "/") + name;
  }

  async machineOf(address) {
    const agent = agents().find((a) => a.address === address);
    return agent ? (spaces().find((s) => s.id === agent.space)?.machine ?? null) : null;
  }

  async root(machine) {
    if (this.roots[machine]) return this.roots[machine];
    const path = machine === null
      ? (this.windows(null) ? home() + "\\.omp\\agent\\sessions" : home() + "/.omp/agent/sessions")
      : (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine })).stdout.trim() + "/.omp/agent/sessions";
    this.roots[machine] = path;
    return path;
  }

  async folders(dir, machine) {
    if (this.windows(machine)) {
      const script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        + " Get-ChildItem -LiteralPath " + ps(dir) + " -Directory | ForEach-Object { $_.Name }";
      return rows((await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { on: machine })).stdout);
    }
    return rows((await exec("sh", ["-c", 'ls -1 "$1"', "sh", dir], { on: machine })).stdout);
  }

  async files(dir, machine) {
    if (this.windows(machine)) {
      const script = "$ErrorActionPreference='SilentlyContinue'; Get-ChildItem -LiteralPath " + ps(dir) + " -Filter *.jsonl -File"
        + " | Sort-Object LastWriteTime -Descending | Select-Object -First " + FILES + " | ForEach-Object { $_.Name }";
      return rows((await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { on: machine })).stdout);
    }
    return rows((await exec("sh", ["-c", 'ls -t "$1" | head -n ' + FILES, "sh", dir], { on: machine })).stdout);
  }

  async read(address) {
    const agent = agents().find((a) => a.address === address);
    if (!agent) return { error: "This agent is gone." };
    const machine = spaces().find((s) => s.id === agent.space)?.machine ?? null;
    const cwd = panes().find((p) => p.pane === agent.pane)?.cwd ?? null;
    if (!cwd) return { error: "This agent has no folder yet." };
    const root = await this.root(machine);
    let folders = [];
    if (machine === null) folders = await fs.readdir(root).catch(() => []);
    else {
      // One call lists every folder with its newest sessions, one "folder|file" per line.
      const r = await exec("sh", ["-c", 'for d in "$1"/*/; do n=${d%/}; n=${n##*/};'
        + ' ls -t "$d"*.jsonl 2>/dev/null | head -n ' + FILES + ' | while read -r f; do echo "$n|${f##*/}"; done; done', "sh", root], { on: machine });
      this.index = this.index ?? {};
      for (const key of Object.keys(this.index)) if (key.startsWith(machine + "|")) delete this.index[key];
      for (const line of rows(r.stdout)) {
        const at = line.indexOf("|");
        if (at < 0) continue;
        const name = line.slice(0, at), file = line.slice(at + 1);
        if (!name || !file) continue;
        if (!folders.includes(name)) folders.push(name);
        (this.index[machine + "|" + name] = this.index[machine + "|" + name] ?? []).push(file);
        if (this.index[machine + "|" + name].length > FILES) this.index[machine + "|" + name].length = FILES;
      }
    }
    // omp names a session folder after the folder the agent started in: absolute, or from `~` on.
    const want = norm(cwd);
    let folder = null, best = 0;
    for (const d of folders) {
      const n = norm(d);
      if (!n || !(want === n || want.endsWith("-" + n) || n.endsWith("-" + want))) continue;
      if (n.length > best) { best = n.length; folder = d; }
    }
    if (!folder) return { error: "No sessions for " + cwd + " yet.", root };
    const dir = this.join(root, folder);
    const files = machine === null ? await this.files(dir, null) : (this.index?.[machine + "|" + folder] ?? []);
    if (!files.length) return { error: "No sessions in " + folder + " yet.", dir };
    const file = files.includes(this.pick[address]) ? this.pick[address] : files[0];
    const key = this.keyOf(address, file);
    const bytes = this.depth?.[key] ?? TAIL;
    const got = await this.messages(this.join(dir, file), machine, bytes);
    if (got.error) return { error: got.error, files, folder, cwd, machine, file, key };
    const prompts = await this.remember(key, got.prompts);
    return { prompts, file, files, folder, cwd, machine, key, more: Boolean(machine) && bytes < 32000000, blobs: this.join(root.replace(/[\\/]sessions[\\/]?$/, ""), "blobs") };
  }

  keyOf(address, file) {
    return String(address + "__" + String(file).replace(/\.jsonl$/, "")).replace(/[^A-Za-z0-9_.-]+/g, "_");
  }

  // What was read before stays: merging keeps messages that scrolled out of the bytes read now.
  async remember(key, fresh) {
    this.memo = this.memo ?? {};
    if (!this.memo[key]) {
      try {
        const text = await fs.readFile(appHome() + "\\cache\\prompts\\data\\" + key + ".json", "utf8");
        this.memo[key] = JSON.parse(text).prompts ?? [];
      } catch { this.memo[key] = []; }
    }
    const seen = new Set();
    const merged = [];
    for (const p of [...fresh, ...this.memo[key]]) {
      const id = (p.t ?? "") + "|" + p.text.length + "|" + p.text.slice(0, 48);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(p);
      if (merged.length >= KEEP) break;
    }
    this.memo[key] = merged;
    try {
      await fs.mkdir(appHome() + "\\cache\\prompts\\data", { recursive: true });
      await fs.writeFile(appHome() + "\\cache\\prompts\\data\\" + key + ".json", JSON.stringify({ prompts: merged }));
    } catch { /* a cache that cannot be written is still a cache in memory */ }
    return merged;
  }

  // The messages of one session. Remote: the end of the file, one sh call. Here: the file, filtered
  // by PowerShell — the paths herdr hands out are Windows paths, and only PowerShell reads them all.
  async messages(file, machine, bytes) {
    const grep = "grep -F '" + '"role":"user"' + "' | tail -n " + LINES;
    let r;
    if (machine) r = await exec("sh", ["-c", 'tail -c ' + bytes + ' "$1" | ' + grep, "sh", file], { on: machine }).catch(() => null);
    else {
      const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        + " Get-Content -LiteralPath " + ps(file) + " -Encoding UTF8"
        + " | Where-Object { $_ -like '*" + '"role":"user"' + "*' } | Select-Object -Last " + LINES;
      r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]).catch(() => null);
    }
    if (!r || r.code !== 0) return { prompts: [], error: "Cannot read this session file." };
    return { prompts: parseLines(r.stdout) };
  }

  async read(address) {
    const agent = agents().find((a) => a.address === address);
    if (!agent) return { error: "This agent is gone." };
    const machine = spaces().find((s) => s.id === agent.space)?.machine ?? null;
    const cwd = panes().find((p) => p.pane === agent.pane)?.cwd ?? null;
    if (!cwd) return { error: "This agent has no folder yet." };
    const root = await this.root(machine);
    let folders = [];
    if (machine === null) folders = await fs.readdir(root).catch(() => []);
    else {
      // One call lists every folder with its newest sessions, one "folder|file" per line.
      const r = await exec("sh", ["-c", 'for d in "$1"/*/; do n=${d%/}; n=${n##*/};'
        + ' ls -t "$d"*.jsonl 2>/dev/null | head -n ' + FILES + ' | while read -r f; do echo "$n|${f##*/}"; done; done', "sh", root], { on: machine });
      this.index = this.index ?? {};
      for (const key of Object.keys(this.index)) if (key.startsWith(machine + "|")) delete this.index[key];
      for (const line of rows(r.stdout)) {
        const at = line.indexOf("|");
        if (at < 0) continue;
        const name = line.slice(0, at), file = line.slice(at + 1);
        if (!name || !file) continue;
        if (!folders.includes(name)) folders.push(name);
        (this.index[machine + "|" + name] = this.index[machine + "|" + name] ?? []).push(file);
        if (this.index[machine + "|" + name].length > FILES) this.index[machine + "|" + name].length = FILES;
      }
    }
    // omp names a session folder after the folder the agent started in: absolute, or from `~` on.
    const want = norm(cwd);
    let folder = null, best = 0;
    for (const d of folders) {
      const n = norm(d);
      if (!n || !(want === n || want.endsWith("-" + n) || n.endsWith("-" + want))) continue;
      if (n.length > best) { best = n.length; folder = d; }
    }
    if (!folder) return { error: "No sessions for " + cwd + " yet.", root };
    const dir = this.join(root, folder);
    const files = machine === null ? await this.files(dir, null) : (this.index?.[machine + "|" + folder] ?? []);
    if (!files.length) return { error: "No sessions in " + folder + " yet.", dir };
    const file = files.includes(this.pick[address]) ? this.pick[address] : files[0];
    const key = this.keyOf(address, file);
    const bytes = this.depth?.[key] ?? TAIL;
    const got = await this.messages(this.join(dir, file), machine, bytes);
    if (got.error) return { error: got.error, files, folder, cwd, machine, file, key };
    const prompts = await this.remember(key, got.prompts);
    return { prompts, file, files, folder, cwd, machine, key, more: Boolean(machine) && bytes < 32000000, blobs: this.join(root.replace(/[\\/]sessions[\\/]?$/, ""), "blobs") };
  }

  keyOf(address, file) {
    return String(address + "__" + String(file).replace(/\.jsonl$/, "")).replace(/[^A-Za-z0-9_.-]+/g, "_");
  }

  // What was read before stays: merging keeps messages that scrolled out of the bytes read now.
  async remember(key, fresh) {
    this.memo = this.memo ?? {};
    if (!this.memo[key]) {
      try {
        const text = await fs.readFile(appHome() + "\\cache\\prompts\\data\\" + key + ".json", "utf8");
        this.memo[key] = JSON.parse(text).prompts ?? [];
      } catch { this.memo[key] = []; }
    }
    const seen = new Set();
    const merged = [];
    for (const p of [...fresh, ...this.memo[key]]) {
      const id = (p.t ?? "") + "|" + p.text.length + "|" + p.text.slice(0, 48);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(p);
      if (merged.length >= KEEP) break;
    }
    this.memo[key] = merged;
    try {
      await fs.mkdir(appHome() + "\\cache\\prompts\\data", { recursive: true });
      await fs.writeFile(appHome() + "\\cache\\prompts\\data\\" + key + ".json", JSON.stringify({ prompts: merged }));
    } catch { /* a cache that cannot be written is still a cache in memory */ }
    return merged;
  }

  load(cx, address, force) {
    const now = Date.now();
    if (!address) return;
    // A reload cancels a task mid-flight; a stale "busy" must not block this copy forever.
    if (this.busy[address] && now - (this.busyAt?.[address] ?? 0) < 5000) return;
    if (!force && this.state[address] && now - (this.at?.[address] ?? 0) < 2500) return;
    this.busy[address] = true;
    this.busyAt = this.busyAt ?? {};
    this.busyAt[address] = now;
    cx.spawn(async (cx) => {
      let next;
      try {
        next = await this.read(address);
      } catch (e) {
        next = { error: String(e?.message ?? e) };
      }
      this.busy[address] = false;
      this.at = this.at ?? {};
      this.at[address] = Date.now();
      this.state[address] = next;
      cx.notify();
    });
  }

  // A picture where the image loader can reach it: under the app's own folder, named after its source.
  async cache(src, name) {
    const dir = appHome() + "/cache/prompts", dest = this.join(dir, name);
    if (this.windows(null)) {
      const cmd = "New-Item -ItemType Directory -Force -Path " + ps(dir) + " | Out-Null; Copy-Item -LiteralPath "
        + ps(src) + " -Destination " + ps(dest) + " -Force; Test-Path -LiteralPath " + ps(dest);
      return /^true/i.test((await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd])).stdout.trim());
    }
    const r = await exec("sh", ["-c", 'mkdir -p "$1" && cp "$2" "$3" && test -s "$3" && echo yes', "sh", dir, src, dest]);
    return /yes/.test(r.stdout);
  }

  // A picture's pixel size, so it can keep its shape in a box.
  async dims(path) {
    try {
      if (!this.windows(null)) {
        const r = await exec("sh", ["-c", 'sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null | tail -2 | tr -dc "0-9\\n"', "sh", path]);
        const [w, h] = rows(r.stdout).map(Number);
        return w > 0 && h > 0 ? { w, h } : null;
      }
      const cmd = "Add-Type -AssemblyName System.Drawing;"
        + " try { $i=[System.Drawing.Image]::FromFile(" + ps(path) + "); 'D ' + $i.Width + ' ' + $i.Height; $i.Dispose() }"
        + " catch { $b=[IO.File]::ReadAllBytes(" + ps(path) + "); 'H ' + (($b[0..([Math]::Min(47,$b.Length-1))] | ForEach-Object { $_.ToString('x2') }) -join '') }";
      const bits = (await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd])).stdout.trim().split(/\s+/);
      if (bits[0] === "D") return { w: Number(bits[1]), h: Number(bits[2]) };
      if (bits[0] === "H") return fromHeader(bits[1]);
      return null;
    } catch { return null; }
  }

  // Fit into a box without distorting: width first, then height.
  fit(size, w, h) {
    const i = this.sizes?.[size.rel];
    if (!i) return {};
    const k = Math.min(size.w / i.w, size.h / i.h, 1);
    return { w: Math.round(i.w * k), h: Math.round(i.h * k) };
  }

  // The same for a picture on another machine: base64 on that side, decoded into the cache here.
  async cacheRemote(src, machine, name) {
    const dir = appHome() + "/cache/prompts", dest = this.join(dir, name);
    const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", src], { on: machine }).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout) return false;
    const tmp = this.join(dir, "b64-" + name + ".txt");
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, String(r.stdout).replace(/\s+/g, ""));
    } catch { return false; }
    const cmd = "$b=[IO.File]::ReadAllText(" + ps(tmp) + "); [IO.File]::WriteAllBytes(" + ps(dest)
      + ", [Convert]::FromBase64String($b)); (Get-Item -LiteralPath " + ps(dest) + ").Length";
    const out = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]).catch(() => null);
    try { await fs.unlink(tmp); } catch { /* the cache is not precious */ }
    return Boolean(out && Number(String(out.stdout).trim()) > 0);
  }

  // Whatever came in, the cache holds a PNG: the image loader draws it and the clipboard takes it.
  async settle(name) {
    if (/\.(png|jpg|jpeg|gif|bmp)$/i.test(name)) return name;
    const dir = appHome() + "/cache/prompts", out = name.replace(/\.[^.]+$/, "") + ".png";
    const r = await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", this.join(dir, name), this.join(dir, out)]).catch(() => null);
    if (!r || r.code !== 0) return name;
    try { await fs.unlink(this.join(dir, name)); } catch { /* keep both, harmless */ }
    return out;
  }

  async copyPicture(src, machine, name) {
    const ok = machine === null ? await this.cache(src, name) : await this.cacheRemote(src, machine, name);
    return ok ? this.settle(name) : null;
  }

  cached(path) {
    const base = String(path).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9]+/g, "").slice(-22);
    return (base || "picture") + "." + (ext(path) || "png");
  }

  // Does this machine have these paths? Answers in the order asked, missing ones dropped.
  async existing(paths, machine) {
    const ask = paths.filter((p) => !/^https?:/i.test(p));
    if (!ask.length) return paths.map((path) => ({ path, url: true }));
    let have = [];
    if (this.windows(machine)) {
      const script = "@(" + ask.map((p) => ps(p)).join(", ") + ") | ForEach-Object { Test-Path -LiteralPath $_ }";
      const out = rows((await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { on: machine })).stdout);
      ask.forEach((p, i) => { if (/^true$/i.test(out[i] ?? "")) have.push(p); });
    } else {
      const out = rows((await exec("sh", ["-c", 'for p in "$@"; do [ -e "$p" ] && echo "$p"; done', "sh", ...ask], { on: machine })).stdout);
      have = ask.filter((p) => out.includes(p));
    }
    return [
      ...paths.filter((p) => /^https?:/i.test(p)).map((path) => ({ path, url: true })),
      ...have.map((path) => ({ path, url: false })),
    ];
  }

  // What the message points at, once its row is opened: links, files that exist, and its pictures.
  expand(cx, id, p, address, machine, blobs) {
    if (this.open[id]) { this.open[id] = false; cx.notify(); return; }
    this.open[id] = true;
    if (this.links[id] || this.thumbs[id]) { cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const paths = await this.existing(pointers(p.text), machine);
        this.links[id] = paths;
        if (p.images?.length) {
          const made = [];
          for (const pic of p.images.slice(0, 4)) {
            const tail = (String(pic.mime).split("/").pop() || "png").replace("jpeg", "jpg");
            const name = pic.hash.slice(0, 16) + "." + tail;
            for (const from of [this.join(blobs, pic.hash + "." + tail), this.join(blobs, pic.hash)]) {
              const got = await this.copyPicture(from, machine, name);
              if (!got) continue;
              const rel = "cache/prompts/" + got;
              made.push({ rel, path: from });
              this.sizes = this.sizes ?? {};
              this.sizes[rel] = await this.dims(this.join(appHome(), rel));
              break;
            }
          }
          this.thumbs[id] = made;
        }
      } catch (e) {
        this.links[id] = [{ path: String(e?.message ?? e), url: false, error: true }];
      }
      cx.notify();
    });
  }

  // A file: its picture, its text as code, or a note that Herdr has no preview for it.
  async reveal(path, machine, cx) {
    if (/^https?:/i.test(path)) return this.openElsewhere(path);
    this.code?.release(); this.code = null;
    this.preview = { kind: "loading", title: leaf(path), path };
    const set = (next) => { this.preview = next; cx.notify(); };
    try {
      if (IMAGE.includes(ext(path))) {
        const name = this.cached(path);
        const made = await this.copyPicture(path, machine, name);
        if (!made) return set({ kind: "other", title: leaf(path), path, note: "This picture cannot be read." });
        const rel = "cache/prompts/" + made;
        this.sizes = this.sizes ?? {};
        this.sizes[rel] = await this.dims(this.join(appHome(), rel));
        return set({ kind: "image", title: leaf(path), path, rel });
      }
      let text;
      if (machine === null) text = await readTextFile(path);
      else {
        const r = await exec("sh", ["-c", 'head -c 2000000 "$1"', "sh", path], { on: machine }).catch(() => null);
        text = r && r.code === 0 && r.stdout ? r.stdout : null;
      }
      if (text === null) return set({ kind: "other", title: leaf(path), path, note: "This file cannot be read." });
      if (text.includes("\0")) return set({ kind: "other", title: leaf(path), path, note: "A binary file: no text preview." });
      const t = theme();
      const lang = ext(path);
      this.code = EditorState.new({ language: LANG[lang] ?? (lang || "text"), readonly: true,
        value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
        font_family: settings().font_family, font_size: 12,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      set({ kind: "text", title: leaf(path), path, text });
    } catch (e) {
      set({ kind: "other", title: leaf(path), path, note: String(e?.message ?? e) });
    }
  }

  // Copy a picture's bytes, not its path: the desktop clipboard takes an image. GDI+ cannot decode
  // WebP, and omp stores pasted pictures as WebP, so convert first when it refuses.
  async copyImage(path, cx) {
    if (!this.windows(null)) return cx.write_to_clipboard(path);
    const put = async (file) => {
      const cmd = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        + " try { $i=[System.Drawing.Image]::FromFile(" + ps(file) + "); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose(); 'ok' }"
        + " catch { 'ERR' }";
      const r = await exec("powershell", ["-NoProfile", "-Sta", "-Command", cmd]).catch(() => null);
      return Boolean(r && /ok/.test(r.stdout));
    };
    let note = (await put(path)) ? "Image copied" : null;
    if (!note) {
      const out = this.join(appHome() + "/cache/prompts", "clip-" + String(path).replace(/[^A-Za-z0-9]/g, "").slice(-20) + ".png");
      const args = ["-y", "-loglevel", "error", "-i", path, out];
      const conv = await exec("ffmpeg", args).catch(() => null);
      if ((conv && conv.code === 0) || ((await exec("E:\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe", args).catch(() => null))?.code === 0)) {
        if (await put(out)) note = "Image copied (WebP converted to PNG)";
      }
    }
    this.copiedMsg = note ?? "This image cannot go on the clipboard";
    cx.notify();
    cx.timer.after(2600, (cx) => { this.copiedMsg = null; cx.notify(); });
  }

  openElsewhere(path) {
    if (this.windows(null)) exec("powershell", ["-NoProfile", "-Command", "Start-Process " + ps(path)]);
    else exec("open", [path]);
  }


  render(cx) {
    const t = theme();
    const list = agents();
    // Follow the agent the window moves to; a manual pick holds until focus changes again.
    const now = focused()?.agent ?? null;
    if (now && now !== this.followed) {
      this.followed = now;
      this.selected = now;
      // A space switch makes the shipped tabs mod restore that space's panel: put ours back.
      if (this.holding) {
        run("layout.select", { stack: "panel-body", child: "prompts" });
        run("layout.show", { id: "panel" });
      }
    }
    // Remember whether our block is the one on screen, for the next switch.
    const panel = find(layout(), "panel"), stack = find(layout(), "panel-body");
    this.holding = Boolean(panel && !panel.hidden && stack?.active === "prompts");
    if (!this.selected || !list.some((a) => a.address === this.selected)) {
      this.selected = focused()?.agent ?? list[0]?.address ?? null;
    }
    const rank = (a) => (a.status === "working" ? 0 : a.status === "blocked" ? 1 : a.status === "done" ? 2 : 3);
    const ordered = [...list].sort((x, y) => {
      const ix = this.pinned.indexOf(x.address), iy = this.pinned.indexOf(y.address);
      if ((ix >= 0) !== (iy >= 0)) return ix >= 0 ? -1 : 1;
      if (ix >= 0) return ix - iy;
      const rx = rank(x), ry = rank(y);
      return rx !== ry ? rx - ry : 0;
    });
    const agent = list.find((a) => a.address === this.selected) ?? null;
    const s = agent ? this.state[agent.address] : null;
    if (agent && !this.busy[agent.address] && (this.seen[agent.address] !== agent.seq || !s)) {
      this.seen[agent.address] = agent.seq;
      this.load(cx, agent.address);
    }
    if (this.preview) return this.drawPreview(t);
    const button = (id, text, action) => h_flex().id(id).h(22).px(6).flex_none().items_center().rounded(6).text_size(11.5)
      .text_color(t.dim).hover((e) => e.bg(t.hover).text_color(t.foreground)).on_click(action).child(text);
    const chip = (a) => h_flex().id("ag-" + a.address).h(25).px(8).gap(5).flex_none().items_center().rounded(7).border(1)
      .border_color(a.address === this.selected ? t.accent : t.border)
      .bg(a.address === this.selected ? t.selected : t.chrome)
      .text_color(a.address === this.selected ? t.foreground : t.muted)
      .hover((e) => e.bg(t.hover))
      .on_click((_e, cx) => { this.selected = a.address; cx.notify(); })
      .child(div().size(6).rounded(3).flex_none().bg(t[a.status] ?? t.dim))
      .child(div().max_w(140).truncate().child(a.space_name ?? a.address));

    // One agent per line, so the names (and the toggle above them) share one left edge.
    const agentRow = (a) => {
      const on = a.address === this.selected, tab = tabLabel(a);
      return h_flex().id("agl-" + a.address).h(23).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer()
        .text_size(11.5).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.selected = a.address; this.pickAgent = false; cx.notify(); })
        .child(div().size(6).rounded(3).flex_none().bg(t[a.status] ?? t.dim))
        .child(div().min_w(0).truncate().child(a.space_name ?? a.address))
        .when(Boolean(tab), (x) => x.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child("\u00b7 " + tab)))
        .when(!tab, (x) => x.child(div().flex_1()))
        .when(this.pinned.includes(a.address), (x) => x.child(div().text_size(10).text_color(t.accent).child("pinned")));
    };

    const session = (name, i) => h_flex().id("se-" + name).h(21).px(6).flex_none().items_center().rounded(5).text_size(10.5)
      .bg(s?.file === name ? t.selected : t.chrome).text_color(s?.file === name ? t.foreground : t.dim)
      .hover((e) => e.bg(t.hover))
      .on_click((_e, cx) => { if (agent) this.pick[agent.address] = name; cx.notify(); })
      .child((i + 1) + " \u00b7 " + sessionLabel(name));

    const pointerChip = (l) => h_flex().id("lk-" + l.path).h(22).px(7).gap(5).flex_none().items_center().rounded(6).border(1)
      .border_color(t.border).bg(t.chrome).text_size(11)
      .text_color(l.error ? t.blocked : t.muted).hover((e) => e.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (l.url) this.openElsewhere(l.path);
        else if (!l.error) this.reveal(l.path, s?.machine ?? null, cx);
      })
      .child(div().max_w(180).truncate().child((l.url ? "↗ " : IMAGE.includes(ext(l.path)) ? "▣ " : "▤ ") + leaf(l.path)));

    // A picture too wide or tall to show as a strip gets a chip saying its size instead.
    const thumb = (m) => {
      const box = this.fit({ rel: m.rel, w: 300, h: 110 }, 0, 0);
      const size = this.sizes?.[m.rel];
      const flat = !box.h || box.h < 24 || box.w < 24;
      if (flat) {
        const label = size ? size.w + "\u00d7" + size.h + " picture" : "picture";
        return h_flex().id("th-" + m.rel).h(24).px(8).gap(6).flex_none().items_center().rounded(6)
          .border_1().border_color(t.border).bg(t.chrome).text_size(11).text_color(t.muted)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.preview = { kind: "image", title: leaf(m.path), path: m.path, rel: m.rel }; cx.notify(); })
          .child(div().child(label))
          .child(div().text_color(t.dim).child("open"));
      }
      return div().id("th-" + m.rel).h(box.h).w(box.w).rounded(6).overflow_hidden().border_1().border_color(t.border)
        .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.preview = { kind: "image", title: leaf(m.path), path: m.path, rel: m.rel }; cx.notify(); })
        .child(image(m.rel).h(box.h));
    };

    const item = (p, i) => {
      const id = agent.address + "|" + i;
      const shown = this.open[id];
      const more = p.text.length > 220;
      const text = shown || !more ? p.text : p.text.slice(0, 220).replace(/\s+$/, "") + "…";
      const links = this.links[id] ?? [];
      const thumbs = this.thumbs[id] ?? [];
      return v_flex().id("pm-" + i).px(10).py(7).gap(4).border_b(1).border_color(t.border)
        .cursor_pointer().on_click((_e, cx) => this.expand(cx, id, p, agent.address, s?.machine ?? null, s?.blobs ?? ""))
        .on_hover((hovered, cx) => {
          const now = hovered ? id : null;
          if (this.hoverRow !== now) { this.hoverRow = now; cx.notify(); }
        })
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10.5).text_color(t.dim).child(clock(p.t)))
          .child(div().text_size(10.5).text_color(t.dim).child("#" + (s.prompts.length - i)))
          .when(p.images.length > 0, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("▣ " + p.images.length)))
          .when(this.hoverRow === id, (e) => e.child(div().flex_1()).child(h_flex().id("cp-" + i).h(18).px(6).flex_none()
            .items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted)
            .hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.write_to_clipboard(p.text); this.copied = id; cx.notify(); cx.timer.after(1200, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } }); })
            .child(this.copied === id ? "copied" : "copy"))))
        .child(div().text_size(12).text_color(t.foreground).child(text))
        .when(shown && links.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().items_center().children(links.map(pointerChip))))
        .when(shown && thumbs.length > 0, (e) => e.child(v_flex().pt(2).gap(6).children(thumbs.map(thumb))))
        .when(shown && !p.text, (e) => e.child(div().text_size(11).text_color(t.dim).child("(no text)")));
    };

    const note = (text, color) => v_flex().p(12).child(div().text_size(11.5).text_color(color ?? t.dim).child(text));
    const shown = (s?.prompts ?? []).slice(0, SHOWN);
    const body = !agent ? note("No agents yet.")
      : !s ? note("Reading the log…")
        : s.error ? note(s.error, t.blocked)
          : shown.length === 0 ? note("No messages in this session yet.")
            : v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(shown.map(item));

    return v_flex().id("root").size_full().min_w(0).bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(32).flex_none().px(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_1().text_size(12).font_semibold().child("Prompts"))
        .child(div().pr(6).text_size(10.5).text_color(t.dim).child(s && !s.error ? String(s.prompts?.length ?? 0) : ""))
        .child(button("pr-refresh", "↻", (_e, cx) => { if (agent) this.seen[agent.address] = null; this.load(cx, this.selected, true); })))
      .child(v_flex().flex_none().px(8).py(6).gap(4)
        .child(h_flex().items_center().gap(6)
          .child(h_flex().id("ag-now").h(23).px(8).gap(6).flex_1().min_w(0).items_center().rounded(7)
            .border(1).border_color(t.accent).bg(t.selected).text_color(t.foreground).text_size(11.5)
            .child(div().size(6).rounded(3).flex_none().bg(t[agent?.status] ?? t.dim))
            .child(div().min_w(0).truncate().child(agent?.space_name ?? "no agent")))
          .when(list.length > 1, (el) => el.child(h_flex().id("ag-more").h(23).px(8).flex_none().items_center().rounded(6).text_size(11.5)
            .border(1).border_color(t.border).bg(t.chrome).text_color(t.dim)
            .hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.pickAgent = !this.pickAgent; localStorage.setItem("prompts.agents", this.pickAgent ? "1" : "0"); cx.notify(); })
            .child(this.pickAgent ? "hide" : list.length + " agents"))))
        .when(this.pickAgent, (el) => el.child(v_flex().id("ag-list").h(190).overflow_y_scrollbar().gap(1)
          .children(ordered.map(agentRow)))))
      .when((s?.files?.length ?? 0) > 1, (el) => el.child(h_flex().flex_none().px(8).pb(6).gap(5).flex_wrap().items_center()
        .child(div().text_size(10.5).text_color(t.dim).child("sessions"))
        .children(s.files.map((name, i) => session(name, i)))))
      .child(h_flex().flex_none().px(10).pb(6).items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
          .child(s && !s.error ? (s.cwd ?? s.folder ?? "") + (s.machine ? " · " + s.machine : "") : ""))
        .when(Boolean(s?.more), (el) => el.child(h_flex().id("pr-more").h(20).px(7).flex_none().items_center().rounded(5)
          .text_size(10.5).text_color(t.dim).border_1().border_color(t.border).bg(t.chrome)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            this.depth = this.depth ?? {};
            this.depth[s.key] = Math.min(32000000, (this.depth[s.key] ?? TAIL) * 4);
            this.load(cx, agent.address, true);
          }).child("older"))))
      .child(body);
  }

  // One file, filling the panel: a picture, its code, or what Herdr cannot show.
  drawPreview(t) {
    const p = this.preview;
    const back = h_flex().id("pv-back").h(26).px(6).flex_none().items_center().rounded(6).text_size(11.5).text_color(t.dim)
      .hover((e) => e.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.code?.release(); this.code = null; this.preview = null; cx.notify(); })
      .child("←");
    const head = h_flex().h(32).flex_none().px(6).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(back).child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(p.title ?? ""))
      .child(h_flex().id("pv-copy").h(22).px(7).flex_none().items_center().rounded(6).text_size(11.5)
        .text_color(t.accent).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => {
          if (p.kind === "image") this.copyImage(p.path, cx);
          else if (p.text) cx.write_to_clipboard(p.text);
        })
        .child(p.kind === "image" ? "Copy image" : "Copy text"))
      .when(p.kind === "image" || p.kind === "other", (e) => e.child(h_flex().id("pv-open").h(22).px(7).flex_none().items_center().rounded(6).text_size(11.5)
        .text_color(t.accent).hover((x) => x.bg(t.hover)).on_click(() => this.openElsewhere(p.path)).child("Open")));
    const foot = h_flex().flex_none().px(10).py(5).gap(8).border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(p.path ?? ""))
      .when(Boolean(this.copiedMsg), (e) => e.child(div().text_size(10.5).text_color(t.done).child(this.copiedMsg)));
    const body = p.kind === "image" && p.rel ? div().flex_1().min_h(0).p(8).child(image(p.rel).size_full())
      : p.kind === "text" && this.code ? Editor.new(this.code).flex_1().min_h(0)
        : v_flex().flex_1().min_h(0).p(12).child(div().text_size(11.5).text_color(p.error ? t.blocked : t.dim)
          .child(p.note ?? (p.kind === "loading" ? "Reading…" : "")));
    return v_flex().id("preview").size_full().min_w(0).bg(t.surface).text_color(t.foreground).child(head).child(body).child(foot);
  }
}
