"use strict";
// Boots the real page in headless Edge and reports anything the console logs,
// so client-side breakage cannot hide behind `node --check`.
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((p) => fs.existsSync(p));

const PORT = 3973;
const DATA = path.join(os.tmpdir(), "aaharsetu-edge-" + process.pid + ".json");
const PROFILE = path.join(os.tmpdir(), "aaharsetu-edge-profile-" + process.pid);
process.env.PORT = String(PORT);
process.env.DATA_FILE = DATA;

if (!EDGE) { console.log("no edge found, skipping"); process.exit(0); }

require(path.join(__dirname, "..", "server.js"));

const browser = spawn(EDGE, [
  "--headless=new",
  "--remote-debugging-port=9333",
  "--user-data-dir=" + PROFILE,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "about:blank"
], { stdio: "ignore" });

function devtools(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12000;
    const poll = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/list" }, (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try {
            const tabs = JSON.parse(raw).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
            if (tabs.length) return resolve(tabs[0].webSocketDebuggerUrl);
          } catch (e) {}
          retry();
        });
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("devtools never came up"));
      setTimeout(poll, 250);
    };
    poll();
  });
}

// Minimal CDP client over the raw websocket protocol.
function connect(wsUrl) {
  const net = require("net");
  const crypto = require("crypto");
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const sock = net.connect(Number(u.port), u.hostname, () => {
    sock.write(
      "GET " + u.pathname + u.search + " HTTP/1.1\r\n" +
      "Host: " + u.host + "\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
  });
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const api = {
      onMessage: null,
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj), "utf8");
        const mask = crypto.randomBytes(4);
        const head = [];
        head.push(0x81);
        const len = payload.length;
        if (len < 126) head.push(0x80 | len);
        else if (len < 65536) head.push(0x80 | 126, (len >> 8) & 255, len & 255);
        else head.push(0x80 | 127, 0, 0, 0, 0, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        sock.write(Buffer.concat([Buffer.from(head), mask, masked]));
      },
      close() { try { sock.destroy(); } catch (e) {} }
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        buf = buf.slice(end + 4);
        upgraded = true;
        resolve(api);
      }
      while (buf.length >= 2) {
        const b1 = buf[0], b2 = buf[1];
        let len = b2 & 127;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString("utf8");
        buf = buf.slice(off + len);
        if ((b1 & 0x0f) === 0x01 && api.onMessage) {
          try { api.onMessage(JSON.parse(payload)); } catch (e) {}
        }
      }
    });
    sock.on("error", () => {});
  });
}

setTimeout(async () => {
  const ws = await devtools(9333);
  const cdp = await connect(ws);
  const logs = [];
  let id = 0;
  const pending = new Map();
  cdp.onMessage = (m) => {
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      logs.push(m.params.type + ": " + m.params.args.map((a) => a.value || a.description || "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("EXCEPTION: " + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      logs.push("LOG: " + m.params.entry.text + " " + (m.params.entry.url || ""));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send({ id: i, method, params: params || {} }); });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/" });
  await new Promise((r) => setTimeout(r, 2500));

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r && r.result ? r.result.value : undefined;
  };

  console.log("\npage boot");
  console.log("  title:            " + await evalJs("document.title"));
  console.log("  net status:       " + await evalJs("document.getElementById('netStatus').textContent"));
  console.log("  live clock:       " + await evalJs("document.getElementById('liveClock').textContent"));
  console.log("  locations loaded: " + await evalJs("document.getElementById('fLoc').options.length"));
  console.log("  window note:      " + await evalJs("document.getElementById('windowNoteText').textContent.slice(0,60)"));
  console.log("  submit disabled:  " + await evalJs("document.getElementById('btnSubmit').disabled"));

  console.log("\nseed sample data and post");
  await evalJs("document.getElementById('btnDemo').click()");
  await new Promise((r) => setTimeout(r, 1200));
  console.log("  donor badge:      " + await evalJs("document.getElementById('nbDonor').textContent"));
  console.log("  feed badge:       " + await evalJs("document.getElementById('nbFeed').textContent"));
  console.log("  compost badge:    " + await evalJs("document.getElementById('nbCompost').textContent"));
  console.log("  impact badge:     " + await evalJs("document.getElementById('nbImpact').textContent"));

  await evalJs("document.querySelector('.tab[data-tab=feed]').click()");
  await new Promise((r) => setTimeout(r, 400));
  const leak = await evalJs(
    "Array.from(document.querySelectorAll('#feedGrid .code-chip')).map(e=>e.textContent.trim()).join(' | ')"
  );
  console.log("  feed code chips:  " + JSON.stringify(leak));
  const codes = await evalJs(
    "(function(){var s='';document.querySelectorAll('#feedGrid .card,.post-card').forEach(function(c){});return s;})()"
  );
  const rawCodeOnBoard = await evalJs(
    "/#[A-Z]{3}-\\d{3}/.test(document.getElementById('feedGrid').textContent + document.getElementById('compostGrid').textContent)"
  );
  console.log("  raw code on board:" + rawCodeOnBoard + (rawCodeOnBoard ? "  <-- LEAK" : "  (good)"));

  console.log("\nclaim a batch");
  await evalJs("document.getElementById('fWho').value='Edge Test NGO'; document.querySelector('#feedGrid [data-claim]').click()");
  await new Promise((r) => setTimeout(r, 1200));
  console.log("  toast:            " + await evalJs("document.getElementById('toast').textContent.replace(/\\n/g,' / ')"));
  console.log("  toast sticky:     " + await evalJs("document.getElementById('toast').classList.contains('sticky')"));
  const afterClaim = await evalJs(
    "/#[A-Z]{3}-\\d{3}/.test(document.getElementById('feedGrid').textContent)"
  );
  console.log("  code leaked back onto the card after claim: " + afterClaim + (afterClaim ? "  <-- LEAK" : "  (good)"));

  console.log("\nimpact tab renders");
  await evalJs("document.querySelector('.tab[data-tab=impact]').click()");
  await new Promise((r) => setTimeout(r, 900));
  for (const id of ["statDiverted", "statMeals", "statComposted", "statCo2", "t1Kg", "t2Kg", "t2Yield"]) {
    console.log("  " + id.padEnd(16) + await evalJs("document.getElementById('" + id + "').textContent"));
  }
  console.log("  chart columns:    " + await evalJs("document.querySelectorAll('#chart .chart-col').length"));
  console.log("  history rows:     " + await evalJs("document.querySelectorAll('#historyList .h-row').length"));
  console.log("  assumptions:      " + await evalJs("document.querySelectorAll('#assumptions div').length"));

  console.log("\ncompost tab renders");
  await evalJs("document.querySelector('.tab[data-tab=compost]').click()");
  await new Promise((r) => setTimeout(r, 600));
  console.log("  cards:            " + await evalJs("document.querySelectorAll('#compostGrid .post-card').length"));
  console.log("  count:            " + await evalJs("document.getElementById('compostCount').textContent"));

  console.log("\nconsole errors/warnings: " + (logs.length ? "" : "none"));
  logs.forEach((l) => console.log("  " + l));

  cdp.close();
  try { browser.kill(); } catch (e) {}
  try { fs.unlinkSync(DATA); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(logs.length ? 1 : 0);
}, 900);
