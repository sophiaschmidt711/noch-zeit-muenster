# Noch Zeit? · Münster

Persönlicher Live-Abfahrtsmonitor für Busse in Münster: Haltestelle suchen oder in der Nähe finden,
Abfahrten mit Verspätung sehen, Buspositionen und Fahrtverlauf auf der Karte verfolgen.

Live: https://sophiaschmidt711.github.io/noch-zeit-muenster/

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Seitengerüst, Meta-Tags, SEO |
| `style.css` | gesamtes Styling |
| `app.js` | gesamte Logik (Konfiguration oben in `CONFIG`) |
| `sw.js` | Service Worker: App-Hülle offline verfügbar (Live-Daten und Kacheln werden nie zwischengespeichert) |
| `manifest.webmanifest` | Installierbarkeit als App |
| `sitemap.xml` | Sitemap für Suchmaschinen |
| `worker/busradar-proxy.js` | optionaler Proxy, falls die API einen geheimen Schlüssel verlangt |

## Datenquellen

- Abfahrten und Fahrzeugpositionen: BusRadar Münster (`rest.busradar.conterra.de`)
- Karte: © OpenStreetMap-Mitwirkende (Attribution bleibt in der Karte sichtbar)
- Kartenbibliothek: [Leaflet](https://leafletjs.com) 1.9.4 (per CDN, mit Integritätsprüfung für das Skript)

## Fehler „API key required“ – Vorgehen

1. Seite öffnen, `F12` → Reiter **Netzwerk**, neu laden, nach Anfragen mit Status `401`/`403` suchen.
2. Die Domain der fehlschlagenden Anfrage zeigt, welcher Dienst die Meldung liefert:
   - **Kartenkacheln** (z. B. `tile.…`): Anbieter in `CONFIG.tiles` wechseln. Braucht der Anbieter einen Schlüssel,
     nur einen **öffentlichen, auf die Domain beschränkten** Browser-Schlüssel verwenden (im Dashboard des Anbieters nach
     HTTP-Referrer `https://sophiaschmidt711.github.io/*` einschränken und ein Kontingent setzen).
   - **BusRadar-API** (`rest.busradar.conterra.de`): Bei Bedarf den Proxy aus `worker/busradar-proxy.js` verwenden.
     Der geheime Schlüssel liegt dann nur im Worker.
3. **Niemals** einen geheimen Schlüssel in `app.js`, `index.html` oder ein GitHub-Pages-Build einbauen: Alles, was
   ausgeliefert wird, ist öffentlich. Ein einmal committeter Schlüssel bleibt in der Git-Historie und muss neu erzeugt werden.

### Proxy einrichten (nur falls nötig)

```bash
npm create cloudflare@latest busradar-proxy   # Worker anlegen, busradar-proxy.js als Code verwenden
npx wrangler secret put UPSTREAM_KEY          # geheimen Schlüssel hinterlegen
# Variablen setzen: ALLOWED_ORIGIN=https://sophiaschmidt711.github.io, UPSTREAM_KEY_HEADER=<Headername laut API-Doku>
npx wrangler deploy
```

Danach in `app.js` `CONFIG.apiBase` auf die Worker-URL setzen. Zusätzlich in Cloudflare eine Rate-Limiting-Regel anlegen.

## Entwicklung

Reine statische Seite, kein Build-Schritt. Lokal starten mit `python3 -m http.server` und `http://localhost:8000` öffnen.
Nach Änderungen an `index.html`, `style.css` oder `app.js` in `sw.js` die Konstante `VERSION` erhöhen, damit der Cache erneuert wird.
