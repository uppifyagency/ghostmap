# Ghost Map — Project Health & Decision Log

**Last updated:** 2026-09-22  
**Extension version:** 9.13.4  
**Primary fork (Carlo):** `https://github.com/webexpertcarlo/ghostmap` (`fork` remote → `main`)  
**Upstream (read-only for this workstream):** `https://github.com/uppifyagency/ghostmap` (`origin`)

This file is the running overview of architecture, decisions, and known behavior for operators and future agents. It is not end-user documentation (see `USER_GUIDE.md` / `USER_GUIDE.html`).

---

## 1. What this project is

**Ghost Map Pro** is a Chrome MV3 extension that:

1. Discovers businesses from Google Maps (Area Search grid and/or Monitor).
2. Optionally back-fills websites from Maps detail pages.
3. Extracts emails from business websites (queued job runner + tab fallback).
4. Exports CSV, Markdown, and a **filtered multi-sheet XLSX ledger**.

Ship path for users: load the **`extension/`** folder via Chrome “Load unpacked”. Source of truth for development lives at the repo root (`background/`, `content/`, `ui/`, `lib/`); `extension/` is the installable mirror and must stay in sync before releases.

---

## 2. High-level architecture

| Layer | Role |
|-------|------|
| `background/` (+ SW `sw.js`) | Area Search turbo, email queue, export, website extraction, messaging |
| `content/gmb/` | Maps MAIN/ISOLATED scripts, state watcher, business capture, pending-business retry (S3) |
| `ui/` | Side panel, Area Search modal, export buttons, ledger JS |
| `lib/` | Shared helpers (`scrapeWindow.js`, config, ExportAPI, etc.) |
| `ui/vendor/` | Bundled PapaParse + ExcelJS (no CDN in extension pages) |

**CDP / local test profile (ops):** Chrome often launched with remote debugging on port **9335** and extension loaded from a junction such as `C:\Temp\GhostMapExt` → repo root (or the `extension/` package). Extension IDs vary per profile (seen: `hdkeie…`, `ibfjgak…`).

---

## 3. Decision log (chronological highlights)

### D-001 — Ship via `extension/` package, not upstream push by default
- **Decision:** Carlo fork (`webexpertcarlo/ghostmap`) is the push target for this workstream. Do not push to `uppifyagency/ghostmap` unless explicitly asked (permissions / ownership).
- **Why:** Upstream may be read-only; fork is the user’s delivery repo.

### D-002 — UX reliability without changing scrape core
- **Decision:** Fix count mismatch, stuck progress, pause reliability as **UI/status** issues where possible; keep scrape algorithms intact unless a real bug is proven.
- **Outcome:** Live Area Search stats poll `get_area_search_status` (~1s) so percent/searches update during long batches (not only post-batch).

### D-003 — Focus / z-order on Windows
- **Problem:** `chrome.windows.create({ focused: false })` still places windows on top; restoring focus with `windows.update(lastChrome, { focused: true })` only restores **Chrome**, so Cursor/other apps get yanked to Ghost Map.
- **Decision:**
  - Area Search: `createUnfocusedScrapeWindow(..., { restoreFocus: false })`.
  - Email tab fallback + website extractor: same `{ restoreFocus: false }` (aligned with Area Search).
- **Trade-off:** Small 200×200 popups may still flash (Chrome forbids true hidden/minimized scrapers with reliable JS). Goal is “don’t steal OS focus back to Ghost Map,” not invisible windows.

### D-004 — Radius / Area Search inputs
- **Decision:** Treat radius as **km with a practical max ~200**. Values like `15000` are invalid/user error.
- **Ops note:** Document clearly in user guides.

### D-005 — Chrome “Errors” badge noise vs real failures
- **Finding:** Unpacked installs surface `console.warn` / `console.error` on `chrome://extensions` → Errors even when scrape succeeds.
- **Decisions (logging only; retry/reload behavior unchanged):**
  - S3 non-delivered / init_pending / partial drain / sendMessage retry → `logger.debug` (not warn).
  - Anemic Maps state auto-reload log → `console.debug` (reload still runs).
  - Content loader “Extension context invalidated” → silent/debug (expected after Reload mid-tab).
  - Website extract `MESSAGE_TIMEOUT` → debug + keep user toast.
- **Still loud:** True failures after retries (`logger.error` / unexpected loader failures).
- **Ops:** “An unknown error occurred when fetching the script” after Reload with open Maps tabs is a Chrome artifact — Clear all; not a scrape regression.

### D-006 — Live stats vs scrape
- **Decision:** Polling status for UI must not alter turbo scrape scheduling. Fixed frozen live stats by polling, not by changing batch completion semantics.
- **Verified:** During Melbourne/Roofing runs, UI mirrored backend (`current`/`percent`/`elapsed`); scrape continued with Maps tiles open.

