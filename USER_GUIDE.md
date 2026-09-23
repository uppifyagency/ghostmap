# Ghost Map Pro — User Guide

**Version:** 9.13.4  
**Who this is for:** Everyday users (no coding needed)  
**What this tool does:** Finds business leads from Google Maps, collects websites and emails, then exports them to CSV, Markdown, or a filtered Excel workbook.

> Prefer a clickable guide in your browser? Open **`USER_GUIDE.html`** (same folder) or **`extension/USER_GUIDE.html`**.

---

## 1. Install (one-time)

1. Open Google Chrome.
2. Go to: `chrome://extensions`
3. Turn **Developer mode** ON (top-right switch).
4. Click **Load unpacked**.
5. Select the **`extension`** folder from this project.
6. Pin **Ghost Map Pro** from the puzzle-piece icon in Chrome.
7. Open Google Maps: [https://www.google.com/maps](https://www.google.com/maps)
8. Click the Ghost Map icon → open the **side panel**.

If you already installed an older version: click **Reload** on Ghost Map Pro on the extensions page after updates.

---

## 2. The big picture (3 steps)

Ghost Map works in three phases. Use them in order:

| Phase | Name | What it does |
|-------|------|----------------|
| 1 | **Discover** | Find businesses (Area Search or Monitor Maps) |
| 2 | **Extract** | Visit websites and collect emails |
| 3 | **Export** | Download CSV / Markdown / filtered Excel |

Top of the side panel shows:

- **Businesses Found** — total leads saved
- **emails / websites / phones** — how many have each field

---

## 3. Important idea: counts are different things

| Number you see | Meaning |
|----------------|---------|
| Area Search “leads” / Businesses Found | Unique businesses saved |
| Websites | How many of those have a website URL |
| Email progress `12 / 19` | Progress of **this email run** (websites queued), not the Area Search lead total |

**Example:** Area Search finds **100** businesses, **70** have websites → email extraction queues about **70**, not 100.

---

## 4. Before you start — checklist

- [ ] Chrome is open
- [ ] Ghost Map Pro is installed and enabled
- [ ] Side panel is open
- [ ] You know your **city** and **keywords** (e.g. `roofing`, `plumber`)
- [ ] Decide: **new area** (clear old data) or **add to existing** data

### Starting a brand-new area (recommended)

1. Go to **Export** (or use the trash icon at the top).
2. Click **Reset All**.
3. Confirm. This clears saved businesses.
4. Run Area Search for the new city.

If you **do not** reset, new results are **added** to old ones.

---

## 5. Phase 1 — Discover

### 5.1 Area Search (best for whole cities / regions)

**What it is:** Searches Google Maps on a grid around a city for your keywords and saves businesses.

**How to run it**

1. Side panel → **Discover** → **Launch Area Search**.
2. Fill in:

| Field | What to enter | Tips |
|-------|----------------|------|
| **City / Location** | e.g. `Melbourne, Australia` | Use a real place name |
| **Radius (km)** | How far around the city | **Max about 200 km**. Do not enter huge numbers like 15000 |
| **Keywords** | One phrase per line | e.g. `roofing` then `plumber` |
| **Turbo Mode** | ON/OFF | ON is faster (several Maps windows) |
| **Parallel Tabs** | 4–12 | Start with **8**. Lower if Chrome slows down |
| **Grid Spacing** | 5–15 km | **5** = denser; **15** = faster / may miss some |

3. Check the **Search Estimate**.
4. Click **Start Turbo Search**.
5. Watch live progress (percent, searches done, batches, elapsed time).
6. Use **Pause** / **Stop** if needed.

**During Area Search**

- Small Maps helper windows may open. They are designed to stay in the **background** so you can keep working in other apps.
- Live stats update while a search is running (not only when a batch finishes).

**When done**

- Note your total businesses.
- Optional: **Extract Websites** if many listings have no website.
- Click **Continue to Extract** when ready for emails.

### 5.2 Monitor Google Maps (manual scrolling)

1. Search on Google Maps yourself (e.g. `dentists in Austin`).
2. In Ghost Map, click **Start Monitoring**.
3. Scroll the results list slowly.
4. Click **Stop** when finished.

Use this for a small area. Use **Area Search** for full-city coverage.

### 5.3 Extract Websites

Opens Maps pages to find missing website links.

| Button | Meaning |
|--------|---------|
| **Extract Websites** | Start finding websites |
| **Pause** | Pause / resume |

Badge number = how many still need a website.

### 5.4 Import file (optional)

**Browse** a `.txt` / `.csv` / `.md` of URLs and **Add to Discovery** if you already have Maps/business links.

---

## 6. Phase 2 — Extract (emails)

1. Open **Extract** (or **Continue to Extract**).
2. Click **Start Extraction**.

| Control | What it does |
|---------|----------------|
| **Start Extraction** | Begin (or resume if paused) |
| **Pause** / **Resume** | Pause the queue without losing progress |
| Progress `done / total` | This run’s website queue |
| **Retry Failed** | Re-try businesses that failed earlier |

### Tips

- Pause keeps jobs in the queue — it does **not** delete progress.
- Not every website has a public email — that is normal.
- Small website popups may flash briefly in the corner. Ghost Map should **not** keep yanking focus back to Chrome while you work in another app (same idea as Area Search).

---

## 7. Phase 3 — Export

1. Open **Export**.
2. Check preview: Total / With Email / With Website / With Phone.
3. Download:

| Button | Output | When to use |
|--------|--------|-------------|
| **Export CSV** | Full raw spreadsheet | Open in Excel / Google Sheets; all columns |
| **Export MD** | Markdown of emails | Quick email list for notes / tools |
| **Export xlsx filtered** | Multi-sheet Excel “ledger” | Ready-to-work lists (see below) |
| **View Failed** | Problem rows | Investigate failures |
| **Reset All** | Wipe saved data | Starting a new city |

### 7.1 Export xlsx filtered — what you get

Same data as CSV, then automatically cleaned and sorted into Excel tabs:

| Sheet | Who goes here |
|-------|----------------|
| **Dashboard** | Summary counts, top categories, scrape status |
| **Owner Leads** | Has website + a **personal-looking** email (e.g. `john@…`) |
| **General Leads** | Has website + email, but email looks **generic** (`info@`, `sales@`, `admin@`…) |
| **Needs Follow-Up** | Has website, **no** email yet |
| **No Website** | No website URL |
| **Duplicate Leads** | Same phone, email, or website domain as a stronger (higher-review) lead |

**Example:** You export 500 businesses → Excel might show ~450 unique, with Owner / General / Follow-Up / No Website split, and duplicates on their own tab.

CSV and MD buttons are unchanged — use filtered Excel when you want outreach-ready buckets.

---

## 8. Settings (gear icon)

### General tab

| Setting | Meaning | Suggested |
|---------|---------|-----------|
| **Requests per Minute** | Email request speed | **10–15** (safer) |
| **Max Concurrent Requests** | Sites at once | **3–5** (max 5) |
| **Request Timeout (seconds)** | Wait on slow sites | **30** |

Click **Save Settings** after changes.

### Opportuni tab (optional)

Cloud sync — default **OFF**. Enable only if you use Opportuni.

---

## 9. Header buttons

| Button | Purpose |
|--------|---------|
| Status (Idle / Extracting / Paused…) | Current activity |
| Gear | Settings |
| Red trash | **Reset All Data** |

---

## 10. Recommended workflows

### A) Full city lead list (most common)

1. **Reset All** (new city).
2. **Area Search** → city + keywords + radius ≤ 200.
3. Wait until finished (watch live progress).
4. **Extract Websites** if needed.
5. **Extract** → **Start Extraction**.
6. **Export CSV** and/or **Export xlsx filtered**.
7. Next city: **Reset All**, repeat.

### B) Quick single Maps search

1. Search on Maps yourself → **Start Monitoring** → scroll → **Stop**.
2. Extract → Export.

### C) Same city, new keyword (keep old data)

1. Do **not** reset.
2. Area Search with new keywords.
3. Extract again (only pending websites).

---

## 11. Understanding progress & “stuck”

| What you see | What it usually means |
|--------------|------------------------|
| Numbers quiet for a bit | Slow site / waiting — wait 1–2 minutes |
| Area Search at 0% for a few minutes | First batch still running — elapsed time should still tick |
| Paused | Click **Resume** |
| Failed count rising | Some sites block / no email — use Retry later |
| Email total ≠ Area Search total | Only businesses **with websites** are emailed |
| Chrome feels slow | Lower Parallel Tabs / Concurrent Requests |
| Red **Errors** on extensions page | Often harmless warnings from recovery; Clear all after Reload if needed |

---

## 12. Storage bar

Bottom of the panel shows browser storage used. If nearly full: export, then **Reset All**.

---

## 13. Troubleshooting

| Problem | What to try |
|---------|-------------|
| Extension missing | Load unpacked → `extension` folder |
| Nothing captured | Open a Maps tab; for Monitor, Start then scroll |
| Area Search finds 0 | Check city spelling; radius ≤ 200; simpler keywords |
| Radius rejected / odd estimate | Use radius **≤ 200** (not 15000) |
| Email won’t start | Extract Websites first; confirm websites exist |
| Pause won’t continue | Click **Resume** |
| Focus jumps to Chrome popups | Reload latest extension; email/Area Search use background windows |
| Want a new city only | **Reset All** before new Area Search |
| Excel button does nothing | Reload extension; wait for loading overlay; need at least one business |

---

## 14. Privacy & good practice

- Use for legitimate research / outreach you are allowed to do.
- Prefer safer speed settings to reduce blocks.
- Export and back up files before Reset All.

---

## 15. Quick glossary

| Term | Plain meaning |
|------|----------------|
| Lead / Business | One company saved from Maps |
| Keyword | Maps search phrase |
| Radius | How far around the city (km) |
| Grid / Turbo | Map points + parallel windows for Area Search |
| Queue | Websites waiting for email extraction |
| CSV | Raw spreadsheet |
| XLSX filtered | Sorted Excel ledger (Owner / General / …) |
| Owner email | Personal-looking address (not info@ / sales@) |

---

## 16. Install reminder

Load / reload this folder in Chrome:

`extension/`

See also `extension/INSTALL.txt` for short install steps.
