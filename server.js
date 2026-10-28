// AaharSetu shared server — one authoritative state for the whole campus network.
// Run:  node server.js    (from this folder)
// Then open http://localhost:3000 on this PC and http://<your-LAN-IP>:3000 on other devices.
//
// Writes are single-op mutations against a serialized queue, never whole-state
// overwrites, so two devices claiming the same batch cannot clobber each other.
//
// Environment:
//   PORT         listen port (default 3000)
//   DATA_FILE    board file (default ./data.json next to this file)
//   ADMIN_TOKEN  when set, the board-wide "clear" and "demo" ops require it
//   TRUST_PROXY  set to 1 to bucket rate limits by X-Forwarded-For
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = process.env.DATA_FILE || path.join(ROOT, "data.json");

// Destructive, board-wide operations. When ADMIN_TOKEN is set the client must
// echo it in `op.token`; when it is unset the lab demo stays frictionless.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Render & friends terminate TLS in front of us, so socket.remoteAddress is the
// proxy for every request unless we are told to trust the forwarding header.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

const MAX_BODY = 32 * 1024;
const MAX_BATCHES = 400;
const MAX_MEALS = 9999;
const MAX_KG = 9999;
const MAX_TEXT = 90;
const MAX_CODE_LEN = 16;
const PREP_SKEW_MS = 6 * 3600e3;
const MAX_HISTORY_MS = 60 * 24 * 3600e3;
const RATE_WINDOW_MS = 10000;
const RATE_MAX_OPS = 60;

// Campus location catalogue. Coordinates are approximate campus positions and are
// the single source of truth: the server canonicalises name/lat/lng from `id`, so
// clients cannot spoof a location and clients never need their own copy.
const LOCATIONS = [
  { id: "canteen-a",    name: "Campus Canteen A",            kind: "kitchen", lat: 18.54790, lng: 73.85520 },
  { id: "canteen-b",    name: "Campus Canteen B",            kind: "kitchen", lat: 18.54620, lng: 73.85710 },
  { id: "mess-h1",      name: "Hostel Mess 1 — Boys",        kind: "kitchen", lat: 18.54930, lng: 73.85800 },
  { id: "mess-h2",      name: "Hostel Mess 2 — Girls",       kind: "kitchen", lat: 18.55010, lng: 73.85510 },
  { id: "mess-h3",      name: "Hostel Mess 3",               kind: "kitchen", lat: 18.54560, lng: 73.85860 },
  { id: "banquet",      name: "University Banquet Hall",     kind: "kitchen", lat: 18.54860, lng: 73.85680 },
  { id: "dept-coffee",  name: "Department Coffee Point",     kind: "kitchen", lat: 18.54710, lng: 73.85610 },
  { id: "agri-kitchen", name: "Agri Science Garden Kitchen", kind: "kitchen", lat: 18.54490, lng: 73.85430 },

  { id: "vol-hub",      name: "Student Volunteer Hub",       kind: "hub", lat: 18.54740, lng: 73.85670 },
  { id: "ngo-siddhi",   name: "Siddhivinayak Orphanage Hub", kind: "hub", lat: 18.54320, lng: 73.85920 },
  { id: "shelter-karuna", name: "Karuna Shelter",            kind: "hub", lat: 18.55220, lng: 73.85380 },
  { id: "seva-kitchen", name: "Annapurna Seva Kitchen",      kind: "hub", lat: 18.54660, lng: 73.86010 },

  { id: "pit-nursery",  name: "Campus Compost Pit — Nursery",    kind: "compost", lat: 18.54430, lng: 73.85670 },
  { id: "pit-community", name: "Community Garden Composter",     kind: "compost", lat: 18.54350, lng: 73.85310 },
  { id: "windrow-agri", name: "Agri Cluster Windrow",            kind: "compost", lat: 18.54400, lng: 73.85250 },
  { id: "bin-hostel",   name: "Hostel Organic Bin Station",      kind: "compost", lat: 18.54970, lng: 73.85730 }
];

const LOC_BY_ID = new Map(LOCATIONS.map((l) => [l.id, l]));

/* ---------------- validation ---------------- */

