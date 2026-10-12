"use strict";

/* =========================================================================
 * Noch Zeit? · Münster
 * ========================================================================= */

/* ---------- Configuration ----------
 * SECURITY: Never put a *secret* API key in this file. Everything here is public.
 *  - apiBase: if the BusRadar provider ever requires a secret key, point this at your own
 *    proxy (see worker/busradar-proxy.js) which keeps the key server-side.
 *  - tiles: if you switch to a tile provider that needs a key, use a *public* browser key that
 *    is restricted to your domain (HTTP referrer) in the provider's dashboard.
 */
const CONFIG = {
  apiBase: "https://rest.busradar.conterra.de/prod",
  tiles: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  },
  center: [51.9607, 7.6261],
  cityCenter: [7.6265, 51.9624], // [lon, lat] reference point for "stadteinwärts / stadtauswärts" (Prinzipalmarkt/Dom)
  minMoveKm: 0.015,    // geometry fallback: ignore differences below 15 m
  stopZoom: 14,        // stop markers appear from this zoom level
  refreshMs: 20000
};

/* ---------- Small helpers ---------- */
const $ = s => document.querySelector(s);

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable (private mode) */ } }
};

const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const name = v => String(v || "").replace(/str\.$/, "straße");
const when = v => Number(v.tatsaechliche_abfahrtszeit || v.abfahrtszeit || 0);
const mins = v => Math.max(0, Math.ceil((v - Date.now() / 1000) / 60));
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const time = v => timeFmt.format(new Date(v * 1000));
const norm = v => String(v || "").toLocaleLowerCase("de-DE").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

// Line colours: every colour has at least 4.5:1 contrast with the white text on the badge.
const PALETTE = ["#d6204f", "#0b6e99", "#b45309", "#067a5d", "#5a46c2", "#b83f82", "#1f63c4", "#7a5d22"];
function color(v) {
  let h = 0;
  for (const c of String(v || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ---------- Direction: inbound (towards the city centre) vs. outbound ----------
 * Facts from the BusRadar API (verified):
 *  - stop platforms carry `richtung` = "einwärts" | "auswärts" (or mixed values / nothing, e.g. at the main station)
 *  - vehicles carry the current stop (akthst), the next stop (nachhst) and the destination (zielhst) as platform codes (kbez)
 *  - `richtungsid` (1/2) is NOT usable: it is per line and does not mean in/out.
 * Rule: a bus counts as inbound/outbound according to the platform label of its next stop.
 * If that label is missing, we compare the distance to the city centre of the bus and of its next stop. */
const DIR_LABEL = { in: "stadteinwärts", out: "stadtauswärts" };
const DIR_ICON = {
  in: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="19" cy="12" r="2.5"/><path d="M3 12h10m-4-4 4 4-4 4"/></svg>',
  out: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2.5"/><path d="M11 12h10m-4-4 4 4-4 4"/></svg>'
};
const dirFromLabel = v => {
  const s = String(v || "").trim().toLocaleLowerCase("de-DE");
  return s === "einwärts" ? "in" : s === "auswärts" ? "out" : null;
};
function dirFromGeometry(from, to) {
  const a = km(from, CONFIG.cityCenter), b = km(to, CONFIG.cityCenter);
  return Math.abs(a - b) < CONFIG.minMoveKm ? null : (b < a ? "in" : "out");
}
/* Compass bearing in degrees (0 = north, clockwise) from -> to, both [lon, lat]. */
function bearing(from, to) {
  const r = Math.PI / 180;
  return (Math.atan2((to[0] - from[0]) * Math.cos(from[1] * r), to[1] - from[1]) / r + 360) % 360;
}
function vehicleInfo(f) {
  const p = f.properties || {}, pos = f.geometry?.coordinates;
  const next = state.platforms.get(p.nachhst);
  const target = (next || state.platforms.get(p.zielhst))?.coord;
  const geo = pos && target ? dirFromGeometry(pos, target) : null;
  const op = next ? next.dir : null;
  return {
    dir: op || geo,
    source: op ? "api" : geo ? "estimate" : "unknown",
    conflict: Boolean(op && geo && op !== geo),
    op, geo,
    bearing: pos && target ? bearing(pos, target) : null
  };
}

function directionDescription(info) {
  if (!info?.dir) return "Richtung unklar";
  const source = info.source === "estimate" ? "geschätzt" : "laut Haltestellendaten";
  return DIR_LABEL[info.dir] + " · " + source + (info.conflict ? " · Kartenbewegung weicht ab" : "");
}

function directionPill(dir, source = "api", conflict = false) {
  if (!dir) return '<span class="dir dir-unknown"><span aria-hidden="true">?</span>Richtung unklar</span>';
  const estimated = source === "estimate";
  const label = estimated ? "geschätzt" : "Haltestelle";
  return '<span class="dir dir-' + dir + (estimated ? " dir-estimated" : "") + (conflict ? " dir-conflict" : "") + '"' +
    ' title="' + esc(directionDescription({ dir, source, conflict })) + '">' + DIR_ICON[dir] + DIR_LABEL[dir] +
    '<span class="dir-source">' + label + '</span>' + (conflict ? '<span class="dir-conflict-mark" aria-label="Kartenbewegung weicht ab">!</span>' : "") + '</span>';
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scrollToEl = el => el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });

/* Short messages for screen readers (polite live region). */
function announce(message) {
  const el = $("#status");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = message; }, 60);
}

