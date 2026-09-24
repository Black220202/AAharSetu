// FoodRescue shared server — lets multiple devices sync one live feed.
// Run:  node server.js    (from the folder containing index.html)
// Then open http://localhost:3000 on this PC and http://<your-LAN-IP>:3000 on other devices.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data.json");

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf8")); }
  catch (e) { return []; }
}

function saveData(posts) {
  fs.writeFileSync(DATA, JSON.stringify(posts, null, 2));
}

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

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/state") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ posts: loadData() }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => { if (body.length < 2e6) body += c; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const posts = Array.isArray(parsed.posts) ? parsed.posts : [];
            saveData(posts);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, posts }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "bad request body" }));
          }
        });
        return;
      }
    }

    // static files (serve the app)
    let name = decodeURIComponent(url.pathname);
    if (name.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }
    const file = path.join(ROOT, name === "/" ? "index.html" : name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    const nets = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log("");
    console.log("  FoodRescue server is running");
    console.log("  ------------------------------");
    console.log("  This PC:    http://localhost:" + PORT);
    nets.forEach((ip) => console.log("  Any device: http://" + ip + ":" + PORT));
    console.log("  Data file:  " + DATA);
    console.log("");
  });