const CHANNELS = ["human", "compost"];
const STATUSES = ["available", "claimed", "done", "cancelled"];
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CODE_RE = /^[A-Z0-9#-]{1,16}$/;

function isInt(v) { return typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v; }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// Constant-time comparison for the admin token and the handshake code, so a
// caller cannot learn a secret one character at a time from response timing.
function secretEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function text(v, max) {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!t || t.length > max) return null;
  return t;
}

function ts(v) {
  if (!isInt(v) || v <= 0) return null;
  const now = Date.now();
  if (v > now + PREP_SKEW_MS) return null;
  if (v < now - MAX_HISTORY_MS) return null;
  return v;
}

// Rebuilds a batch from untrusted input, dropping every field it does not know.
// Returns null when the payload cannot be trusted.
function sanitizeBatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const loc = typeof raw.locId === "string" ? LOC_BY_ID.get(raw.locId) : null;
  if (!loc) return null;
  if (CHANNELS.indexOf(raw.channel) === -1) return null;
  if (STATUSES.indexOf(raw.status) === -1) return null;

  const item = text(raw.item, MAX_TEXT);
  if (!item) return null;

  const qty = isInt(raw.qty) ? Math.min(Math.max(raw.qty, 0), MAX_MEALS) : null;
  const kg = isNum(raw.kg) ? Math.round(Math.min(Math.max(raw.kg, 0), MAX_KG) * 10) / 10 : null;
  if (qty === null || kg === null) return null;
  if (qty <= 0 && kg <= 0) return null;

  const id = ID_RE.test(String(raw.id)) ? String(raw.id) : null;
  const prepAt = ts(raw.prepAt);
  if (!id || prepAt === null) return null;

  const windowMin = isInt(raw.windowMin) ? Math.min(Math.max(raw.windowMin, 15), 720) : 240;
  const safeUntil = prepAt + windowMin * 60000;

  const claimedBy = text(raw.claimedBy, MAX_TEXT);
  const code = typeof raw.code === "string" && CODE_RE.test(raw.code) ? raw.code : null;
  const compostUnit = text(raw.compostUnit, MAX_TEXT);

  return {
    id,
    channel: raw.channel,
    status: raw.status,
    item,
    qty,
    kg,
    prepAt,
    windowMin,
    safeUntil,
    locId: loc.id,
    code,
    claimedAt: ts(raw.claimedAt),
    claimedBy,
    handshakeAt: ts(raw.handshakeAt),
    reroutedAt: ts(raw.reroutedAt),
    collectedAt: ts(raw.collectedAt),
    compostedAt: ts(raw.compostedAt),
    compostUnit,
    yieldKg: isNum(raw.yieldKg) ? Math.round(Math.min(Math.max(raw.yieldKg, 0), MAX_KG) * 10) / 10 : null,
    created: isInt(raw.created) && raw.created > 0 ? Math.min(raw.created, Date.now()) : Date.now()
  };
}

function sanitizeAll(list) {
  if (!Array.isArray(list)) return null;
  if (list.length > MAX_BATCHES) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const b = sanitizeBatch(raw);
    if (!b) continue;
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

/* ---------------- state ---------------- */

let posts = [];

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA, "utf8"));
    posts = sanitizeAll(Array.isArray(parsed) ? parsed : parsed.posts) || [];
  } catch (e) {
    posts = [];
  }
  return posts;
}

let writes = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(posts, null, 2);
  const tmp = DATA + ".tmp";
  writes = writes.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(tmp, snapshot, (err) => {
          if (err) {
            console.error("[data] write failed:", err.message);
            fs.unlink(tmp, () => resolve());
            return;
          }
          fs.rename(tmp, DATA, (err) => {
            // A failed rename loses the batch silently if it goes unreported,
            // which is the one failure mode a shared board cannot absorb.
            if (err) {
              console.error("[data] rename to " + DATA + " failed:", err.message);
              fs.unlink(tmp, () => resolve());
              return;
            }
            resolve();
          });
        });
      })
  );
  return writes;
}