/* ---------- State ---------- */
const state = {
  stops: [],
  selected: storage.get("nz-selected-stop") || "Hauptbahnhof",
  departures: [],
  departuresFor: null,
  depHtml: "",
  vehicles: [],
  matches: [],
  trip: null,
  line: null,
  lineFilter: "",
  dir: "all",              // direction filter: "all" | "in" | "out"
  platforms: new Map(),    // kbez -> { coord: [lon, lat], dir: "in" | "out" | null }
  dirChecked: false,
  fitted: false,
  lastUpdate: null
};
let map, markers, stopMarkers, routeLayer, userMarker, directionMarker;
const stopMarkerIndex = new Map();
let depToken = 0, depBusy = false, tripToken = 0, vehBusy = false, refreshTimer = null;

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(status, path) { super("HTTP " + status); this.status = status; this.path = path; }
}

async function api(path) {
  let response;
  try {
    response = await fetch(CONFIG.apiBase + path, { cache: "no-store" });
  } catch {
    throw new ApiError(0, path);
  }
  if (!response.ok) {
    console.warn("[Noch Zeit?] API-Anfrage fehlgeschlagen:", response.status, path);
    throw new ApiError(response.status, path);
  }
  return response.json();
}

/* Turns an error into a user-facing sentence. */
function explain(err, fallback) {
  if (!navigator.onLine) return "Du bist offline. Sobald wieder Netz da ist, geht es weiter.";
  if (err && (err.status === 401 || err.status === 403)) {
    return "Der Datendienst lehnt die Anfrage ab (HTTP " + err.status + "). Möglicherweise ist ein Zugangsschlüssel nötig.";
  }
  return fallback;
}

/* ---------- Data shaping ---------- */
function group(features) {
  const m = new Map();
  features.forEach(f => {
    const p = f.properties || {}, n = p.lbez;
    if (!n || !p.nr) return;
    if (!m.has(n)) m.set(n, { name: n, stops: [], coordinates: [] });
    const g = m.get(n);
    g.stops.push(p);
    if (f.geometry?.coordinates) g.coordinates.push(f.geometry.coordinates);
  });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
}
const current = () => state.stops.find(s => s.name === state.selected);

/* ---------- Map ---------- */
function initMap() {
  map = L.map("map", { zoomControl: false }).setView(CONFIG.center, 12);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const tiles = L.tileLayer(CONFIG.tiles.url, { maxZoom: CONFIG.tiles.maxZoom, attribution: CONFIG.tiles.attribution }).addTo(map);
  let failed = 0;
  tiles.on("loading", () => { failed = 0; });
  tiles.on("tileerror", () => {
    failed++;
    if (failed === 2) {
      console.warn("[Noch Zeit?] Kartenkacheln werden nicht geladen. Prüfe im Netzwerk-Tab (F12), welcher Dienst die Anfrage ablehnt (z. B. 401/403 oder \"API key required\").");
    }
    if (failed >= 2) $("#tileNotice").hidden = false;
  });
  tiles.on("load", () => { if (!failed) $("#tileNotice").hidden = true; });

  stopMarkers = L.layerGroup();
  markers = L.layerGroup().addTo(map);
  map.on("zoomend", updateStopVisibility);
  updateStopVisibility();
  setTimeout(() => map.invalidateSize(), 150);
}

function stopCenter(g) {
  const c = g.coordinates || [];
  return c.length ? [c.reduce((n, p) => n + p[1], 0) / c.length, c.reduce((n, p) => n + p[0], 0) / c.length] : null;
}