### D-007 — Export xlsx filtered (CSV → Excel Ledger)
- **Source of truth for rules:** User’s `e:\Leads Data\csv-to-excel-ledger.html`.
- **Decision:** Port ledger logic into `ui/csv-to-excel-ledger.js`; button **Export xlsx filtered** uses same `export_data` CSV as Export CSV, then builds Excel locally with vendor ExcelJS/PapaParse.
- **Invariant:** **Export CSV** and **Export MD** behavior unchanged.
- **Sheets:** Dashboard, General Leads, Needs Follow-Up, No Website, Owner Leads, Duplicate Leads (generic-email lists + phone/email/domain fuzzy dedupe; keep higher-review winner).

### D-008 — Documentation set
| File | Audience |
|------|----------|
| `USER_GUIDE.md` | Non-technical, markdown |
| `USER_GUIDE.html` | Same content, readable in browser |
| `extension/USER_GUIDE.*` | Copy shipped with install package |
| `health.md` (this file) | Decisions / health for maintainers |
| `extension/INSTALL.txt` | Short install reminder |

---

## 4. Feature health snapshot (2026-09-22)

| Area | Status | Notes |
|------|--------|-------|
| Area Search turbo | Healthy | Live poll stats; `restoreFocus: false` |
| Monitor Maps | Healthy | Manual capture path |
| Website extraction | Healthy | Timeout toast OK; focus quieted |
| Email extraction | Healthy | Focus aligned with Area Search; popups may flash |
| Export CSV / MD | Healthy | Unchanged |
| Export xlsx filtered | Healthy | Smoke-tested partition logic; needs extension Reload |
| Errors badge | Improved | Expected recovery paths quieted; Clear all after Reload |
| `extension/` package | Must mirror root | Sync before ship / push |

---

## 5. Known limitations (accepted)

1. Chrome cannot run reliable scrapers in truly invisible/minimized windows → small visible popups.
2. `getLastFocused` cannot restore focus to non-Chrome apps (Cursor, etc.).
3. Generic-email classification is heuristic (large allow/deny word lists) — false positives/negatives possible.
4. Google / site blocking and CAPTCHAs remain environmental risks; circuit breakers exist but cannot eliminate blocks.
5. Unpacked Errors page will still show genuine exceptions and some Chrome-internal fetch errors on Reload.

---

## 6. Operator checklist before release

- [ ] Sync root → `extension/` (`ui`, `background`, `content`, `lib`, `manifest.json`, guides).
- [ ] Version bump in `manifest.json` if shipping a user-visible change (currently **9.13.4**).
- [ ] Reload unpacked extension; Clear Errors.
- [ ] Smoke: Area Search short run → live stats move; email run → focus not yanked to Ghost Map; Export CSV; Export xlsx filtered opens multi-sheet workbook.
- [ ] Push to **`fork/main`** only (Carlo), unless user requests upstream.

---

## 7. Key file map (recent work)

| Path | Purpose |
|------|---------|
| `lib/scrapeWindow.js` | Unfocused window create + optional restoreFocus |
| `background/area-search.js` | Turbo Area Search; `restoreFocus: false` |
| `background/TabScraperFallback.js` | Email site popups; `restoreFocus: false` |
| `background/website-extractor.js` | Website extract popups; `restoreFocus: false` |
| `content/gmb/index.js` | S3 retry logging quieted |
| `content/gmb/loader.js` | Context-invalidated quieted |
| `content/gmb/maps-state-watcher.js` | Anemic-state log quieted |
| `ui/area-search-modal.js` | Live status poll |
| `ui/csv-to-excel-ledger.js` | Ledger pipeline |
| `ui/vendor/exceljs.min.js`, `papaparse.min.js` | Offline Excel/CSV libs |
| `ui/sidepanel.html` / `.js` | Export xlsx filtered button |

---

## 8. Test evidence log (selected)

| Date | Test | Result |
|------|------|--------|
| 2026-09-22 | Area Search live monitor (~90s) | Stats advanced 0→8/247; UI matched SW; websites/detail activity present |
| 2026-09-22 | Email focus before fix | Host Chrome force-focused after popups (`restoreFocus: true`) |
| 2026-09-22 | Email focus after fix | `hostFocusWhilePopups = 0`; source contained `restoreFocus: false` |
| 2026-09-22 | Ledger smoke (Node) | Owner/General/NoWebsite/FollowUp/Dup partition matched rules |
| 2026-09-22 | Errors dump mid-run | S3 warn (pre-quiet), anemic state, loader context invalidated, MESSAGE_TIMEOUT — addressed via log level changes |

---

## 9. Open / deferred (not done unless requested)

- Preview modal for xlsx filtered before download.
- Export filters (min rating / owner-only).
- Filename from city/keyword.
- Further Errors quieting for remaining diagnostic warns (JSPB drift, reload cap, etc.).
- Commit/push of this health + guide pack (tracked in release checklist).

---

## 10. Change summary for this release wave (9.13.x)

1. Area Search live progress polling.  
2. Background window focus policy for Area Search + email + website extract.  
3. Quieted expected extension Errors noise without changing scrape/retry behavior.  
4. Export xlsx filtered (ported CSV→Excel ledger).  
5. User guides (MD + HTML) and this health log.

---

*End of health log. Append new dated sections rather than rewriting history when decisions change.*