// TTL: a human batch nobody claimed in time stops being food and becomes feedstock.
function applyTtl() {
  const now = Date.now();
  let changed = false;
  for (const p of posts) {
    if (p.channel === "human" && p.status === "available" && p.safeUntil <= now) {
      p.channel = "compost";
      p.reroutedAt = now;
      p.code = null;
      changed = true;
    }
  }
  return changed;
}

function code() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 3; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return "#" + out + "-" + (100 + Math.floor(Math.random() * 900));
}

function byId(batchId) { return posts.find((p) => p.id === batchId) || null; }

/* ---------------- operations ---------------- */

// Every mutation runs inside the queue, so read-modify-write is never interleaved.
function applyOp(op) {
  if (applyTtl()) persist();

  // Settle TTL after the mutation too, so a post that is born expired is
  // reported on the compost channel in this same response.
  function done() {
    if (applyTtl()) persist();
    return { ok: true, posts };
  }

  // `clear` and `demo` replace the whole board, so they are the operations worth
  // protecting once the server leaves the trusted lab network.
  function adminDenied() {
    if (!ADMIN_TOKEN) return false;
    return !secretEquals(String(op.token || ""), ADMIN_TOKEN);
  }

  if (op.type === "post") {
    if (posts.length >= MAX_BATCHES) return { ok: false, error: "board full" };
    const b = sanitizeBatch(op.batch);
    if (!b) return { ok: false, error: "invalid batch" };
    if (byId(b.id)) return { ok: false, error: "duplicate id" };
    posts.unshift(b);
    persist();
    return done();
  }

  if (op.type === "clear") {
    if (adminDenied()) return { ok: false, error: "admin token required" };
    posts = [];
    persist();
    return done();
  }

  if (op.type === "demo") {
    if (adminDenied()) return { ok: false, error: "admin token required" };
    const seeded = sanitizeAll(op.batches);
    if (!seeded) return { ok: false, error: "invalid seed" };
    posts = seeded;
    persist();
    return done();
  }

  const p = byId(String(op.id || ""));
  if (!p) return { ok: false, error: "not found" };

  if (op.type === "claim") {
    if (p.status !== "available") return { ok: false, conflict: true, error: "already taken" };
    const by = text(op.by, MAX_TEXT) || "Volunteer / NGO";
    p.status = "claimed";
    p.code = code();
    p.claimedAt = Date.now();
    p.claimedBy = by;
    persist();
    return done();
  }

  if (op.type === "release") {
    if (p.status !== "claimed") return { ok: false, error: "not claimed" };
    p.status = "available";
    p.code = null;
    p.claimedAt = null;
    p.claimedBy = null;
    p.handshakeAt = null;
    persist();
    return done();
  }

  // Handover verification belongs to the Tier 1 human loop only; there is no
  // claimant/kitchen pair to verify once a batch has become compost feedstock.
  if (op.type === "handshake") {
    if (p.channel !== "human") return { ok: false, error: "not a rescue pickup" };
    if (p.status !== "claimed") return { ok: false, error: "not claimed" };
    if (!p.code) return { ok: false, error: "no code issued" };
    if (!secretEquals(String(op.code || "").toUpperCase(), p.code)) {
      return { ok: false, error: "code mismatch" };
    }
    p.handshakeAt = Date.now();
    persist();
    return done();
  }

  // Composting is the only terminal state. Without this channel guard an edible
  // batch could be closed out as composted, at which point the impact ledger
  // stops counting it as a rescue and its meals vanish from the totals.
  if (op.type === "complete") {
    if (p.channel !== "compost") return { ok: false, error: "not compost feedstock" };
    if (p.status !== "claimed") return { ok: false, error: "not collected" };
    const unit = text(op.by, MAX_TEXT) || "Compost Unit";
    p.status = "done";
    p.compostedAt = Date.now();
    p.compostUnit = unit;
    p.yieldKg = isNum(p.yieldKg) ? p.yieldKg : Math.round(p.kg * 0.35 * 10) / 10;
    persist();
    return done();
  }

  if (op.type === "cancel") {
    if (p.status !== "available") return { ok: false, error: "cannot cancel" };
    p.status = "cancelled";
    persist();
    return done();
  }

  return { ok: false, error: "unknown op" };
}