function updateStopVisibility() {
  const close = map.getZoom() >= CONFIG.stopZoom;
  if (close) { if (!map.hasLayer(stopMarkers)) stopMarkers.addTo(map); }
  else if (map.hasLayer(stopMarkers)) map.removeLayer(stopMarkers);
  updateZoomHint();
}

function updateZoomHint() {
  const far = map && map.getZoom() < CONFIG.stopZoom && !state.trip && state.stops.length > 0;
  $("#zoomHint").hidden = !far;
}

function markStop(selectedName) {
  stopMarkerIndex.forEach((marker, key) => marker.setStyle(key === selectedName
    ? { radius: 7, color: "#fff", weight: 3, fillColor: "#6753c7", fillOpacity: 1 }
    : { radius: 4, color: "#fff", weight: 2, fillColor: "#403a44", fillOpacity: .83 }));
}

function renderStopsOnMap() {
  stopMarkers.clearLayers();
  stopMarkerIndex.clear();
  state.stops.forEach(g => {
    const point = stopCenter(g);
    if (!point) return;
    const marker = L.circleMarker(point, { radius: 4, color: "#fff", weight: 2, fillColor: "#403a44", fillOpacity: .83 }).addTo(stopMarkers);
    stopMarkerIndex.set(g.name, marker);
    marker.bindTooltip(name(g.name), { direction: "top", offset: [0, -5] });
    marker.on("click", () => {
      select(g.name);
      map.setView(point, Math.max(map.getZoom(), CONFIG.stopZoom + 1));
      scrollToEl($("#stopName"));
    });
  });
  markStop(state.selected);
}

/* ---------- Stops ---------- */
async function loadStops() {
  try {
    const data = await api("/haltestellen");
    state.platforms = new Map();
    (data.features || []).forEach(f => {
      const p = f.properties || {}, c = f.geometry?.coordinates;
      if (p.kbez && c) state.platforms.set(p.kbez, { coord: c, dir: dirFromLabel(p.richtung) });
    });
    state.stops = group(data.features || []);
    if (!state.stops.length) throw new Error("no stops");
    if (!current()) state.selected = state.stops[0].name;
    renderStopsOnMap();
    updateZoomHint();
    renderVehicles(); // bus directions need the platform data, so draw the buses again now
    select(state.selected, { save: false });
  } catch (err) {
    fail(explain(err, "Die Haltestellen konnten gerade nicht geladen werden."));
  }
}

function select(stopName, { save = true, pan = false } = {}) {
  const g = state.stops.find(x => x.name === stopName);
  if (!g) return;
  state.selected = stopName;
  markStop(stopName);
  if (save) storage.set("nz-selected-stop", stopName);
  $("#search").value = "";
  closeSearch();
  if (pan) {
    const point = stopCenter(g);
    if (point) map.setView(point, Math.max(map.getZoom(), CONFIG.stopZoom + 1));
  }
  loadDepartures({ reset: true });
}

/* ---------- Departures ---------- */
function setDepartures(html) {
  if (state.depHtml === html) return;
  const box = $("#departures");
  // Keep keyboard focus on the same departure when the list is re-rendered.
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.trip : null;
  box.innerHTML = html;
  state.depHtml = html;
  if (focused) [...box.querySelectorAll("[data-trip]")].find(b => b.dataset.trip === focused)?.focus({ preventScroll: true });
}

function fail(text) {
  setDepartures('<div class="message">' + esc(text) + '<br><button type="button" class="retry" data-retry>Erneut versuchen</button></div>');
  $("#departures").removeAttribute("aria-busy");
  $("#stopMeta").textContent = "nicht verfügbar";
  announce(text);
}

