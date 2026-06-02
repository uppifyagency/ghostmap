<div align="center">

# 👻🗺️ Ghost Map Pro

### The free, open-source **Google Maps scraper** Chrome extension — turn any Google Maps search into a clean CSV of **business leads**.

**No API key. No paid plans. No external servers.** Your browser, your session, your data.

[![License: MIT](https://img.shields.io/badge/License-MIT-34A853.svg?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-7d54f0.svg?style=flat-square)](manifest.json)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4.svg?style=flat-square&logo=googlechrome&logoColor=white)](#-installation)
[![No API key](https://img.shields.io/badge/API%20key-not%20required-34A853.svg?style=flat-square)](#-how-it-works)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-7d54f0.svg?style=flat-square)](#-contributing)
![GitHub stars](https://img.shields.io/github/stars/uppifyagency/ghostmap?style=flat-square&color=34A853)

[**What it does**](#-what-it-does) · [**Features**](#-features) · [**Install**](#-installation) · [**How it works**](#-how-it-works) · [**vs Apify / Outscraper**](#-ghost-map-pro-vs-apify-vs-outscraper-vs-the-official-api) · [**FAQ**](#-faq)

</div>

---

## 🧭 What is Ghost Map Pro?

**Ghost Map Pro is a free Google Maps scraper that runs entirely as a Chrome extension (Manifest V3).** Run a search on Google Maps — *"ristoranti Milano"*, *"plumbers London"*, *"dentists New York"* — and it turns the results into a structured **CSV of B2B leads**: business name, phone, website, **email**, address, rating, review count, opening hours, category, geo-coordinates and (for Italian businesses) **Partita IVA / VAT number**.

It is the **do-it-yourself, zero-cost alternative to paid Google Maps scrapers** like Apify, Outscraper and Octoparse — but instead of renting a cloud actor and paying per row, Ghost Map Pro lives inside **your own browser session** and reads the exact same data Google Maps already loaded into the page. Nothing leaves your machine except the requests that fetch each business's *own public website* to discover its email.

> **In one line:** a **Google Maps lead extractor** that scrapes business name, phone, website, **email** and reviews into a CSV you can drop straight into your CRM — locally, privately, for free.

---

## ✨ What it does

You search on Google Maps; Ghost Map Pro quietly captures every business in the results and builds a lead table:

| Output | What's inside |
|---|---|
| 📊 **`ghost-map-<timestamp>.csv`** | A wide, CRM-ready lead sheet — up to **49 structured columns**: name, phone, website, **email**, full address, rating (decimal), review count, price range, opening hours, category, latitude/longitude, postcode, province, country, Knowledge-Graph ID, owner info, primary photo, reservation link and lead-quality signals (claim status, last owner update, review distribution). |
| 📧 **Email discovery** | For every business with a website, the extension visits the homepage plus the usual `/contact`, `/about`, `/privacy` pages and extracts the real business email — filtering tracking pixels, Cloudflare-obfuscated addresses and placeholder inboxes. |
| 🇮🇹 **Italian-market fields** | First-class **Partita IVA (VAT)** extraction with official checksum validation, `it_IT` locale, comma-decimal handling and composite-label footer parsing — the detail most generic Google Maps scrapers miss. |

The CSV is Excel-safe (phone numbers and VAT codes keep their leading `+`/`0`) and ready for HubSpot, Salesforce, Pipedrive or a plain spreadsheet.

---

## 🚀 Features

- 🆓 **100% free & open source** — no subscription, no per-row credits, no rate-limited free tier. MIT licensed.
- 🔌 **No API key, no Google Places API** — works from your normal browser session; you never touch billing or quotas.
- 🗺️ **Whole-search capture** — scrape an entire Google Maps result list, not one pin at a time. Three modes: silent scroll-capture, one-click **Turbo** force-collect, and per-place **detail enrichment**.
- 📧 **Built-in email extractor** — the part paid scrapers charge extra for: real business emails pulled from each company's own website.
- ⭐ **Rich data, zero extra clicks** — phone, website, decimal **rating**, **review count**, price range, opening hours, category, geo-coordinates, owner info and more, read straight from the page state (no opening a tab per business).
- 🇮🇹 **Italian VAT / Partita IVA** — checksum-validated, with the composite-label parsing real B2B sites need.
- 🛡️ **Anti-detection built in** — coherent browser fingerprints, a session pool, human-like pacing and a circuit breaker that backs off on `429` / Cloudflare challenges.
- 🪝 **Export your way** — download CSV or push leads to a **webhook** (with SSRF-hardened URL validation) for your own automation.
- 🔒 **Private by design** — no servers, no telemetry, no account. Leads live in your browser's local storage until *you* export them.
- 🧩 **Manifest V3, auditable** — plain JavaScript, no build step, easy to fork and read.

---

## 📊 Sample output

A few columns from a real `ristoranti Milano` run (values anonymized):

```csv
name,phone,website,email,rating,reviews,address,partita_iva,category
"Trattoria Esempio","+39 02 1234567","trattoria-esempio.it","info@trattoria-esempio.it",4.6,318,"Via Esempio 8, 20121 Milano MI","01234567890","Restaurant"
"Bar Esempio","+39 02 7654321","bar-esempio.it","ciao@bar-esempio.it",4.4,127,"Corso Esempio 2, 20144 Milano MI","09876543210","Cafe"
```

Open it in Excel/Sheets, or import it straight into your CRM and start the outreach.

---

## 📦 Installation

> Ghost Map Pro is a developer-mode (unpacked) Chrome extension. It is **not** on the Chrome Web Store — you load it directly from source, which keeps it free and fully auditable.

1. **Download the code** — clone or [download the ZIP](https://github.com/uppifyagency/ghostmap/archive/refs/heads/main.zip):
   ```bash
   git clone https://github.com/uppifyagency/ghostmap.git
   ```
2. Open `chrome://extensions/` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. The 👻 icon appears in your toolbar — click it to open the **side panel**.

> Works in any Chromium browser (Chrome, Edge, Brave, Arc, Opera). Requires Chrome ≥ 116 for the side-panel API.

---

## 🖱️ Usage

1. Open **google.com/maps** and run any search (e.g. `hotels Florence`, `idraulici Roma`).
2. Click the 👻 icon to open the **Ghost Map Pro side panel**.
3. Capture the results in whichever mode fits:
   - **Scroll** — scroll the Maps result list; the extension captures silently as new businesses stream in.
   - **Turbo** — one click grabs every result currently loaded.
   - **Area search** — give it a city/area and let it sweep the grid for you.
4. *(Optional)* Enable **email discovery** to fetch each business's website and pull its email.
5. Hit **Export** → download the **CSV** (or send it to your webhook). Done.

---

## 🧱 How it works

Ghost Map Pro reads the data **Google Maps already loaded into the page** (`window.APP_INITIALIZATION_STATE`) and watches the incremental JSPB payloads Maps streams while you scroll — so it captures the full result set without opening a tab per business or hitting any paid API.

```text
┌──────────────────────────────────────────────────────────────────┐
│  🪟  SIDE PANEL  (ui/sidepanel.html)                               │
│      drives the flow · renders progress · exports CSV / webhook    │
└──────────────┬─────────────────────────────────────▲──────────────┘
   start / stop │                                     │  results · stats
   area search  ▼                                     │
┌──────────────────────────────────────────────────────────────────┐
│  💾  SERVICE WORKER  (background/sw.js · MV3 module)               │
│   ├─ job queue + autoscaler        ├─ area-search grid sweep       │
│   ├─ 📧 email-scraper-v2           └─ 🪝 ExportAPI (CSV + webhook) │
│   └─ uses ▶ FingerprintGenerator · SessionPool · CircuitBreaker    │
└───────▲──────────────────────────────────┬────────────────────────┘
        │ business records                 │ parse website HTML
┌───────┴───────────────────────────┐  ┌───▼────────────────────────┐
│  CONTENT SCRIPTS (on Google Maps)  │  │  OFFSCREEN  (offscreen/)    │
│   content/gmb/maps-state-watcher   │  │  DOM-parses fetched pages   │
│   (MAIN world) reads APP_INIT_STATE│  │  for the EmailExtractor     │
│   + captures JSPB during scroll    │  └─────────────────────────────┘
│   content/gmb/detail-fetcher       │
└────────────────────────────────────┘
```

**Runtime layout:**

```
manifest.json                       # MV3
background/
  sw.js                             # service-worker entry
  email-scraper-v2.js               # website fetch + email discovery
  area-search.js                    # area/grid lead sweep
  jobQueue.js · autoscaler ...       # scheduling + backpressure
content/gmb/
  maps-state-watcher.js             # MAIN-world: reads page state + JSPB
  detail-fetcher.js · loader.js     # per-place enrichment
offscreen/parser.js                 # off-DOM HTML parsing for emails
lib/
  EmailExtractor.js                 # business-email extraction + filters
  partitaIva.js                     # Italian VAT, checksum-validated
  phone-normalizer.js               # EU phone normalization (Excel-safe)
  FingerprintGenerator.js           # coherent browser fingerprints
  SessionPool.js · CircuitBreaker.js# anti-detection + backoff
  ExportAPI.js                      # CSV + SSRF-hardened webhook export
ui/sidepanel.html / .js             # the panel + state controller
```

---

## 🛡️ Anti-detection

The risk when scraping Google Maps is the rate of requests, so Ghost Map Pro is built to look like a real user:

- **Coherent fingerprints** — `FingerprintGenerator` keeps User-Agent, Accept-Language q-values and client hints internally consistent (no telltale mismatches).
- **Session pool** — rotates and persists sessions across service-worker restarts.
- **Circuit breaker** — on `429` / `503` / Cloudflare challenges it opens a cooldown and backs off instead of hammering.
- **Email-discovery throttling** — per-worker failure counters and pacing when fetching business websites.

Even so: use it gently and at human scale. See [Responsible use](#-privacy--responsible-use).

---

## ⚖️ Ghost Map Pro vs Apify vs Outscraper vs the official API

| | 👻 **Ghost Map Pro** | 💰 Apify / Outscraper | 🏢 Google Places API |
|---|---|---|---|
| **Cost** | Free, open source | Pay per run / per row | Free tier, then per-1000 billing |
| **Setup** | Load unpacked extension | Account + actor / token | Cloud project + billing + key |
| **API key** | ❌ Not needed | ✅ Platform token | ✅ Billable API key |
| **Email discovery** | ✅ Built in | 💲 Usually a paid add-on | ❌ Not provided |
| **Runs on** | Your browser, locally | Vendor cloud | Google servers |
| **Data location** | Stays on your machine | Vendor cloud storage | Google |
| **Italian VAT (P.IVA)** | ✅ Checksum-validated | ⚠️ Rarely | ❌ No |
| **Open source** | ✅ MIT | ❌ | ❌ |

If you've searched for a *"google maps scraper github"*, an *"apify alternative"* or a *"free google maps lead extractor"* — this is the local, no-key version of that.

---

## 🔐 Privacy & responsible use

- **Local-first.** Ghost Map Pro has no backend. Captured leads live in your browser's local storage until you export them; nothing is uploaded to us.
- **Public business data.** It reads the same business listings any visitor sees on Google Maps, plus emails published on each company's own public website — i.e. B2B contact details.
- **Your responsibility.** You are responsible for using the data lawfully. Respect Google's Terms of Service, each website's terms, `robots.txt`, and applicable privacy law (**GDPR**, CAN-SPAM, etc.) — especially before any outreach. This tool is intended for legitimate B2B lead research, not spam.

---

## ❓ FAQ

**Is it legal to scrape Google Maps?**
Scraping publicly visible business listings for B2B research is widely done, but legality depends on your jurisdiction, how you use the data, and the platforms' terms. Ghost Map Pro only reads public data and keeps it local — but compliance (Google ToS, GDPR, outreach laws) is on you. When in doubt, ask a lawyer.

**Do I need a Google Maps / Places API key?**
No. That's the whole point — it reads the data already loaded in your browser.

**Does it work outside Italy?**
Yes. The core fields (name, phone, website, email, rating, reviews, address, hours, geo) are international. The **Partita IVA** field is the Italy-specific extra.

**Where does the email come from?**
From each business's *own website*, not from Google. If a business has no website (or no email on it), that row simply has no email.

**Will this get my account or IP blocked?**
Scrape gently. The anti-detection layer reduces risk, but aggressive, high-volume runs can still trigger rate limits. Human scale is the safe zone.

**Is it on the Chrome Web Store?**
No — it's loaded unpacked from source, which keeps it free and auditable.

---

## 🤝 Contributing

PRs and issues welcome. The codebase is plain MV3 JavaScript with no build step — clone, load unpacked, edit, reload. Good first areas: new export targets, additional locale/VAT formats, selector resilience.

---

## 📄 License

[MIT](LICENSE) — free to use, fork and modify.

---

<div align="center">

**Ghost Map Pro** · a free **Google Maps scraper & lead extractor** Chrome extension
Built by [Vlad Vrinceanu](https://www.linkedin.com/in/vladvrinceanu/) · maintained by [Uppify](https://github.com/uppifyagency)

*Keywords: google maps scraper · scrape google maps · google maps lead generation · google maps email extractor · google maps data extractor · google business profile scraper · apify / outscraper / octoparse alternative · chrome extension · manifest v3 · no API.*

</div>