/* ---------------- http ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const rate = new Map();

// Behind a trusted proxy every socket shares one address, so bucket by the
// left-most forwarded hop instead of lumping all users into a single quota.
function clientKey(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : String(fwd || "").split(","))[0];
    const ip = String(first || "").trim().replace(/^::ffff:/, "");
    if (ip) return ip;
  }
  return (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
}

function tooMany(remote) {
  const now = Date.now();
  const hits = (rate.get(remote) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rate.set(remote, hits);
  if (rate.size > 500) {
    for (const [ip, list] of rate) if (!list.some((t) => now - t < RATE_WINDOW_MS)) rate.delete(ip);
  }
  return hits.length > RATE_MAX_OPS;
}

// Nothing on the page is inline (no <script> bodies, no on* handlers, no style
// attributes), so the policy can forbid inline code outright. The only remote
// origins are the Google Fonts stylesheet and its font files.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    // style attributes are set at runtime for chart bar heights and progress fills
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

function send(res, code_, body, type) {
  res.writeHead(code_, Object.assign({
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, SECURITY_HEADERS));
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// Answers 413 and retires the connection instead of destroying it silently,
// which used to leave the client waiting on a response that never arrived.
// The Connection: close matters: a keep-alive client would otherwise reuse a
// socket we are tearing down mid-body and see an ECONNRESET on its next call.
function readBody(req, res, cb) {
  let size = 0;
  let aborted = false;
  const parts = [];
  req.on("data", (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      parts.length = 0;
      req.pause();
      res.setHeader("Connection", "close");
      send(res, 413, { ok: false, error: "body too large" });
      res.on("finish", () => req.destroy());
      return;
    }
    parts.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    try { cb(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
    catch (e) { cb(null); }
  });
  req.on("error", () => { if (!aborted) { aborted = true; cb(null); } });
}

// Every exit from the handler goes through here, so a throw anywhere below
// becomes a 400 instead of an uncaught exception that takes the board offline.
function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    return send(res, 400, { ok: false, error: "bad url" });
  }

  const remote = clientKey(req);

  if (url.pathname === "/api/state") {
    if (req.method === "GET") {
      if (applyTtl()) persist();
      return send(res, 200, { posts, locations: LOCATIONS, now: Date.now() });
    }
    if (req.method === "POST") {
      return send(res, 410, { ok: false, error: "use /api/op" });
    }
  }

  if (url.pathname === "/api/op" && req.method === "POST") {
    if (tooMany(remote)) return send(res, 429, { ok: false, error: "slow down" });
    return readBody(req, res, (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return send(res, 400, { ok: false, error: "bad body" });
      }
      let result;
      try { result = applyOp(parsed); }
      catch (e) { return send(res, 500, { ok: false, error: "op failed" }); }
      return send(res, result.ok ? 200 : 409, result);
    });
  }

  if (url.pathname.startsWith("/api/")) return send(res, 404, { ok: false, error: "no such endpoint" });

  // "%" and friends are not valid percent-encoding; decodeURIComponent throws a
  // URIError on them, which would otherwise crash the process.
  let name;
  try {
    name = decodeURIComponent(url.pathname);
  } catch (e) {
    return send(res, 400, { ok: false, error: "bad path" });
  }
  if (name.includes("\0") || name.includes("..")) return send(res, 403, "forbidden", "text/plain; charset=utf-8");
  const file = path.join(ROOT, name === "/" ? "index.html" : name);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain; charset=utf-8");
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, Object.assign({
      "Content-Type": type,
      "Cache-Control": "no-store"
    }, SECURITY_HEADERS));
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      console.error("[http] unhandled:", e && e.message);
      if (!res.headersSent) send(res, 500, { ok: false, error: "server error" });
      else res.end();
    }
  })
  .listen(PORT, "0.0.0.0", () => {
    load();
    const nets = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log("");
    console.log("  AaharSetu server is running");
    console.log("  ----------------------------");
    console.log("  This PC:    http://localhost:" + PORT);
    nets.forEach((ip) => console.log("  Any device: http://" + ip + ":" + PORT));
    console.log("  Batches:    " + posts.length + " loaded from " + DATA);
    console.log("");
  });
