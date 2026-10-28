// AaharSetu client. Talks to the shared server through single-op mutations so
// two devices can never clobber each other's batches; falls back to localStorage
// when no server is reachable, mirroring the same op semantics locally.
(function () {
  "use strict";

  var KEY = "aaharsetu_batches_v1";
  var ADMIN_KEY = "aaharsetu_admin_token";

  /* Impact constants. Every derived figure in the UI comes from exactly these. */
  var MEAL_KG = 1;
  var CO2_PER_MEAL = 2.5;
  var CH4_PER_KG = 0.5;
  var GWP = 28;
  var COMPOST_YIELD = 0.35;

  // Used only when no server is reachable, so the donor form still works offline.
  var FALLBACK_LOCATIONS = [
    { id: "canteen-a", name: "Campus Canteen A", kind: "kitchen", lat: 18.5479, lng: 73.8552 },
    { id: "canteen-b", name: "Campus Canteen B", kind: "kitchen", lat: 18.5462, lng: 73.8571 },
    { id: "mess-h1", name: "Hostel Mess 1 — Boys", kind: "kitchen", lat: 18.5493, lng: 73.858 },
    { id: "mess-h2", name: "Hostel Mess 2 — Girls", kind: "kitchen", lat: 18.5501, lng: 73.8551 },
    { id: "mess-h3", name: "Hostel Mess 3", kind: "kitchen", lat: 18.5456, lng: 73.8586 },
    { id: "banquet", name: "University Banquet Hall", kind: "kitchen", lat: 18.5486, lng: 73.8568 },
    { id: "dept-coffee", name: "Department Coffee Point", kind: "kitchen", lat: 18.5471, lng: 73.8561 },
    { id: "agri-kitchen", name: "Agri Science Garden Kitchen", kind: "kitchen", lat: 18.5449, lng: 73.8543 },
    { id: "vol-hub", name: "Student Volunteer Hub", kind: "hub", lat: 18.5474, lng: 73.8567 },
    { id: "ngo-siddhi", name: "Siddhivinayak Orphanage Hub", kind: "hub", lat: 18.5432, lng: 73.8592 },
    { id: "shelter-karuna", name: "Karuna Shelter", kind: "hub", lat: 18.5522, lng: 73.8538 },
    { id: "seva-kitchen", name: "Annapurna Seva Kitchen", kind: "hub", lat: 18.5466, lng: 73.8601 },
    { id: "pit-nursery", name: "Campus Compost Pit — Nursery", kind: "compost", lat: 18.5443, lng: 73.8567 },
    { id: "pit-community", name: "Community Garden Composter", kind: "compost", lat: 18.5435, lng: 73.8531 },
    { id: "windrow-agri", name: "Agri Cluster Windrow", kind: "compost", lat: 18.544, lng: 73.8525 },
    { id: "bin-hostel", name: "Hostel Organic Bin Station", kind: "compost", lat: 18.5497, lng: 73.8573 }
  ];

  var KIND_LABEL = {
    kitchen: "Kitchens, messes & halls",
    hub: "Claimant hubs & shelters",
    compost: "Compost units & gardens"
  };

  var batches = [];
  var locations = [];
  var locById = {};
  var serverMode = null;
  var channel = "human";
  var origin = null;
  var feedSort = "soonest";
  var compostSort = "oldest";
  var feedSig = "";
  var compostSig = "";
  var impactSig = "";
  var prevNums = {};
  var feedEls = {};
  var compostEls = {};
  var seenCards = {};
  var busy = false;
  var adminToken = "";

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- escaping ---------- */
  var ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  /* ---------- helpers ---------- */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function locOf(id) { return locById[id] || null; }
  function locName(id) { var l = locOf(id); return l ? l.name : "Unknown site"; }

  function clockNow() { return new Date().toTimeString().slice(0, 5); }

  // A time input carries only HH:MM. The most recent past match is the sensible
  // reading, so a future value is walked back a day; the live note in the form
  // shows the resulting safe-consumption deadline so this is never a surprise.
  function tsFromTimeInput(v) {
    if (!v) return null;
    var p = v.split(":");
    if (p.length < 2) return null;
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (isNaN(h) || isNaN(m) || h > 23 || m > 59) return null;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d.getTime();
  }

  function fmtClock(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function compact(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return d + "d " + (h % 24) + "h";
    if (h > 0) return h + "h " + (m % 60) + "m";
    if (m > 0) return m + "m " + (s % 60) + "s";
    return s + "s";
  }

  function distanceMeters(a, b) {
    if (!a || !b) return null;
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function fmtDist(m) {
    if (m === null || m === undefined) return null;
    if (m < 950) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1) + " km";
  }

  function eta(p, now) {
    var total = Math.max(60000, p.windowMin * 60000);
    var remain = p.safeUntil - now;
    var pct = clamp(remain / total * 100, 0, 100);
    var minLeft = remain / 60000;
    var cls = minLeft <= 0 ? "crit" : pct > 50 ? "ok" : minLeft > 15 ? "warn" : "crit";
    return { text: remain > 0 ? compact(remain) : "expired", cls: cls, pct: pct, minLeft: minLeft };
  }

  function findBy(id) {
    for (var i = 0; i < batches.length; i++) if (batches[i].id === id) return batches[i];
    return null;
  }

  function handshakeCode() {
    var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var out = "";
    for (var i = 0; i < 3; i++) out += letters[Math.floor(Math.random() * letters.length)];
    return "#" + out + "-" + (100 + Math.floor(Math.random() * 900));
  }

  /* ---------- offline store ---------- */
  function loadLocal() {
    try { var v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(batches)); } catch (e) {} }

  function applyTtlLocal() {
    var now = Date.now();
    batches.forEach(function (b) {
      if (b.channel === "human" && b.status === "available" && b.safeUntil <= now) {
        b.channel = "compost";
        b.reroutedAt = now;
        b.code = null;
      }
    });
  }

  function localOp(payload) {
    applyTtlLocal();
    var now = Date.now();
    var p;

    if (payload.type === "post") {
      if (batches.some(function (b) { return b.id === payload.batch.id; })) return { ok: false, error: "duplicate id" };
      batches.unshift(payload.batch);
    } else if (payload.type === "clear") {
      batches = [];
    } else if (payload.type === "demo") {
      batches = payload.batches;
    } else {
      p = findBy(payload.id);
      if (!p) return { ok: false, error: "not found" };
      if (payload.type === "claim") {
        if (p.status !== "available") return { ok: false, conflict: true, error: "already taken" };
        p.status = "claimed";
        p.code = handshakeCode();
        p.claimedAt = now;
        p.claimedBy = payload.by || "Volunteer / NGO";
      } else if (payload.type === "release") {
        if (p.status !== "claimed") return { ok: false, error: "not claimed" };
        p.status = "available";
        p.code = null;
        p.claimedAt = null;
        p.claimedBy = null;
        p.handshakeAt = null;
      } else if (payload.type === "handshake") {
        if (p.channel !== "human") return { ok: false, error: "not a rescue pickup" };
        if (p.status !== "claimed") return { ok: false, error: "not claimed" };
        if (!p.code) return { ok: false, error: "no code issued" };
        if (String(payload.code || "").toUpperCase() !== String(p.code || "")) return { ok: false, error: "handshake code did not match" };
        p.handshakeAt = now;
      } else if (payload.type === "complete") {
        if (p.channel !== "compost") return { ok: false, error: "not compost feedstock" };
        if (p.status !== "claimed") return { ok: false, error: "not collected yet" };
        p.status = "done";
        p.compostedAt = now;
        p.compostUnit = payload.by || "Compost Unit";
        p.yieldKg = Math.round(p.kg * COMPOST_YIELD * 10) / 10;
      } else if (payload.type === "cancel") {
        if (p.status !== "available") return { ok: false, error: "cannot cancel" };
        p.status = "cancelled";
      } else {
        return { ok: false, error: "unknown op" };
      }
    }

    saveLocal();
    return { ok: true, posts: batches };
  }

  /* ---------- ops ---------- */
  function adopt(list) {
    var before = signature(batches);
    var after = signature(list);
    batches = list;
    if (before !== after) { feedSig = ""; compostSig = ""; impactSig = ""; }
  }

  function signature(list) {
    return list.map(function (b) {
      return [b.id, b.status, b.channel, b.code || "", b.kg, b.qty,
        b.claimedAt || 0, b.handshakeAt || 0, b.compostedAt || 0, b.yieldKg || 0].join(":");
    }).join("|");
  }

  function op(payload, onDone, onFail) {
    if (busy) { showToast("Still saving the last change…", true); return; }
    busy = true;
    setBusy(true);

    var p;
    if (serverMode) {
      p = fetch("/api/op", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          return r.json().catch(function () { return { ok: false, error: "unreadable response" }; })
            .then(function (d) { return d; });
        })
        .then(function (d) {
          if (d && Array.isArray(d.posts)) adopt(d.posts);
          return d || { ok: false, error: "no response" };
        })
        .catch(function () {
          serverMode = false;
          setStatus("off");
          return localOp(payload);
        });
    } else {
      p = Promise.resolve(localOp(payload));
    }

    p.then(function (res) {
      busy = false;
      setBusy(false);
      if (res && res.ok) { renderAll(); if (onDone) onDone(res); return; }
      renderAll();
      if (res && res.conflict) showToast("Someone else already claimed that batch", true);
      else if (res && res.error) showToast(res.error, true);
      if (onFail) onFail(res);
    });
  }

  // Board-wide actions are gated by ADMIN_TOKEN once the server leaves the lab
  // network. The token is only asked for if the server actually demands one.
  function adminOp(payload, onDone) {
    if (adminToken) payload.token = adminToken;
    op(payload, onDone, function (res) {
      if (!res || res.error !== "admin token required") return;
      var t = window.prompt(
        "This server protects board-wide actions with an admin token.\n\nEnter the ADMIN_TOKEN configured on the server:",
        ""
      );
      if (t === null) return;
      adminToken = t.trim();
      try { localStorage.setItem(ADMIN_KEY, adminToken); } catch (e) {}
      payload.token = adminToken;
      op(payload, onDone);
    });
  }

  function setBusy(state) {
    var b = $("btnSubmit");
    if (b) b.style.opacity = state ? "0.6" : "";
  }

  function setStatus(mode) {
    var el = $("netStatus");
    if (!el) return;
    el.textContent = mode === "on" ? "Live · shared" : mode === "off" ? "Local only" : "connecting…";
    el.className = "net-status " + mode;
  }

  /* ---------- boot ---------- */
  function boot() {
    setStatus("pending");
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("no server"); return r.json(); })
      .then(function (d) {
        serverMode = true;
        setStatus("on");
        setLocations(d.locations && d.locations.length ? d.locations : FALLBACK_LOCATIONS);
        adopt(d.posts || []);
        renderAll();
      })
      .catch(function () {
        serverMode = false;
        setStatus("off");
        setLocations(FALLBACK_LOCATIONS);
        batches = loadLocal();
        renderAll();
      });
  }

  function setLocations(list) {
    locations = list;
    locById = {};
    locations.forEach(function (l) { locById[l.id] = l; });
    buildSelects();
  }

  function buildSelects() {
    var sel = $("fLoc");
    var prevLoc = sel.value;
    sel.innerHTML = "";
    ["kitchen", "hub", "compost"].forEach(function (kind) {
      var group = document.createElement("optgroup");
      group.label = KIND_LABEL[kind];
      locations.filter(function (l) { return l.kind === kind; })
        .forEach(function (l) {
          var o = document.createElement("option");
          o.value = l.id;
          o.textContent = l.name;
          group.appendChild(o);
        });
      if (group.children.length) sel.appendChild(group);
    });
    sel.value = prevLoc && locById[prevLoc] ? prevLoc : (sel.options[0] ? sel.options[0].value : "");

    var originSel = $("fOrigin");
    var prevOrigin = originSel.value;
    originSel.innerHTML = "";
    var any = document.createElement("option");
    any.value = "";
    any.textContent = "Anywhere on campus";
    originSel.appendChild(any);

    if (navigator.geolocation) {
      var me = document.createElement("option");
      me.value = "me";
      me.textContent = "Use my device location";
      originSel.appendChild(me);
    }

    locations.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l.id;
      o.textContent = "From " + l.name;
      originSel.appendChild(o);
    });
    originSel.value = prevOrigin;
    if (originSel.value !== prevOrigin) { originSel.value = ""; origin = null; }

    updateFormState();
  }

  /* ---------- impact model ---------- */
  function impact() {
    var m = {
      meals: 0, kgRescued: 0, claims: 0, t1Today: 0,
      kgComposted: 0, yieldKg: 0, compostBatches: 0,
      rerouted: 0, reroutedDone: 0, directDone: 0, kgWaiting: 0, logged: 0
    };
    var todayKey = new Date().toDateString();

    batches.forEach(function (b) {
      if (b.status === "cancelled") return;
      m.logged += b.kg;
      if (b.reroutedAt) m.rerouted++;

      if (b.channel === "human" && b.status === "claimed") {
        m.meals += b.qty;
        m.kgRescued += b.kg;
        m.claims++;
        if (b.claimedAt && new Date(b.claimedAt).toDateString() === todayKey) m.t1Today += b.kg;
      }
      if (b.channel === "compost") {
        if (b.status === "available" || b.status === "claimed") m.kgWaiting += b.kg;
        if (b.status === "done") {
          m.kgComposted += b.kg;
          m.yieldKg += b.yieldKg || b.kg * COMPOST_YIELD;
          m.compostBatches++;
          if (b.reroutedAt) m.reroutedDone++; else m.directDone++;
        }
      }
    });

    m.diverted = m.kgRescued + m.kgComposted;
    m.share = m.logged > 0 ? m.diverted / m.logged * 100 : 0;
    m.ch4 = m.diverted * CH4_PER_KG;
    m.landfillCo2 = m.ch4 * GWP;
    m.productionCo2 = m.meals * CO2_PER_MEAL;
    m.co2 = m.landfillCo2 + m.productionCo2;
    m.avg = m.claims ? m.kgRescued / m.claims : 0;
    return m;
  }

  /* ---------- icons ---------- */
  var ICO_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  var ICO_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  var ICO_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICO_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6l-8-3z"/><path d="M9 12l2 2 4-4"/></svg>';
  var ICO_LEAF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M10 20v-5h4v5"/></svg>';
  var ICO_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var ICO_ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h6a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h2"/><path d="M17 15l3 3-3 3"/></svg>';

  /* ---------- render ---------- */
  function renderAll() {
    renderBadges();
    renderSide();
    renderFeed();
    renderCompost();
    renderImpact();
    tickClocks();
  }

  function renderBadges() {
    var m = impact();
    setText("nbDonor", batches.length);
    setText("nbFeed", batches.filter(function (b) { return b.channel === "human" && b.status === "available"; }).length);
    setText("nbCompost", batches.filter(function (b) { return b.channel === "compost" && b.status === "available"; }).length);
    setText("nbImpact", Math.round(m.diverted) + " kg");
  }

  function renderSide() {
    var m = impact();
    var meals = 0, feedKg = 0;
    batches.forEach(function (b) {
      if (b.status !== "available") return;
      if (b.channel === "human") meals += b.qty; else feedKg += b.kg;
    });
    setText("sideMeals", meals);
    setText("sideCompost", Math.round(feedKg) + " kg");
    setText("sideRescued", Math.round(m.kgRescued) + " kg");
    setText("sideYield", m.yieldKg.toFixed(1) + " kg");
  }

  function byDistance(a, b) {
    var da = distanceMeters(origin, locOf(a.locId));
    var db = distanceMeters(origin, locOf(b.locId));
    if (da === null || db === null) return 0;
    return da - db;
  }

  function humanList() {
    var list = batches.filter(function (b) {
      return b.channel === "human" && (b.status === "available" || b.status === "claimed");
    });
    list.sort(function (a, b) {
      if ((a.status === "available") !== (b.status === "available")) return a.status === "available" ? -1 : 1;
      if (feedSort === "newest") return b.created - a.created;
      if (feedSort === "bulk") return b.kg - a.kg || b.qty - a.qty;
      if (feedSort === "nearest" && origin) {
        var d = byDistance(a, b);
        if (d) return d;
      }
      return a.safeUntil - b.safeUntil || b.created - a.created;
    });
    return list;
  }

  function compostList() {
    var list = batches.filter(function (b) { return b.channel === "compost" && b.status !== "cancelled"; });
    list.sort(function (a, b) {
      if ((a.status === "done") !== (b.status === "done")) return a.status === "done" ? 1 : -1;
      if (compostSort === "nearest" && origin) {
        var d = byDistance(a, b);
        if (d) return d;
      }
      if (compostSort === "bulk") return b.kg - a.kg;
      return (a.reroutedAt || a.created) - (b.reroutedAt || b.created);
    });
    return list;
  }

  function renderFeed() {
    var list = humanList();
    setText("feedCount", list.filter(function (b) { return b.status === "available"; }).length);
    setText("feedHint", origin
      ? "Distances measured from " + esc(origin.label) + "."
      : "Choose a start point to sort by distance.");

    var sig = list.map(function (b) {
      return b.id + ":" + b.status + ":" + (b.code || "") + ":" + (b.handshakeAt || 0);
    }).join("|");
    if (sig === feedSig) return;
    feedSig = sig;

    feedEls = {};
    var grid = $("feedGrid");
    grid.innerHTML = "";
    if (!list.length) {
      grid.appendChild(emptyBlock(
        "No edible surplus inside its safe window",
        "Batches posted by canteens and messes appear here with a live countdown."));
      return;
    }
    list.forEach(function (b) { grid.appendChild(batchCard(b, feedEls)); });
  }

  function renderCompost() {
    var list = compostList();
    var waiting = list.filter(function (b) { return b.status === "available"; }).length;
    var rerouted = list.filter(function (b) { return b.reroutedAt && b.status !== "done"; }).length;
    setText("compostCount", waiting);
    setText("compostHint", waiting + " waiting · " + rerouted + " arrived via TTL re-route.");

    var sig = list.map(function (b) {
      return b.id + ":" + b.status + ":" + (b.code || "") + ":" + (b.compostedAt || 0);
    }).join("|");
    if (sig === compostSig) return;
    compostSig = sig;

    compostEls = {};
    var grid = $("compostGrid");
    grid.innerHTML = "";
    if (!list.length) {
      grid.appendChild(emptyBlock(
        "Compost board is clear",
        "Expired edible batches and raw kitchen scraps are routed here automatically."));
      return;
    }
    list.slice(0, 30).forEach(function (b) { grid.appendChild(batchCard(b, compostEls)); });
  }

  function emptyBlock(title, body) {
    var el = document.createElement("div");
    el.style.gridColumn = "1 / -1";
    el.className = "empty";
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c3.5 2.6 6 6 6 9.5A6 6 0 0 1 6 12.5C6 9 8.5 5.6 12 3z"/><path d="M12 4.5v15"/></svg>' +
      "<h3>" + esc(title) + "</h3><p>" + esc(body) + "</p>";
    return el;
  }

  function statusMarkup(b) {
    if (b.channel === "compost") {
      if (b.status === "available") {
        return '<span class="status rerouted"><span class="pulse-dot" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>' +
          (b.reroutedAt ? "Rerouted" : "Ready") + "</span>";
      }
      if (b.status === "claimed") return '<span class="status claimed">' + ICO_CHECK + "Collected</span>";
      if (b.status === "done") return '<span class="status done">' + ICO_LEAF + "Composted</span>";
      return '<span class="status cancelled">Cancelled</span>';
    }
    if (b.status === "available") return '<span class="status available"><span class="pulse-dot"></span>Available</span>';
    if (b.status === "claimed") return '<span class="status claimed">' + ICO_CHECK + (b.handshakeAt ? "Verified" : "Claimed") + "</span>";
    return '<span class="status cancelled">Cancelled</span>';
  }

  function batchCard(b, map) {
    var el = document.createElement("div");
    var earth = b.channel === "compost";
    el.className = "post-card glass" + (earth ? " earth" : "") +
      (b.status === "done" || b.status === "cancelled" ? " settled" : "");

    if (seenCards[b.id]) el.style.animation = "none";
    else { seenCards[b.id] = 1; el.style.animationDelay = (Math.floor(Math.random() * 3) * 40) + "ms"; }

    var html = "";
    html += '<div class="post-top"><div style="min-width:0"><div class="post-item"></div>';
    html += '<div class="post-meta-1"><span class="qty-chip' + (earth ? " earth" : "") + '" data-mass></span>';
    html += '<span class="dist-chip" data-dist hidden>' + ICO_PIN + "<span></span></span></div></div>";
    html += "<span data-status></span></div>";

    if (earth && b.reroutedAt) {
      html += '<div class="reroute-flag">' + ICO_ROUTE + "Safe window closed · " + esc(fmtClock(b.reroutedAt)) + "</div>";
    }
    if (b.code && !earth) {
      // The handshake code is deliberately never rendered on the board. It is
      // the shared secret between the claimant and the kitchen at the counter:
      // it is handed out once on the claim toast, and the verifying party has
      // to read it back. Printing it here would make the check meaningless.
      html += '<div class="code-chip note' + (b.status === "done" ? " done" : "") + '">' + ICO_SHIELD +
        (b.handshakeAt ? "Handover verified" : "Code issued to " + esc(b.claimedBy || "the claimant")) + "</div>";
    }

    html += '<div class="timer-bar"><div class="timer-top"><span class="timer-label" data-tlabel></span>' +
      '<span class="timer-num" data-cdown></span></div><div class="track"><div class="fill" data-fill></div></div></div>';

    html += '<div class="post-meta">';
    html += '<div class="meta-row">' + ICO_CLOCK + "<span data-when></span></div>";
    html += '<div class="meta-row">' + ICO_PIN + "<span><b data-loc></b></span></div>";
    if (earth) html += '<div class="meta-row">' + ICO_LEAF + "<span data-yieldrow></span></div>";
    html += "</div>";

    html += '<div class="post-foot"><span class="claimed-by" data-foot></span><span class="foot-btns" data-btns></span></div>';

    el.innerHTML = html;

    el.querySelector(".post-item").textContent = b.item;
    el.querySelector("[data-mass]").textContent = earth
      ? b.kg.toFixed(1).replace(/\.0$/, "") + " kg" + (b.reroutedAt ? " feedstock" : " organic")
      : b.qty + " meals · ~" + b.kg + " kg";
    el.querySelector("[data-status]").innerHTML = statusMarkup(b);
    el.querySelector("[data-loc]").textContent = locName(b.locId);

    if (earth) {
      el.querySelector("[data-when]").textContent = b.reroutedAt
        ? "Rerouted " + fmtClock(b.reroutedAt)
        : "Logged " + fmtClock(b.created);
      el.querySelector("[data-yieldrow]").textContent = b.status === "done"
        ? "Bio-fertilizer " + (b.yieldKg || b.kg * COMPOST_YIELD).toFixed(1) + " kg · " + (b.compostUnit || "compost unit")
        : "Awaiting a compost unit";
      el.querySelector("[data-tlabel]").textContent = b.status === "done" ? "compost finished" : "waiting for collection";
    } else {
      el.querySelector("[data-when]").textContent = "Prepared " + fmtClock(b.prepAt) + " · safe until " + fmtClock(b.safeUntil);
      el.querySelector("[data-tlabel]").textContent = "safe window closes in";
    }

    var dist = origin ? fmtDist(distanceMeters(origin, locOf(b.locId))) : null;
    var distEl = el.querySelector("[data-dist]");
    if (dist) { distEl.hidden = false; distEl.querySelector("span").textContent = dist + " away"; }

    el.querySelector("[data-foot]").innerHTML = footText(b);
    el.querySelector("[data-btns]").innerHTML = footButtons(b);

    map[b.id] = el;
    updateCardTimer(b, el, Date.now());
    return el;
  }

  function footText(b) {
    if (b.status === "claimed" && b.channel === "human") {
      return "<b>" + esc(b.claimedBy || "Volunteer / NGO") + "</b> · " + esc(fmtTime(b.claimedAt)) +
        (b.handshakeAt ? " · handover verified" : " · awaiting handover");
    }
    if (b.status === "claimed" && b.channel === "compost") {
      return '<b class="earth">' + esc(b.claimedBy || "Compost Unit") + "</b> · " + esc(fmtTime(b.claimedAt)) + " · awaiting compost";
    }
    if (b.status === "done") return "Finished · " + esc(b.kg) + " kg kept out of landfill";
    if (b.status === "available") {
      return b.channel === "human" ? "Claim before the window closes." : "A compost unit should collect this feedstock.";
    }
    return "";
  }

  function footButtons(b) {
    var id = esc(b.id);
    if (b.status === "available") {
      if (b.channel === "compost") {
        return '<button class="btn btn-earth btn-sm" data-collect="' + id + '">' + ICO_ARROW + "Collect</button>";
      }
      return '<button class="btn btn-primary btn-sm" data-claim="' + id + '">' + ICO_ARROW + "Claim pickup</button>";
    }
    if (b.status === "claimed" && b.channel === "compost") {
      return '<button class="btn btn-earth btn-sm" data-complete="' + id + '">' + ICO_LEAF + "Mark composted</button>" +
        '<button class="btn btn-ghost btn-sm" data-release="' + id + '">Undo</button>';
    }
    if (b.status === "claimed" && b.handshakeAt) {
      return '<span class="dist-chip">' + ICO_SHIELD + "verified</span>" +
        '<button class="btn btn-ghost btn-sm" data-release="' + id + '">Undo</button>';
    }
    if (b.status === "claimed") {
      return '<button class="btn btn-ghost btn-sm" data-verify="' + id + '">' + ICO_SHIELD + "Confirm handover</button>" +
        '<button class="btn btn-ghost btn-sm" data-release="' + id + '">Undo</button>';
    }
    return "";
  }

  function updateCardTimer(b, el, now) {
    var cdown = el.querySelector("[data-cdown]");
    if (!cdown) return;
    var fill = el.querySelector("[data-fill]");

    if (b.channel === "compost") {
      if (b.status === "done") {
        cdown.textContent = fmtTime(b.compostedAt);
        cdown.className = "timer-num earth";
        fill.style.width = "100%";
        fill.className = "fill earth";
      } else {
        cdown.textContent = compact(now - (b.reroutedAt || b.created));
        cdown.className = "timer-num earth";
        fill.style.width = "100%";
        fill.className = "fill earth";
      }
      return;
    }

    var e = eta(b, now);
    cdown.textContent = e.text;
    cdown.className = "timer-num " + e.cls;
    fill.style.width = e.pct + "%";
    fill.className = "fill " + e.cls;
    el.classList.toggle("low", e.minLeft > 0 && e.minLeft <= 15);
  }

  function tickClocks() {
    var now = Date.now();
    [feedEls, compostEls].forEach(function (map) {
      Object.keys(map).forEach(function (id) {
        var b = findBy(id), el = map[id];
        if (b && el && el.isConnected) updateCardTimer(b, el, now);
      });
    });
  }

  /* ----- impact ----- */
  function renderImpact() {
    var m = impact();
    var sig = [m.meals, m.kgRescued, m.claims, m.kgComposted, Math.round(m.yieldKg * 10), m.rerouted, m.kgWaiting].join("|");
    if (sig !== impactSig) { impactSig = sig; buildChart(); buildHistory(); }

    animateNum($("statDiverted"), m.diverted, 0);
    setText("statShare", m.logged > 0 ? m.share.toFixed(0) + "% of all logged surplus mass" : "Nothing logged yet");
    setText("statMeals", m.meals);
    setText("statPickups", m.claims);
    setText("statComposted", Math.round(m.kgComposted));
    animateNum($("statYield"), m.yieldKg, 1);
    animateNum($("statCo2"), m.co2, 0);
    setText("statCh4", m.ch4.toFixed(1) + " kg");
    setText("statProd", m.productionCo2.toFixed(0) + " kg");
    setText("co2Foot", "Methane that landfilled food waste would have released, converted at GWP " + GWP +
      ", plus meals that never had to be produced.");

    setText("t1Kg", Math.round(m.kgRescued));
    setText("t1Meals", m.meals);
    setText("t1Claims", m.claims);
    setText("t1Avg", m.avg.toFixed(1) + " kg");
    setText("t1Today", Math.round(m.t1Today) + " kg");
    setText("t1Rerouted", m.rerouted + (m.rerouted === 1 ? " batch" : " batches"));

    setText("t2Kg", Math.round(m.kgComposted));
    setText("t2Yield", m.yieldKg.toFixed(1) + " kg");
    setText("t2Batches", m.compostBatches);
    setText("t2Rerouted", m.reroutedDone);
    setText("t2Direct", m.directDone);
    setText("t2Waiting", Math.round(m.kgWaiting) + " kg");

    if (!$("assumptions").dataset.filled) {
      $("assumptions").dataset.filled = "1";
      $("assumptions").innerHTML = [
        ["1 meal", MEAL_KG + " kg of surplus food"],
        ["Avoided production", CO2_PER_MEAL + " kg CO&#8322;e per meal served"],
        ["Landfill methane", CH4_PER_KG + " kg CH&#8324; per kg of food waste"],
        ["GWP of CH&#8324;", GWP + " kg CO&#8322;e per kg CH&#8324;"],
        ["Compost yield", COMPOST_YIELD + " kg bio-fertilizer per kg feedstock"]
      ].map(function (r) { return "<div><b>" + r[0] + "</b> &mdash; " + r[1] + "</div>"; }).join("");
    }
  }

  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

  function animateNum(el, target, decimals) {
    var key = el.id;
    if (prevNums[key] === target) { el.textContent = target.toFixed(decimals); return; }
    prevNums[key] = target;
    var dur = 700, t0 = null;
    function step(ts) {
      if (!t0) t0 = ts;
      var k = clamp((ts - t0) / dur, 0, 1);
      el.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(decimals);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function buildChart() {
    var chart = $("chart");
    chart.innerHTML = "";
    var now = new Date();
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({ key: d.toDateString(), label: d.toLocaleDateString([], { weekday: "short" }), human: 0, compost: 0 });
    }
    function bucket(ts) {
      if (!ts) return null;
      var k = new Date(ts).toDateString();
      for (var j = 0; j < days.length; j++) if (days[j].key === k) return days[j];
      return null;
    }

    batches.forEach(function (b) {
      if (b.status === "done" && b.channel === "compost") {
        var c = bucket(b.compostedAt);
        if (c) c.compost += b.kg;
      } else if (b.status === "claimed" && b.channel === "human") {
        var h = bucket(b.claimedAt);
        if (h) h.human += b.kg;
      }
    });

    var max = 1;
    days.forEach(function (d) { max = Math.max(max, d.human + d.compost); });

    days.forEach(function (d) {
      var col = document.createElement("div");
      col.className = "chart-col" + (d.key === now.toDateString() ? " today" : "");
      var total = d.human + d.compost;
      var h = total > 0 ? clamp(total / max * 100, 4, 100) : 0;
      var hh = total > 0 ? (d.human / total) * h : 0;
      var hc = h - hh;
      col.innerHTML =
        '<div class="chart-stack" style="height:' + h.toFixed(1) + '%" data-tip="' + esc(d.label + " · " + total.toFixed(1) + " kg") + '">' +
        (hh > 0.5 ? '<div class="chart-bar human" style="height:' + hh.toFixed(1) + '%"></div>' : "") +
        (hc > 0.5 ? '<div class="chart-bar compost" style="height:' + hc.toFixed(1) + '%"></div>' : "") +
        "</div><span>" + esc(d.label) + "</span>";
      chart.appendChild(col);
    });
  }

  function buildHistory() {
    var list = $("historyList");
    list.innerHTML = "";
    var events = [];

    batches.forEach(function (b) {
      if (b.channel === "human" && b.status === "claimed") {
        events.push({
          t: b.claimedAt || b.created, earth: false, b: b, title: b.item,
          sub: (b.claimedBy || "Volunteer / NGO") + " · " + locName(b.locId) + " · " + (b.code || "")
        });
      } else if (b.channel === "compost" && b.status === "done") {
        events.push({
          t: b.compostedAt || b.created, earth: true, b: b, title: b.item,
          sub: (b.reroutedAt ? "Rerouted at " + fmtTime(b.reroutedAt) + " · " : "Raw organic · ") +
            locName(b.locId) + " · " + (b.compostUnit || "compost unit")
        });
      }
    });

    if (!events.length) {
      list.innerHTML = '<div class="empty" style="padding:26px 14px;border:none;background:transparent"><p>Nothing has moved through the loop yet.</p></div>';
      return;
    }

    events.sort(function (a, b) { return b.t - a.t; });
    events.slice(0, 9).forEach(function (ev, i) {
      var b = ev.b;
      var row = document.createElement("div");
      row.className = "h-row";
      row.style.animationDelay = (i * 40) + "ms";
      row.innerHTML =
        '<div class="h-left"><span class="h-ico' + (ev.earth ? " earth" : "") + '">' + (ev.earth ? ICO_LEAF : ICO_SHIELD) + "</span>" +
        '<div style="min-width:0"><div class="h-name"></div><div class="h-sub"></div></div></div>' +
        '<div class="h-kg"><b' + (ev.earth ? ' class="earth"' : "") + "></b><span></span></div>";
      row.querySelector(".h-name").textContent = ev.title;
      row.querySelector(".h-sub").textContent = ev.sub + " · " + fmtClock(ev.t);
      row.querySelector(".h-kg b").textContent = "+" + b.kg.toFixed(ev.earth ? 1 : 0) + " kg";
      row.querySelector(".h-kg span").textContent = ev.earth
        ? (b.yieldKg || b.kg * COMPOST_YIELD).toFixed(1) + " kg compost"
        : b.qty + " meals";
      list.appendChild(row);
    });
  }

  /* ---------- toast / tabs ---------- */
  var toastTimer = null;

  // A handshake code is only ever shown once, so that toast stays up until it
  // is dismissed rather than vanishing after three seconds.
  function showToast(msg, warn, sticky) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.toggle("warn", !!warn);
    t.classList.toggle("sticky", !!sticky);
    t.classList.add("show");
    clearTimeout(toastTimer);
    if (sticky) return;
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3000);
  }

  function dismissToast() {
    var t = $("toast");
    t.classList.remove("show");
    t.classList.remove("sticky");
    clearTimeout(toastTimer);
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "panel-" + name);
    });
    if (name === "impact") { impactSig = ""; renderImpact(); }
  }

  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });

  /* ---------- card actions ---------- */
  function handleAction(e) {
    var claim = e.target.closest("[data-claim]");
    var collect = e.target.closest("[data-collect]");
    var complete = e.target.closest("[data-complete]");
    var release = e.target.closest("[data-release]");
    var verify = e.target.closest("[data-verify]");

    if (claim) {
      var cid = claim.dataset.claim;
      var who = $("fWho").value.trim() || "Volunteer / NGO";
      op({ type: "claim", id: cid, by: who }, function () {
        var p = findBy(cid);
        if (!p || !p.code) { showToast("Pickup claimed", true); return; }
        // Sticky: this is the only time the code is ever shown anywhere.
        showToast("Handshake code " + p.code + "\nRead it out to the kitchen, then they confirm the handover.", true, true);
      });
      return;
    }

    if (collect) {
      var gid = collect.dataset.collect;
      var gby = $("cWho").value.trim() || "Compost Unit";
      op({ type: "claim", id: gid, by: gby }, function () {
        showToast("Feedstock claimed — mark it composted once the windrow is done", true);
      });
      return;
    }

    if (complete) {
      var pid = complete.dataset.complete;
      var pby = $("cWho").value.trim() || "Compost Unit";
      op({ type: "complete", id: pid, by: pby }, function () {
        var p = findBy(pid);
        showToast(p ? "Composted " + p.kg + " kg into " + p.yieldKg + " kg bio-fertilizer" : "Compost recorded");
      });
      return;
    }

    if (verify) {
      var vid = verify.dataset.verify;
      if (!findBy(vid)) return;
      // No prefill: the kitchen has to be told the code by the claimant.
      var entered = window.prompt(
        "Ask the claimant to read out their handshake code, then type it here to confirm the handover.",
        ""
      );
      if (entered === null) return;
      if (!entered.trim()) { showToast("No code entered — handover not confirmed", true); return; }
      op({ type: "handshake", id: vid, code: entered.trim().toUpperCase() }, function () { showToast("Handover verified"); });
      return;
    }

    if (release) {
      op({ type: "release", id: release.dataset.release }, function () { showToast("Claim released"); });
    }
  }

  $("feedGrid").addEventListener("click", handleAction);
  $("compostGrid").addEventListener("click", handleAction);
  $("toast").addEventListener("click", dismissToast);

  /* ---------- donor form ---------- */
  function setChannel(next) {
    channel = next;
    document.querySelectorAll(".seg-btn").forEach(function (b) {
      var on = b.dataset.channel === next;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });

    var human = next === "human";
    setText("lblItem", human ? "Food item" : "Material");
    setText("lblQty", human ? "Portions (meals)" : "Approximate mass (kg)");
    $("fQty").placeholder = human ? "e.g. 25" : "e.g. 12";
    $("fQty").min = human ? "1" : "0.1";
    $("fQty").step = human ? "1" : "0.1";
    $("windowField").style.display = human ? "" : "none";
    $("btnSubmit").className = "btn " + (human ? "btn-primary" : "btn-earth");
    setText("btnSubmitText", human ? "Post to Live Feed" : "Route to Compost Board");
    updateWindowNote();
    updateFormState();
  }

  function updateWindowNote() {
    var note = $("windowNote");
    if (channel !== "human") {
      note.className = "window-note warm";
      setText("windowNoteText", "Organic scraps carry no human-consumption deadline — they are routed straight to the compost board.");
      return;
    }
    var prep = tsFromTimeInput($("fPrep").value);
    if (prep === null) {
      note.className = "window-note";
      setText("windowNoteText", "Set a preparation time to compute the safe-consumption deadline.");
      return;
    }
    var until = prep + parseInt($("fWindow").value, 10) * 60000;
    var left = until - Date.now();
    if (left <= 0) {
      note.className = "window-note warm";
      setText("windowNoteText", "Safe window already closed — this batch will route straight to the compost board.");
      return;
    }
    note.className = "window-note";
    setText("windowNoteText", "Safe until " + fmtClock(until) + " — " + compact(left) + " from now. After that it auto-routes to compost.");
  }

  function checksComplete() {
    var boxes = document.querySelectorAll("[data-check]");
    for (var i = 0; i < boxes.length; i++) if (!boxes[i].checked) return false;
    return true;
  }

  function updateFormState() {
    $("btnSubmit").disabled = !(checksComplete() && $("fLoc").value);
  }

  document.querySelectorAll(".seg-btn").forEach(function (b) {
    b.addEventListener("click", function () { setChannel(b.dataset.channel); });
  });

  document.querySelectorAll("[data-check]").forEach(function (c) {
    c.addEventListener("change", function () {
      c.parentNode.classList.toggle("on", c.checked);
      updateFormState();
    });
  });

  ["fPrep", "fWindow"].forEach(function (id) {
    $(id).addEventListener("input", updateWindowNote);
    $(id).addEventListener("change", updateWindowNote);
  });
  $("fLoc").addEventListener("change", updateFormState);

  $("donorForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!checksComplete()) { showToast("Confirm the hygiene and storage checklist first", true); return; }

    var human = channel === "human";
    var item = $("fItem").value.trim();
    var amount = parseFloat($("fQty").value);
    var prep = tsFromTimeInput($("fPrep").value);
    var locId = $("fLoc").value;

    if (!item) { showToast(human ? "Name the food item" : "Name the material", true); return; }
    if (!isFinite(amount) || amount <= 0) { showToast(human ? "Enter the number of meals" : "Enter the approximate mass in kg", true); return; }
    if (amount > 9999) { showToast("Keep the quantity under 9999", true); return; }
    if (!locId) { showToast("Choose a pickup point", true); return; }
    if (human && prep === null) { showToast("Set the preparation time", true); return; }

    var win = human ? parseInt($("fWindow").value, 10) : 120;
    var batch = {
      id: uid(),
      channel: human ? "human" : "compost",
      status: "available",
      item: item,
      qty: human ? Math.round(amount) : 0,
      kg: human ? Math.round(amount * MEAL_KG * 10) / 10 : Math.round(amount * 10) / 10,
      prepAt: human ? prep : Date.now(),
      windowMin: win,
      locId: locId,
      code: null,
      claimedAt: null,
      claimedBy: null,
      handshakeAt: null,
      reroutedAt: null,
      compostedAt: null,
      compostUnit: null,
      yieldKg: null,
      created: Date.now()
    };

    var expiredOnArrival = human && batch.prepAt + win * 60000 <= Date.now();

    op({ type: "post", batch: batch }, function () {
      if (human) {
        showToast(expiredOnArrival
          ? "Posted — safe window already closed, so it routed to compost"
          : "Posted " + item + " — live on the feed now");
        switchTab("feed");
      } else {
        showToast("Routed " + item + " to the compost board");
        switchTab("compost");
      }
    });

    this.reset();
    document.querySelectorAll("[data-check]").forEach(function (c) {
      c.checked = false;
      c.parentNode.classList.remove("on");
    });
    $("fPrep").value = clockNow();
    updateWindowNote();
    updateFormState();
  });

  /* ---------- toolbars ---------- */
  function invalidate() { feedSig = ""; compostSig = ""; }

  $("fSort").addEventListener("change", function () { feedSort = this.value; invalidate(); renderFeed(); });
  $("cSort").addEventListener("change", function () { compostSort = this.value; invalidate(); renderCompost(); });

  $("fOrigin").addEventListener("change", function () {
    var self = this;
    if (self.value === "me") {
      if (!navigator.geolocation) { showToast("This device cannot report a location", true); self.value = ""; return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "your location" };
        invalidate();
        renderFeed();
        renderCompost();
        showToast("Sorted by distance from your location");
      }, function () {
        showToast("Location unavailable — pick a campus point instead", true);
        self.value = "";
      }, { timeout: 8000, maximumAge: 300000 });
      return;
    }
    var l = locOf(self.value);
    origin = l ? { lat: l.lat, lng: l.lng, label: l.name } : null;
    invalidate();
    renderFeed();
    renderCompost();
  });

  /* ---------- sample data / reset ---------- */
  function demoBatches() {
    var now = Date.now(), H = 3600e3, D = 24 * H;
    var out = [];

    function mk(item, opts) {
      var prepAt = opts.prepAgo ? now - opts.prepAgo : now;
      var b = {
        id: uid(),
        channel: opts.channel,
        status: opts.status,
        item: item,
        qty: opts.qty || 0,
        kg: opts.kg,
        prepAt: prepAt,
        windowMin: opts.win || 240,
        locId: opts.loc,
        code: opts.status === "claimed" || opts.status === "done" ? "#" + uid().toUpperCase().slice(-3) + "-" + (100 + Math.floor(Math.random() * 900)) : null,
        claimedAt: opts.claimedAgo ? now - opts.claimedAgo : null,
        claimedBy: opts.status === "claimed" || opts.status === "done" ? (opts.by || "Volunteer / NGO") : null,
        handshakeAt: opts.verify ? now - (opts.claimedAgo - 6 * 60e3) : null,
        reroutedAt: opts.reroutedAgo ? now - opts.reroutedAgo : null,
        compostedAt: opts.compostedAgo ? now - opts.compostedAgo : null,
        compostUnit: opts.status === "done" ? (opts.unit || "Campus Compost Pit") : null,
        yieldKg: null,
        created: opts.createdAgo ? now - opts.createdAgo : now
      };
      b.safeUntil = b.prepAt + b.windowMin * 60000;
      if (b.status === "done") b.yieldKg = Math.round(b.kg * COMPOST_YIELD * 10) / 10;
      return b;
    }

    out.push(mk("Rice & Dal", { channel: "human", status: "available", qty: 25, kg: 25, prepAgo: 40 * 60e3, win: 240, loc: "canteen-a", createdAgo: 40 * 60e3 }));
    out.push(mk("Mixed Veg & Roti", { channel: "human", status: "available", qty: 12, kg: 12, prepAgo: 3.2 * H, win: 120, loc: "mess-h2", createdAgo: 3.2 * H }));
    out.push(mk("Sambar Rice", { channel: "human", status: "claimed", qty: 40, kg: 40, prepAgo: 1.5 * H, win: 240, loc: "mess-h1", claimedAgo: 50 * 60e3, verify: true, by: "Siddhivinayak Orphanage Hub", createdAgo: 2 * H }));
    out.push(mk("Chapati & Aloo", { channel: "human", status: "available", qty: 10, kg: 10, prepAgo: 3.4 * H, win: 60, loc: "dept-coffee", createdAgo: 3.4 * H }));
    out.push(mk("Leftover Curry & Rice", { channel: "human", status: "available", qty: 18, kg: 18, prepAgo: 5.5 * H, win: 120, loc: "banquet", createdAgo: 5.5 * H }));
    out.push(mk("Veg Pulao", { channel: "human", status: "claimed", qty: 22, kg: 22, prepAgo: 5 * H, win: 240, loc: "canteen-b", claimedAgo: 26 * H, verify: true, by: "Karuna Shelter", createdAgo: 5 * H }));
    out.push(mk("Dal & Bhakri", { channel: "human", status: "claimed", qty: 15, kg: 15, prepAgo: 26 * H, win: 240, loc: "mess-h3", claimedAgo: 49 * H, by: "Annapurna Seva Kitchen", createdAgo: 26 * H }));
    out.push(mk("Idli & Sambar", { channel: "human", status: "claimed", qty: 30, kg: 30, prepAgo: 3 * D, win: 240, loc: "canteen-a", claimedAgo: 3 * D - H, by: "Student Volunteer Hub", createdAgo: 3 * D }));

    out.push(mk("Curry & Rice", { channel: "compost", status: "done", kg: 35, loc: "mess-h1", win: 240, prepAgo: 2 * D, reroutedAgo: 2 * D - H, claimedAgo: 2 * D - 2 * H, compostedAgo: 1.5 * D, unit: "Campus Compost Pit", createdAgo: 2 * D, by: "Campus Compost Pit" }));
    out.push(mk("Vegetable Peels & Scraps", { channel: "compost", status: "done", kg: 18, loc: "agri-kitchen", prepAgo: D, claimedAgo: 20 * H, compostedAgo: 4 * H, unit: "Agri Cluster Windrow", createdAgo: 22 * H, by: "Agri Cluster Windrow" }));
    out.push(mk("Spoiled Biryani", { channel: "compost", status: "available", kg: 14, loc: "banquet", win: 120, prepAgo: 4.5 * H, reroutedAgo: 10 * 60e3, createdAgo: 4.5 * H }));
    out.push(mk("Rice Wash & Veg Scraps", { channel: "compost", status: "available", kg: 9, loc: "mess-h2", prepAgo: 70 * 60e3, createdAgo: 70 * 60e3 }));
    out.push(mk("Coffee Grounds & Filters", { channel: "compost", status: "available", kg: 6, loc: "dept-coffee", prepAgo: 5 * H, createdAgo: 5 * H }));
    out.push(mk("Curry Leaves & Trim", { channel: "compost", status: "claimed", kg: 11, loc: "canteen-b", prepAgo: 6 * H, claimedAgo: 2 * H, createdAgo: 6 * H, by: "Community Garden Composter" }));

    return out;
  }

  $("btnDemo").addEventListener("click", function () {
    adminOp({ type: "demo", batches: demoBatches() }, function () {
      showToast("Sample data loaded across both tiers");
      switchTab("feed");
    });
  });

  $("btnClear").addEventListener("click", function () {
    if (!batches.length) return;
    if (!window.confirm("Reset every batch and zero the impact counter?")) return;
    adminOp({ type: "clear" }, function () { showToast("All batches cleared"); });
  });

  /* ---------- clock + shared polling ---------- */
  var ticks = 0;
  setInterval(function () {
    $("liveClock").textContent = new Date().toLocaleTimeString([], {
      hour: "numeric", minute: "2-digit", second: "2-digit"
    });
    tickClocks();
    ticks++;
    if (!serverMode || ticks % 2) return;
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { adopt(d.posts || []); renderAll(); } })
      .catch(function () { serverMode = false; setStatus("off"); });
  }, 1000);

  window.addEventListener("storage", function (e) {
    if (serverMode || e.key !== KEY) return;
    batches = loadLocal();
    invalidate();
    renderAll();
  });

  /* ---------- init ---------- */
  try { adminToken = localStorage.getItem(ADMIN_KEY) || ""; } catch (e) { adminToken = ""; }
  $("fPrep").value = clockNow();
  setChannel("human");
  updateWindowNote();
  boot();
  $("liveClock").textContent = new Date().toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit", second: "2-digit"
  });
})();