async function loadDepartures({ reset = false } = {}) {
  const g = current();
  if (!g) return;
  if (depBusy && !reset) return;
  const box = $("#departures");
  $("#stopName").textContent = name(g.name);

  if (reset || state.departuresFor !== g.name) {
    state.departures = [];
    state.departuresFor = g.name;
    $("#stopMeta").textContent = "Live-Abfahrten";
    box.setAttribute("aria-busy", "true");
    setDepartures('<div class="message">Live-Abfahrten werden geladen …</div>');
  }

  const token = ++depToken;
  depBusy = true;
  try {
    // Each platform has its own request, so every departure inherits that platform's direction label.
    const results = await Promise.allSettled(g.stops.map(s =>
      api("/haltestellen/" + encodeURIComponent(s.nr) + "/abfahrten?sekunden=7200").then(list => {
        const dir = dirFromLabel(s.richtung);
        return Array.isArray(list) ? list.map(d => ({ ...d, dir, dirSource: dir ? "api" : "unknown" })) : [];
      })));
    if (token !== depToken) return; // a newer request has taken over
    const fulfilled = results.filter(r => r.status === "fulfilled");
    if (!fulfilled.length) throw results[0].reason;

    const seen = new Set();
    state.departures = fulfilled
      .flatMap(r => Array.isArray(r.value) ? r.value : [])
      .filter(d => {
        const k = [d.fahrtbezeichner, d.sequenz, d.haltid].join("-");
        if (seen.has(k) || String(d.einsteigeverbot) === "true") return false;
        seen.add(k);
        return when(d) > Date.now() / 1000 - 30;
      })
      .sort((a, b) => when(a) - when(b))
      .slice(0, 8);

    $("#stopMeta").textContent = "Live-Abfahrten";
    box.removeAttribute("aria-busy");
    renderDepartures();
    stamp();
    if (reset) announce(state.departures.length + " Abfahrten für " + name(g.name));
  } catch (err) {
    if (token !== depToken) return;
    if (state.departures.length) {
      // Keep the last known data visible instead of replacing it with an error.
      $("#updated").textContent = "Aktualisierung fehlgeschlagen" + (state.lastUpdate ? " · letzter Stand " + timeFmt.format(state.lastUpdate) : "");
    } else {
      fail(explain(err, "Die Live-Abfahrten konnten gerade nicht geladen werden."));
    }
  } finally {
    if (token === depToken) depBusy = false;
  }
}

function renderDepartures() {
  const filter = state.lineFilter.trim().toLocaleLowerCase("de-DE");
  const byLine = state.departures.filter(d => !filter || String(d.linientext || "").toLocaleLowerCase("de-DE") === filter);
  const items = state.dir === "all" ? byLine : byLine.filter(d => d.dir === state.dir || !d.dir);
  const unknown = byLine.filter(d => !d.dir).length;
  const hidden = byLine.length - items.length - unknown;
  const note = $("#dirNote");
  note.hidden = !(state.dir !== "all" && (hidden > 0 || unknown > 0));
  if (!note.hidden) {
    const hiddenText = hidden ? hidden + (hidden === 1 ? " Abfahrt" : " Abfahrten") + " in Gegenrichtung ausgeblendet" : "";
    const unknownText = unknown ? unknown + (unknown === 1 ? " Abfahrt mit" : " Abfahrten mit") + " unklarer Richtung weiterhin angezeigt" : "";
    note.textContent = [hiddenText, unknownText].filter(Boolean).join(" · ") + ".";
  }

  if (!items.length) {
    const text = filter ? "Für diese Linie ist gerade keine Abfahrt gemeldet."
      : state.dir !== "all" ? "In den nächsten zwei Stunden ist keine Abfahrt " + DIR_LABEL[state.dir] + " gemeldet."
      : "In den nächsten zwei Stunden ist keine Abfahrt gemeldet.";
    setDepartures('<div class="message">' + text + "</div>");
    return;
  }
  setDepartures(items.map(d => {
    const delay = Math.round(Number(d.delay || 0) / 60);
    const meta = delay > 0 ? "+" + delay + " Min. später" : delay < 0 ? Math.abs(delay) + " Min. früher" : "pünktlich";
    const pill = directionPill(d.dir, d.dirSource);
    return '<button type="button" class="departure" data-trip="' + esc(d.fahrtbezeichner) + '">' +
      '<span class="line" style="background:' + color(d.linientext) + '"><span class="sr-only">Linie </span>' + esc(d.linientext) + "</span>" +
      '<span class="dep-main"><span class="destination">' + esc(d.richtungstext || "Richtung unbekannt") + "</span>" +
      '<span class="meta' + (delay > 0 ? " delay" : "") + '">' + meta + "</span>" + pill + "</span>" +
      '<span class="time"><span class="minutes">' + mins(when(d)) + ' min</span><span class="clock">' + time(when(d)) + "</span></span></button>";
  }).join(""));
}

function stamp() {
  state.lastUpdate = new Date();
  $("#updated").textContent = "Stand " + timeFmt.format(state.lastUpdate) + " · aktualisiert alle " + (CONFIG.refreshMs / 1000) + " Sekunden";
}

/* ---------- Vehicles ---------- */
async function loadVehicles() {
  if (vehBusy) return;
  vehBusy = true;
  try {
    const data = await api("/fahrzeuge");
    state.vehicles = data.features || [];
    renderVehicles();
  } catch (err) {
    $("#note").textContent = explain(err, "Die Buspositionen sind gerade nicht verfügbar.");
  } finally {
    vehBusy = false;
  }
}

