"use strict";
// End-to-end checks against a live server on a scratch port and scratch data
// file. Run with: node scripts/test.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 3987;
const DATA = path.join(os.tmpdir(), "aaharsetu-test-" + process.pid + ".json");
process.env.PORT = String(PORT);
process.env.DATA_FILE = DATA;

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

function request(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: p, method, agent: false,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function post(type, extra) {
  return request("POST", "/api/op", Object.assign({ type: type }, extra || {}));
}

function seedBatch(over) {
  return Object.assign(
    {
      id: "b" + Math.random().toString(36).slice(2, 8),
      channel: "human",
      status: "available",
      item: "Rice & Dal",
      qty: 10,
      kg: 10,
      prepAt: Date.now(),
      windowMin: 240,
      locId: "canteen-a",
      created: Date.now()
    },
    over || {}
  );
}

async function run() {
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 700));

  console.log("\nmalformed paths no longer crash the process");
  for (const p of ["/%", "/%E0%A4%A", "/%zz", "/%c0%80", "/../../etc/passwd", "/%00", "/a/../../server.js"]) {
    const r = await request("GET", p);
    check("GET " + p + " -> " + r.status, r.status >= 200 && r.status < 500, r.raw);
  }
  const alive = await request("GET", "/api/state");
  check("server still serving /api/state after malformed paths", alive.status === 200);

  console.log("\nstatic serving is an allowlist (data file + source stay private)");
  for (const p of ["/data.json", "/server.js", "/package.json", "/AGENTS.md", "/.gitignore"]) {
    const r = await request("GET", p);
    check("GET " + p + " -> 404", r.status === 404, String(r.status));
  }
  const page = await request("GET", "/");
  check("GET / serves the page", page.status === 200 && /<html/i.test(page.raw), String(page.status));
  for (const p of ["/app.js", "/styles.css", "/favicon.svg"]) {
    const r = await request("GET", p);
    check("GET " + p + " -> 200", r.status === 200 && r.raw.length > 0, String(r.status));
  }

  console.log("\nchannel guards on terminal ops");
  await post("clear");
  const human = seedBatch();
  const posted = await post("post", { batch: human });
  check("post human batch", posted.status === 200 && posted.json.ok);

  const claimed = await post("claim", { id: human.id, by: "Test NGO" });
  check("claim succeeds", claimed.status === 200 && claimed.json.ok);
  const code = claimed.json.posts.find((p) => p.id === human.id).code;
  check("claim issued a code", typeof code === "string" && code.length > 0, String(code));

  const badComplete = await post("complete", { id: human.id, by: "Compost Unit" });
  check("complete rejected on a human batch", badComplete.status === 409 && !badComplete.json.ok, JSON.stringify(badComplete.json));

  const wrongCode = await post("handshake", { id: human.id, code: "#ZZZ-999" });
  check("handshake rejected on a wrong code", wrongCode.status === 409 && !wrongCode.json.ok);

  const lower = code.toLowerCase();
  const goodCode = await post("handshake", { id: human.id, code: lower });
  check("handshake accepted case-insensitively", goodCode.status === 200 && goodCode.json.ok);
  check("handshakeAt recorded", !!goodCode.json.posts.find((p) => p.id === human.id).handshakeAt);

  console.log("\ncompost flow");
  const feed = seedBatch({ id: "c1", channel: "compost", status: "available", qty: 0, kg: 20 });
  await post("post", { batch: feed });
  await post("claim", { id: "c1", by: "Campus Compost Pit" });
  const done = await post("complete", { id: "c1", by: "Campus Compost Pit" });
  check("complete accepted on compost feedstock", done.status === 200 && done.json.ok);
  const finished = done.json.posts.find((p) => p.id === "c1");
  check("compost yield computed", Math.abs(finished.yieldKg - 7) < 0.01, String(finished.yieldKg));
  check("compostUnit recorded", finished.compostUnit === "Campus Compost Pit");
  const stillHuman = done.json.posts.find((p) => p.id === human.id);
  check("human batch untouched by the compost op", stillHuman.status === "claimed" && stillHuman.claimedBy === "Test NGO");
  const compostHs = await post("handshake", { id: "c1", code: finished.code });
  check("handshake rejected on compost feedstock", compostHs.status === 409 && !compostHs.json.ok);

  console.log("\nTTL re-route");
  const stale = seedBatch({ id: "s1", prepAt: Date.now() - 8 * 3600e3, windowMin: 60 });
  await post("post", { batch: stale });
  const state = await request("GET", "/api/state");
  const rerouted = state.json.posts.find((p) => p.id === "s1");
  check("expired human batch moved to compost", rerouted.channel === "compost", JSON.stringify(rerouted));
  check("re-route cleared the code", rerouted.code === null);
  check("reroutedAt stamped", !!rerouted.reroutedAt);

  console.log("\nadmin token gate");
  await post("clear");
  check("clear allowed with no token configured", (await post("clear")).status === 200);
  await adminTokenChecks();

  console.log("\nbody limits and malformed input");
  const big = await post("demo", { batches: [seedBatch({ item: "x".repeat(40000) })] });
  check("oversized body -> 413", big.status === 413, String(big.status));
  const notJson = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/op", method: "POST", agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", (e) => resolve({ status: 0, code: e.code }));
    req.write("{not json");
    req.end();
  });
  check("malformed JSON -> 400", notJson.status === 400, "got " + notJson.status + " " + (notJson.code || ""));

  // A browser keeps connections alive, so a 413 must not poison the pool.
  const kaAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const kaPost = (payload) => new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/op", method: "POST", agent: kaAgent,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", (e) => resolve({ status: 0, code: e.code }));
    req.write(data);
    req.end();
  });
  const kaBig = await kaPost({ type: "demo", batches: [seedBatch({ item: "x".repeat(40000) })] });
  check("keep-alive client gets 413, not a reset", kaBig.status === 413, "got " + kaBig.status + " " + (kaBig.code || ""));
  const kaNext = await kaPost({ type: "clear" });
  check("keep-alive client recovers after a 413", kaNext.status === 200, "got " + kaNext.status + " " + (kaNext.code || ""));
  kaAgent.destroy();
  const arrayBody = await request("POST", "/api/op", [1, 2, 3]);
  check("array body -> 400", arrayBody.status === 400, String(arrayBody.status));
  const badOp = await post("nonsense");
  check("unknown op -> 409", badOp.status === 409, String(badOp.status));
  const spoof = await post("post", { batch: seedBatch({ locId: "not-a-real-site" }) });
  check("unknown location rejected", spoof.status === 409 && !spoof.json.ok);
  const spoofName = await post("post", { batch: seedBatch({ locId: "canteen-a", name: "Evil Kitchen" }) });
  check("extra fields are dropped, not trusted", spoofName.status === 200 && !("name" in spoofName.json.posts[0]));

  console.log("\nstate endpoint and persistence");
  const afterAll = await request("GET", "/api/state");
  check("/api/state returns locations", Array.isArray(afterAll.json.locations) && afterAll.json.locations.length === 16);
  check("/api/state returns server now", typeof afterAll.json.now === "number");
  const dead = await request("POST", "/api/state", {});
  check("POST /api/state -> 410", dead.status === 410);
  const missing = await request("GET", "/api/nope");
  check("unknown api route -> 404", missing.status === 404);

  await new Promise((r) => setTimeout(r, 400));
  const onDisk = JSON.parse(fs.readFileSync(DATA, "utf8"));
  check("batches were written to disk", Array.isArray(onDisk) && onDisk.length === afterAll.json.posts.length,
    onDisk.length + " on disk vs " + afterAll.json.posts.length + " in memory");

  console.log("\n" + pass + " passed, " + fail + " failed");
  try { fs.unlinkSync(DATA); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

// ADMIN_TOKEN is read once at module load, so the gate gets its own server
// process rather than fighting this one's cached config.
function adminTokenChecks() {
  return new Promise((resolve) => {
    const TOKEN = "s3cret-lab-token";
    const PORT2 = PORT + 1;
    const DATA2 = DATA.replace(/\.json$/, "-admin.json");
    const child = require("child_process").spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(PORT2), DATA_FILE: DATA2, ADMIN_TOKEN: TOKEN }),
      stdio: "ignore"
    });

    const call = (payload) => new Promise((res) => {
      const data = JSON.stringify(payload);
      const req = http.request({ host: "127.0.0.1", port: PORT2, path: "/api/op", method: "POST", agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => {
        let raw = "";
        r.on("data", (c) => { raw += c; });
        r.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          res({ status: r.statusCode, json });
        });
      });
      req.on("error", (e) => res({ status: 0, code: e.code }));
      req.write(data);
      req.end();
    });

    setTimeout(async () => {
      const noToken = await call({ type: "clear" });
      check("clear refused without a token", noToken.status === 409 && noToken.json.error === "admin token required", JSON.stringify(noToken.json));

      const wrong = await call({ type: "clear", token: "wrong" });
      check("clear refused with a wrong token", wrong.status === 409, JSON.stringify(wrong.json));

      const good = await call({ type: "clear", token: TOKEN });
      check("clear accepted with the right token", good.status === 200 && good.json.ok);

      const demoNo = await call({ type: "demo", batches: [seedBatch()] });
      check("demo refused without a token", demoNo.status === 409);
      const demoYes = await call({ type: "demo", batches: [seedBatch()], token: TOKEN });
      check("demo accepted with the right token", demoYes.status === 200);

      // Read-only and single-batch ops must stay open, or a lab demo with a
      // token configured becomes unusable.
      const claim = await call({ type: "claim", id: "missing", by: "x" });
      check("non-admin ops are not token-gated", claim.status === 409 && claim.json.error === "not found");

      child.kill();
      try { fs.unlinkSync(DATA2); } catch (e) {}
      resolve();
    }, 900);
  });
}

run().catch((e) => {
  console.error("test harness crashed:", e);
  try { fs.unlinkSync(DATA); } catch (er) {}
  process.exit(1);
});
