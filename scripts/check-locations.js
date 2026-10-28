"use strict";
// Compares the server's LOCATIONS catalogue with the client's FALLBACK_LOCATIONS.
// The client copy is only ever used when no server is reachable, so the two must
// stay identical or the offline donor form silently offers the wrong sites.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Scans forward from the first "[" tracking bracket depth while skipping string
// literals, so the array is closed on its own terms rather than by indentation.
function grab(file, marker) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("marker not found: " + marker);

  const open = src.indexOf("[", start);
  if (open === -1) throw new Error("no array after marker in " + file);

  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unterminated array in " + file);
}

const serverSrc = grab("server.js", "const LOCATIONS");
const clientSrc = grab("app.js", "var FALLBACK_LOCATIONS");

// Both blocks are plain object literals, so they evaluate as data.
const server = eval("(" + serverSrc + ")");
const client = eval("(" + clientSrc + ")");

const key = (l) => [l.id, l.name, l.kind, l.lat, l.lng].join("|");
const a = server.map(key);
const b = client.map(key);

const onlyServer = a.filter((k) => !b.includes(k));
const onlyClient = b.filter((k) => !a.includes(k));
const order = a.length === b.length && a.every((k, i) => k === b[i]);

if (onlyServer.length || onlyClient.length || !order) {
  console.error("Location catalogues have drifted apart.");
  onlyServer.forEach((k) => console.error("  only in server.js: " + k));
  onlyClient.forEach((k) => console.error("  only in app.js:    " + k));
  if (!onlyServer.length && !onlyClient.length) console.error("  (same entries, different order)");
  process.exit(1);
}

console.log("location catalogue matches across server.js and app.js (" + a.length + " sites)");