function renderVehicles() {
  if (!markers) return;
  markers.clearLayers();
  const bounds = [];
  state.vehicles.forEach(f => { f.nz = vehicleInfo(f); });
  logDirectionCheck();

  let list = state.vehicles.filter(f => !state.line || String(f.properties?.linientext) === String(state.line));
  // The direction filter applies to the overview only; while a line is selected both directions stay visible.
  if (!state.line && state.dir !== "all") list = list.filter(f => f.nz.dir === state.dir || !f.nz.dir);

  list.forEach(f => {
    const c = f.geometry?.coordinates, p = f.properties || {}, info = f.nz;
    if (!c) return;
    const point = [c[1], c[0]];
    const selected = state.trip === p.fahrtbezeichner;
    // The ring colour shows the centre direction; its outline shows how that value was obtained.
    const badgeClass = "bus-arrow" + (info.dir ? " " + info.dir : " unknown") +
      (info.source === "estimate" ? " estimated" : "") + (info.conflict ? " conflict" : "");
    const badge = info.dir && info.bearing !== null
      ? '<span class="' + badgeClass + '" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24" focusable="false" style="transform:rotate(' + Math.round(info.bearing) + 'deg)"><path d="M12 19V5M6 11l6-6 6 6"/></svg>' + (info.conflict ? '<b class="bus-conflict-mark">!</b>' : "") + '</span>'
      : '<span class="' + badgeClass + '" aria-hidden="true">?</span>';
    const icon = L.divIcon({
      className: "",
      html: '<div class="bus' + (selected ? " selected" : "") + '" style="background:' + color(p.linientext) + '">' + esc(p.linientext || "Bus") + badge + "</div>",
      iconSize: [34, 30],
      iconAnchor: [17, 15]
    });
    // keyboard:false – ~100 buses would otherwise become ~100 tab stops; the list offers the same actions.
    const m = L.marker(point, { icon, keyboard: false }).addTo(markers);
    m.bindTooltip("Linie " + esc(p.linientext || "") + " · " + esc(p.richtungstext || "") + " · " + esc(directionDescription(info)), { direction: "top", offset: [0, -12] });
    m.on("click", () => showTrip({ fahrtbezeichner: p.fahrtbezeichner, fahrzeugid: p.fahrzeugid, linientext: p.linientext, richtungstext: p.richtungstext, dir: info.dir, dirSource: info.source, dirConflict: info.conflict }));
    bounds.push(point);
  });

  if (!state.line) {
    // Fit the map to all buses only once, so the map no longer jumps back every refresh.
    if (bounds.length && !state.fitted) { map.fitBounds(bounds, { padding: [15, 15], maxZoom: 13 }); state.fitted = true; }
    const n = state.vehicles.length, bus = k => (k === 1 ? "1 Bus" : k + " Busse");
    if (state.dir === "all") $("#note").textContent = bus(n) + " live · Bus oder Haltestelle antippen.";
    else {
      const unknown = state.vehicles.filter(f => !f.nz.dir).length;
      $("#note").textContent = bus(list.length) + " angezeigt · " + DIR_LABEL[state.dir] + " und " + unknown + " mit unklarer Richtung.";
    }
  }
}

/* One-time self-check in the browser console: do the operator's platform labels and the
 * city-centre geometry agree? A high agreement confirms that "einwärts" really means "towards the centre". */
function logDirectionCheck() {
  if (!state.platforms.size || !state.vehicles.length) return;
  const both = state.vehicles.filter(f => f.nz.op && f.nz.geo);
  const agree = both.filter(f => f.nz.op === f.nz.geo).length;
  const disagree = both.length - agree;
  const unknown = state.vehicles.filter(f => !f.nz.dir).length;
  const quality = $("#directionQuality");
  quality.hidden = false;
  quality.textContent = "Live-Vergleich: Haltestellenlabel und Bewegung Richtung Zentrum stimmen bei " + agree + " von " + both.length + " Bussen überein" +
    (disagree ? "; bei " + disagree + " weichen sie ab" : "") +
    (unknown ? ". " + unknown + " Busse ohne klare Richtung." : ".") +
    " Die Kartenbewegung ist bei Quer- und Ringlinien kein sicherer Beleg.";
  if (!state.dirChecked) {
    state.dirChecked = true;
    console.info("[Noch Zeit?] Richtungs-Check: Betreiberangabe und Geometrie stimmen bei " + agree + " von " + both.length + " Bussen überein; " + disagree + " Abweichungen; " + unknown + " ohne Richtungsangabe.");
  }
}

function vehicle(item) {
  return state.vehicles.find(f => f.properties?.fahrtbezeichner === item.fahrtbezeichner) ||
    state.vehicles.find(f => String(f.properties?.fahrzeugid) === String(item.fahrzeugid));
}

/* ---------- Trip / route ---------- */
async function showTrip(item, { scroll = false } = {}) {
  if (!item?.fahrtbezeichner) return;
  const token = ++tripToken;
  state.trip = item.fahrtbezeichner;
  state.line = item.linientext || null;
  const known = vehicle(item);
  const info = known ? vehicleInfo(known) : { dir: item.dir, source: item.dirSource || "unknown", conflict: item.dirConflict || false };
  $("#mapTitle").textContent = "Linie " + (item.linientext || "");
  $("#mapSubtitle").textContent = "Richtung " + (item.richtungstext || "unbekannt") + " · " + directionDescription(info);
  $("#note").textContent = "Fahrtweg wird geladen …";
  $("#reset").hidden = false;
  updateZoomHint();
  renderVehicles();
  const route = $("#route");
  route.hidden = false;
  route.innerHTML = '<h2 class="route-title">Fahrtverlauf</h2><p class="route-copy">Haltestellen und voraussichtliche Zeiten werden geladen …</p>';
  if (scroll) scrollToEl($(".map-card"));

  try {
    const trip = await api("/fahrten/" + encodeURIComponent(item.fahrtbezeichner));
    if (token !== tripToken) return;
    draw(item, trip);
    routeStops(trip, vehicle(item));
  } catch (err) {
    if (token !== tripToken) return;
    $("#note").textContent = explain(err, "Der Fahrtweg ist gerade nicht verfügbar.");
    route.innerHTML = '<h2 class="route-title">Fahrtverlauf</h2><p class="route-copy">Die Haltestellen dieser Fahrt sind gerade nicht verfügbar.</p>';
  }
}

function draw(item, trip) {
  const cs = trip.geometry?.coordinates || [];
  const v = vehicle(item);
  const vc = v?.geometry?.coordinates;
  if (!cs.length) return;
  routeLayer?.remove();
  directionMarker?.remove();

  const n = vc ? nearest(cs, vc).index : 0;
  routeLayer = L.layerGroup([
    L.polyline(cs.slice(0, n + 1).map(c => [c[1], c[0]]), { color: "#aaa3ad", weight: 5, opacity: .48 }),
    L.polyline(cs.slice(n).map(c => [c[1], c[0]]), { color: color(item.linientext), weight: 7, opacity: .93 })
  ]).addTo(map);
  map.fitBounds(L.latLngBounds(cs.map(c => [c[1], c[0]])), { padding: [25, 25] });

  const d = Math.round(Number(v?.properties?.delay || 0) / 60);
  $("#note").textContent = "Grau: schon gefahren · farbig: kommt noch" + (d > 0 ? " · +" + d + " Min." : d < 0 ? " · " + Math.abs(d) + " Min. früher" : " · pünktlich");

  if (cs.length < 2) return;
  const a = cs[n], b = cs[Math.min(n + 10, cs.length - 1)];
  const angle = Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180 / Math.PI;
  directionMarker = L.marker([b[1], b[0]], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: "",
      html: '<div class="direction" style="background:' + color(item.linientext) + ";transform:rotate(" + angle + 'deg)"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>',
      iconSize: [29, 29],
      iconAnchor: [14, 14]
    })
  }).addTo(map);
}

function nearest(cs, p) {
  let index = 0, distance = Infinity;
  cs.forEach((c, i) => {
    const d = (c[0] - p[0]) * .62 * (c[0] - p[0]) + (c[1] - p[1]) * (c[1] - p[1]);
    if (d < distance) { distance = d; index = i; }
  });
  return { index, distance: Math.sqrt(distance) };
}

function km(a, b) {
  const r = 6371, t = x => x * Math.PI / 180;
  return 2 * r * Math.asin(Math.sqrt(Math.sin(t(b[1] - a[1]) / 2) ** 2 + Math.cos(t(a[1])) * Math.cos(t(b[1])) * Math.sin(t(b[0] - a[0]) / 2) ** 2));
}

function routeStops(trip, v) {
  const cs = trip.geometry?.coordinates || [], l = [0];
  for (let i = 1; i < cs.length; i++) l.push(l[i - 1] + km(cs[i - 1], cs[i]));
  const total = l.at(-1) || 1;

  const stops = state.stops
    .map(g => {
      let best = { index: 0, distance: Infinity };
      g.coordinates.forEach(p => { const x = nearest(cs, p); if (x.distance < best.distance) best = x; });
      return { label: name(g.name), key: g.name, ...best };
    })
    .filter(s => s.distance < .00075)
    .sort((a, b) => a.index - b.index)
    .filter((s, i, arr) => !i || s.index - arr[i - 1].index > 2);
  if (!stops.length) throw new Error("no stops on route");

  const bus = v?.geometry?.coordinates;
  const now = bus ? nearest(cs, bus).index : null;
  const start = Number(trip.properties?.startzeit || v?.properties?.abfahrtstart || 0);
  const end = Number(trip.properties?.endzeit || v?.properties?.ankunftziel || 0);
  const delay = Number(v?.properties?.delay || 0);

  $("#route").innerHTML = '<h2 class="route-title">Fahrtverlauf</h2><p class="route-copy">Voraussichtliche Zeiten inklusive aktueller Verspätung.</p>' +
    stops.map(s => {
      const at = start && end ? start + (end - start) * (l[s.index] / total) + delay : 0;
      const status = now === null
        ? (at && at < Date.now() / 1000 ? "past" : "upcoming")
        : (s.index < now - 2 ? "past" : Math.abs(s.index - now) <= 2 ? "current" : "upcoming");
      const label = status === "past" ? "vorbei" : status === "current" ? "gerade hier" : at ? time(at) : "";
      return '<button type="button" class="stop ' + status + '" data-stop="' + esc(s.key) + '"><span class="dot"></span><span class="stop-name">' + esc(s.label) + '</span><span class="stop-time">' + label + "</span></button>";
    }).join("");
}

function reset() {
  tripToken++;
  state.trip = null;
  state.line = null;
  state.fitted = false;
  routeLayer?.remove(); routeLayer = null;
  directionMarker?.remove(); directionMarker = null;
  $("#reset").hidden = true;
  $("#mapTitle").textContent = "Busse in Münster";
  $("#mapSubtitle").textContent = "Bus oder Haltestelle antippen";
  $("#route").hidden = true;
  updateZoomHint();
  renderVehicles();
}

/* ---------- Search ---------- */
function search(q) {
  if (!q) { closeSearch(); return; }
  const first = [], rest = [], nq = norm(q);
  state.stops.forEach(g => {
    const n = norm(name(g.name));
    if (n.startsWith(nq)) first.push(g); else if (n.includes(nq)) rest.push(g);
  });
  state.matches = [...first, ...rest].slice(0, 7);
  const box = $("#suggestions");
  box.innerHTML = state.matches.length
    ? state.matches.map(g => '<button type="button" class="suggestion" data-stop="' + esc(g.name) + '"><strong>' + esc(name(g.name)) + "</strong><small>" + (g.stops.length > 1 ? g.stops.length + " Steige" : "") + "</small></button>").join("")
    : '<div class="suggestion"><small>Keine Haltestelle gefunden</small></div>';
  box.hidden = false;
}
function closeSearch() { $("#suggestions").hidden = true; }

/* ---------- Geolocation ---------- */
function geoMessage(err) {
  if (err && err.code === 1) return "Standortfreigabe verweigert. Du kannst sie in den Browser-Einstellungen erlauben.";
  if (err && err.code === 3) return "Die Standortbestimmung hat zu lange gedauert. Bitte versuche es erneut.";
  return "Dein Standort konnte nicht bestimmt werden.";
}

function locateMap() {
  if (!navigator.geolocation) { $("#note").textContent = "Standort wird von diesem Browser nicht unterstützt."; return; }
  const b = $("#locateMap");
  b.disabled = true;
  navigator.geolocation.getCurrentPosition(p => {
    const point = [p.coords.latitude, p.coords.longitude];
    const icon = L.divIcon({ className: "", html: '<div class="you-are-here"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    if (userMarker) userMarker.setLatLng(point);
    else userMarker = L.marker(point, { icon, zIndexOffset: 1000, keyboard: false }).addTo(map).bindTooltip("Du bist hier");
    map.setView(point, 15);
    b.disabled = false;
  }, err => {
    b.disabled = false;
    $("#note").textContent = geoMessage(err);
    announce(geoMessage(err));
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function showNearbyStops() {
  const box = $("#nearbyList"), button = $("#nearbyStops"), label = $("#nearbyLabel");
  const message = text => { box.innerHTML = '<div class="message">' + esc(text) + "</div>"; box.hidden = false; announce(text); };
  if (!navigator.geolocation) { message("Standort wird von diesem Browser nicht unterstützt."); return; }
  if (!state.stops.length) { message("Die Haltestellen sind noch nicht geladen."); return; }

  button.disabled = true;
  label.textContent = "Standort wird gesucht …";
  const done = () => { button.disabled = false; label.textContent = "Haltestellen in meiner Nähe"; };

  // Stops are only a few dozen metres apart, so normal accuracy is enough and saves battery.
  navigator.geolocation.getCurrentPosition(p => {
    const here = [p.coords.longitude, p.coords.latitude];
    const nearby = state.stops
      .map(g => ({ ...g, distance: Math.min(...g.coordinates.map(c => km(here, c))) }))
      .filter(g => Number.isFinite(g.distance))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6);
    box.innerHTML = nearby.map(g => '<button type="button" class="nearby-chip" data-stop="' + esc(g.name) + '">' + esc(name(g.name)) + "<small>" + (g.distance < 1 ? Math.round(g.distance * 1000) + " m" : g.distance.toFixed(1) + " km") + "</small></button>").join("");
    box.hidden = false;
    map.setView([p.coords.latitude, p.coords.longitude], CONFIG.stopZoom + 1);
    announce(nearby.length + " Haltestellen in deiner Nähe gefunden");
    done();
  }, err => { message(geoMessage(err)); done(); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

/* ---------- Refresh loop (paused while the tab is hidden) ---------- */
function tick() { loadDepartures(); loadVehicles(); }
function startTimer() { stopTimer(); refreshTimer = setInterval(tick, CONFIG.refreshMs); }
function stopTimer() { clearInterval(refreshTimer); refreshTimer = null; }

function syncOnline() { $("#offline").hidden = navigator.onLine; }

/* ---------- Wiring ---------- */
$("#search").addEventListener("input", e => search(e.target.value));
$("#search").addEventListener("keydown", e => {
  if (e.key === "Enter" && state.matches[0]) select(state.matches[0].name, { pan: true });
  else if (e.key === "Escape") closeSearch();
});
$("#suggestions").addEventListener("click", e => {
  const b = e.target.closest("[data-stop]");
  if (b) select(b.dataset.stop, { pan: true });
});
document.addEventListener("click", e => { if (!e.target.closest(".search-wrap")) closeSearch(); });

$("#nearbyList").addEventListener("click", e => {
  const b = e.target.closest("[data-stop]");
  if (b) select(b.dataset.stop, { pan: true });
});
$("#nearbyStops").addEventListener("click", showNearbyStops);
$("#locateMap").addEventListener("click", locateMap);

$("#lineFilter").addEventListener("input", e => { state.lineFilter = e.target.value; renderDepartures(); });

/* Direction filter: affects the departure list and the bus overview on the map. */
const dirButtons = [...document.querySelectorAll(".dir-btn")];
dirButtons.forEach(b => b.addEventListener("click", () => {
  state.dir = b.dataset.dir;
  dirButtons.forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  renderDepartures();
  renderVehicles();
}));

$("#departures").addEventListener("click", e => {
  if (e.target.closest("[data-retry]")) {
    if (state.stops.length) loadDepartures({ reset: true }); else loadStops();
    return;
  }
  const b = e.target.closest("[data-trip]");
  if (b) showTrip(state.departures.find(d => d.fahrtbezeichner === b.dataset.trip), { scroll: true });
});

$("#route").addEventListener("click", e => {
  const row = e.target.closest("[data-stop]");
  if (row) select(row.dataset.stop);
});

$("#reset").addEventListener("click", reset);

$("#refresh").addEventListener("click", () => {
  const b = $("#refresh");
  b.classList.add("loading");
  Promise.allSettled([loadDepartures(), loadVehicles()]).finally(() => setTimeout(() => b.classList.remove("loading"), 280));
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTimer();
  else { tick(); startTimer(); }
});
window.addEventListener("online", () => { syncOnline(); tick(); });
window.addEventListener("offline", syncOnline);

/* ---------- Start ---------- */
async function init() {
  syncOnline();
  initMap();
  // The map and the bus positions do not depend on the stop list, so a failing stop request
  // no longer takes the whole map down with it.
  await Promise.all([loadStops(), loadVehicles()]);
}
init();
startTimer();

/* Offline-capable app shell. */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ }); });
}
