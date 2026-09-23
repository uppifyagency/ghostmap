/**
 * Ghost Map — CSV → Excel Ledger (ported from csv-to-excel-ledger.html).
 * Expects globals: Papa (PapaParse), ExcelJS.
 * Exposes window.GhostMapLedger.buildAndDownloadXlsx(csvText, filenameBase).
 */
(function (global) {
  'use strict';

/* ---------- data cleaning helpers ---------- */

  function isBlank(v){
    return v === undefined || v === null || String(v).trim() === '';
  }

  /* ---------- generic / role-based email detection ---------- */

  const EXACT_GENERIC_WORDS = new Set([
    "aaa","abc","abuse","academy","accessibility","account","accountant","accounting",
    "accountmanager","accountmanagers","accounts","accountspayable","acquisition","adm","admin","administracao",
    "administracion","administrador","administratie","administratif","administration","administrativo","administrator","administrators",
    "admins","adminteam","admisiones","admissions","adops","ads","advertise","advertising",
    "advertisingsales","advice","advisor","advisors","adwords","affiliate","affiliates","agency",
    "agents","alarm","alarms","alert","alerts","all","allemployees","allhands",
    "allsales","allstaff","allstudents","allteachers","allteam","allusers","alumni","ambassador",
    "ambassadors","amministrazione","analysts","analytics","android","angels","animation","announce",
    "announcements","api","app","apple","application","applications","apply","appointments",
    "apps","archives","arin","asistente","ask","asset","assistanthead","assistencia",
    "assistenza","associates","ateam","atencionalcliente","atendimento","auctions","automated","automation",
    "available","backend","backup","benefits","berlin","bestellung","beta","biblioteca",
    "bibliotheque","billing","bills","biuro","biz","bizdev","booking","bookings",
    "boston","bot","brand","branding","brandsolutions","buchhaltung","bugs","bulletins",
    "business","businessdevelopment","butik","calendar","caltrain","campaign","campaigns","campusteam",
    "capacitacion","captain","captains","care","career","careers","catering","central",
    "centro","ceo","ceos","channelsales","chartering","chat","chatter","chef",
    "chicago","china","church","citymanagers","class","client","clientes","clientservices",
    "clinic","cloud","coach","coaches","coaching","colaboradores","colegio","comenzi",
    "comercial","comments","commercial","commerciale","commissions","committee","comms","communication",
    "communications","community","company","compete","competition","complaints","compliance","compras",
    "comptabilite","comunicacao","comunicacion","comunicaciones","comunicazione","concierge","conference","connect",
    "consultant","consultas","consulting","consultoria","contabil","contabilidad","contabilidade","contabilita",
    "contact","contactenos","contacto","contactus","contador","contato","content","contractor",
    "contractors","contracts","controller","coordinator","copyright","core","coreteam","corp",
    "corporate","corporatesales","council","courrier","course","courses","creative","crew",
    "crm","csm","csteam","cultura","culture","customer","customercare","customerfeedback",
    "customers","customerservice","customerservicecenter","customerservices","customersuccess","customersupport","custserv","daemon",
    "data","database","deals","delivery","demo","denver","departures","deploy",
    "deputy","deputyhead","design","designer","designers","dev","developer","developers",
    "development","devnull","devops","devs","devteam","digest","digital","direccion",
    "direction","directo","director","directors","directory","diretoria","direzione","discuss",
    "dispatch","diversity","dns","docs","domain","domainmanagement","domains","donations",
    "donors","donotreply","download","dreamteam","ecommerce","editor","editorial","editors",
    "education","eletters","email","emailinfo","emails","emergency","employment","eng",
    "engagement","engenharia","engineering","engineers","english","enq","enquire","enquires",
    "enquiries","enquiry","enrollment","enterprise","envio","equipe","equipo","error",
    "errors","escritorio","europe","event","events","everybody","everyone","exec",
    "execs","execteam","executive","executives","expenses","expert","experts","export",
    "express","facebook","facilities","facturacion","faculty","family","faq","farmacia",
    "faturamento","fax","fbl","feedback","fellows","filter","finance","financeiro",
    "finanzas","firmapost","fiscal","food","football","founders","france","franchise",
    "friends","frontdesk","frontend","frontoffice","fte","ftp","fulfillments","fulltime",
    "fun","fundraising","geeks","general","geral","gerencia","giving","global",
    "grants","graphics","group","growth","hackathon","hackers","head","headoffice",
    "heads","headteacher","hello","help","helpdesk","highschool","hiring","hola",
    "home","homes","hosting","hostmaster","hotel","house","hrdept","hsstaff",
    "hsteachers","humanresources","ideas","ifttt","implementation","import","inbound","inbox",
    "india","info","infopremium","infor","informacion","informatica","information","informatique",
    "informativo","infra","infrastructure","ingenieria","innkeeper","innovation","inoc","inquiries",
    "inquiry","insidesales","insights","instagram","instructor","insurance","integration","integrations",
    "intern","internal","international","internet","interns","internship","invest","investment",
    "investor","investorrelations","investors","investorservices","invitations","invites","invoice","invoices",
    "invoicing","ios","iphone","ithelp","itsupport","itunes","jira","job",
    "jobalerts","jobs","join","jornalismo","junk","kontakt","kundeservice","lab",
    "laboratorio","labs","ladies","latam","launch","lead","leaders","leadership",
    "leadershipteam","leads","learn","learning","leasing","legal","letters","library",
    "licensing","lifesum","links","list","listingupdates","listmanager","listproc","listserv",
    "loanops","login","loginotp","logistica","logistics","logistiek","lunch","mail",
    "mailbox","maildaemon","mailer","mailerdaemon","mailing","mailman","maintenance","majordomo",
    "management","manager","managers","marketing","marketingteam","marketplace","master","mayor",
    "media","meeting","meetup","member","members","memberservices","membership","membersuccess",
    "mentor","mentors","merchant","merchants","metrics","mgmt","middleschool","misc",
    "mkt","mktg","mobile","monitor","monitoring","montreal","music","namecheap",
    "network","newbiz","newbusiness","news","newsletter","newsletters","newyork","nntp",
    "nobody","noc","noemail","none","noreply","noresponse","northamerica","nospam",
    "notes","notification","notifications","notify","nps","null","nyc","nyoffice",
    "offboarding","offers","office","officeadmin","officemanager","officers","officestaff","offtopic",
    "oficina","onboarding","online","onsite","ooo","operaciones","operations","ops",
    "order","orders","ordini","outage","outreach","owners","parents","partner",
    "partners","partnerships","parts","pastor","pay","payment","payments","paypal",
    "payroll","people","peoplemanagers","peopleops","performance","personnel","phish","phishing",
    "photos","pkginfo","planning","platform","plex","portfolio","post","postbox",
    "postfix","postmaster","ppc","prefeitura","presales","presidencia","president","presidente",
    "press","presse","prime","principal","principals","privacy","procurement","prod",
    "produccion","product","production","productmanagers","products","productteam","produto","professor",
    "program","programs","project","projectmanagers","projects","promo","promotions","protocollo",
    "proveedores","publicidade","publisher","publishers","publishing","purchase","purchases","purchasing",
    "qualidade","questions","quotes","random","receipts","recepcion","reception","receptionist",
    "recommendations","recruit","recruiter","recruiters","recruiting","recruitment","recrutement","recursoshumanos",
    "redacao","redaccion","redaction","redazione","referrals","reg","register","registrar",
    "registration","reklama","reminder","reminders","report","reporting","reports","request",
    "requests","reserva","reservaciones","reservas","reservation","reservations","response","retail",
    "revenue","rfp","rnd","rockstars","root","rrhh","rsvp","sac",
    "sale","sales","salesengineers","salesforce","salesops","salesteam","sanfrancisco","schedule",
    "school","schooloffice","science","sdr","search","seattle","secretaria","secretariaat",
    "secretaris","secretary","security","sekretariat","sellersupport","sem","seniors","seo",
    "server","service","serviceclient","servicedesk","services","servicioalcliente","sfoffice","sfteam",
    "shareholders","shipping","shop","shopify","shopping","signup","signups","singapore",
    "sistemas","site","smile","smtp","social","socialclub","socialmedia","socios",
    "software","solutions","soporte","sos","spam","sponsorship","sport","squad",
    "staff","startups","stats","stay","stockholm","store","stories","strategy",
    "stripe","student","students","studio","study","submissions","submit","subscribe",
    "subscriptions","success","suggestions","superintendent","supervisor","supervisors","suporte","supply",
    "support","supportteam","suprimentos","survey","sysadmin","system","systemmessage","systems",
    "talent","tax","teacher","teachers","team","teamleaders","teamleads","tech",
    "technical","technik","technology","techops","techsupport","techteam","tecnologia","tesoreria",
    "test","testing","theoffice","theteam","tickets","time","timesheets","todos",
    "tools","tour","trade","trainers","training","transport","travel","treasurer",
    "tribe","trustees","turismo","twitter","undisclosed","unsubscribe","update","updates",
    "usa","usenet","user","users","usinfo","usteam","uucp","vendas",
    "vendors","ventas","verkauf","voicemail","volunteer","volunteering","volunteers","vorstand",
    "warehouse","watercooler","web","webadmin","webdesign","webdev","webinar","webinars",
    "webmaster","webnotification","website","webteam","welcome","whois","wholesale","women",
    "wordpress","work","workshop","writers","www","zakaz","zentrale",
  ]);

  const GENERIC_SUBSTRING_STEMS = [
    'info','contact','sales','admin','mail','care','account','order','quote',
    'service','support','reception','billing','invoice','enquir','inquir',
    'market','customer','noreply','donotreply','webmaster','postmaster',
    'newsletter','subscribe','dispatch','logistic','recruit','feedback',
    'helpdesk','bookkeep','warehouse','reservation','general','project',
  ];

  const JUNK_DOMAINS = new Set([
    'godaddy.com', 'wixpress.com', 'weebly.com', 'squarespace.com',
    'godaddysites.com', 'business.site', 'strikingly.com', 'jimdo.com',
    'duda.co', 'format.com',
  ]);

  function splitEmails(field){
    if (isBlank(field)) return [];
    return String(field).split(',').map(s => s.trim()).filter(Boolean);
  }

  function isGenericEmailAddress(email){
    if (isBlank(email)) return false;
    const at = email.indexOf('@');
    if (at <= 0) return false;
    const local = email.slice(0, at).toLowerCase();
    const domain = email.slice(at + 1).toLowerCase().trim();
    if (JUNK_DOMAINS.has(domain)) return true;
    const tokens = local.split(/[^a-z]+/).filter(Boolean);
    if (!tokens.length) return false;
    for (const token of tokens){
      if (EXACT_GENERIC_WORDS.has(token)) return true;
    }
    for (const token of tokens){
      for (const stem of GENERIC_SUBSTRING_STEMS){
        if (token.includes(stem)) return true;
      }
    }
    return false;
  }

  // A record counts as an "owner lead" if ANY individual address in its
  // (possibly multi-value, comma-separated) email field is a real,
  // non-generic, non-junk-domain address.
  function hasOwnerEmail(emailField){
    const emails = splitEmails(emailField);
    return emails.some(e => e.includes('@') && !isGenericEmailAddress(e));
  }

  /* ---------- field cleaning helpers ---------- */

  function cleanPhone(v){
    if (isBlank(v)) return '';
    const s = String(v);
    const m = s.match(/"([^"]+)"/);
    if (m) return m[1].trim();
    return s.replace(/^="?/, '').replace(/"$/, '').trim();
  }

  function resolveCategory(row){
    const cat = row['Category'];
    const catNames = row['Category Names'];
    const looksLikeRating = typeof cat === 'string' && /^\d\.\d\(\d+\)$/.test(cat.trim());
    if (looksLikeRating || isBlank(cat) || String(cat).trim() === 'No reviews'){
      return !isBlank(catNames) ? String(catNames).trim() : 'Uncategorized';
    }
    return String(cat).trim();
  }

  function resolveAddress(row){
    const formatted = row['Address (Formatted)'];
    if (!isBlank(formatted)) return String(formatted).trim();
    return !isBlank(row['Address']) ? String(row['Address']).trim() : '';
  }

  function toNumber(v){
    if (isBlank(v)) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function pickName(row){
    const candidates = ['Title', 'Business Name', 'Name'];
    for (const c of candidates){
      if (!isBlank(row[c])) return String(row[c]).trim();
    }
    return '';
  }

  function normalizePhone(phone){
    if (isBlank(phone)) return '';
    const digits = phone.replace(/\D+/g, '');
    return digits.length >= 6 ? digits : '';
  }

  function extractDomain(url){
    if (isBlank(url)) return '';
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
      return host || '';
    } catch (e){
      return '';
    }
  }

  const DATA_COLUMNS = [
    { header:'Business Name', key:'name', width:30 },
    { header:'Category', key:'category', width:24 },
    { header:'Phone', key:'phone', width:16 },
    { header:'Email', key:'email', width:30 },
    { header:'Website', key:'website', width:28 },
    { header:'Rating', key:'rating', width:8 },
    { header:'Reviews', key:'reviews', width:9 },
    { header:'Address', key:'address', width:32 },
    { header:'Postcode', key:'postcode', width:10 },
    { header:'Suburb/Comune', key:'suburb', width:16 },
    { header:'Province/State', key:'province', width:14 },
    { header:'Country', key:'country', width:9 },
    { header:'Distance From Center (km)', key:'distance', width:12 },
    { header:'Scrape Status', key:'scrapeStatus', width:14 },
    { header:'Website Domain', key:'domain', width:22 },
    { header:'Facebook', key:'facebook', width:24 },
    { header:'Instagram', key:'instagram', width:24 },
    { header:'LinkedIn', key:'linkedin', width:24 },
    { header:'Google Maps URL', key:'gmaps', width:24 },
    { header:'Open Status', key:'openStatus', width:18 },
    { header:'Hours (Weekly)', key:'hours', width:40 },
    { header:'Review Snippet', key:'snippet', width:40 },
    { header:'Scraped At', key:'scrapedAt', width:20 },
  ];

  const DUPLICATE_COLUMNS = DATA_COLUMNS.concat([
    { header:'Duplicate Of', key:'duplicateOf', width:30 },
    { header:'Matched On', key:'matchedOn', width:22 },
  ]);

  /* ---------- record building, dedupe, partition ---------- */

  function buildRecords(rawRows){
    const seen = new Set();
    const records = [];
    for (const row of rawRows){
      const name = pickName(row);
      if (!name) continue;
      const phone = cleanPhone(row['Phone']);
      const email = isBlank(row['Email']) ? '' : String(row['Email']).trim();
      const website = isBlank(row['Website']) ? '' : String(row['Website']).trim();
      const key = `${name.toLowerCase()}|${phone}|${website.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      records.push({
        name,
        category: resolveCategory(row),
        phone,
        email,
        website,
        rating: toNumber(row['Rating']),
        reviews: toNumber(row['Reviews']),
        address: resolveAddress(row),
        postcode: isBlank(row['Postcode']) ? '' : String(row['Postcode']).trim(),
        suburb: isBlank(row['Comune']) ? '' : String(row['Comune']).trim(),
        province: isBlank(row['Province']) ? '' : String(row['Province']).trim(),
        country: isBlank(row['Country Code']) ? '' : String(row['Country Code']).trim(),
        distance: toNumber(row['Distance From Center (km)']),
        scrapeStatus: isBlank(row['Scrape Status']) ? '' : String(row['Scrape Status']).trim(),
        domain: isBlank(row['Website Domain']) ? '' : String(row['Website Domain']).trim(),
        facebook: isBlank(row['Facebook']) ? '' : String(row['Facebook']).trim(),
        instagram: isBlank(row['Instagram']) ? '' : String(row['Instagram']).trim(),
        linkedin: isBlank(row['LinkedIn']) ? '' : String(row['LinkedIn']).trim(),
        gmaps: isBlank(row['Google Maps URL']) ? '' : String(row['Google Maps URL']).trim(),
        openStatus: isBlank(row['Open Status (Full)']) ? '' : String(row['Open Status (Full)']).trim(),
        hours: isBlank(row['Hours Weekly']) ? '' : String(row['Hours Weekly']).trim(),
        snippet: isBlank(row['Review Snippet']) ? '' : String(row['Review Snippet']).trim(),
        scrapedAt: isBlank(row['Scraped At']) ? '' : String(row['Scraped At']).trim(),
      });
    }

    records.sort((a,b) => {
      const av = a.reviews === null ? -Infinity : a.reviews;
      const bv = b.reviews === null ? -Infinity : b.reviews;
      return bv - av;
    });

    return records;
  }

  // Fuzzy duplicate pass: a record sharing a phone, an individual email, or a
  // website domain with an already-kept (higher-review) record is pulled out
  // into `duplicates` instead of appearing in the four main tabs.
  function splitOutDuplicates(records){
    const phoneOwner = new Map();
    const emailOwner = new Map();
    const domainOwner = new Map();
    const kept = [];
    const duplicates = [];

    for (const r of records){
      const normPhone = normalizePhone(r.phone);
      const emails = splitEmails(r.email).map(e => e.toLowerCase());
      const domain = extractDomain(r.website);

      const matchedOn = [];
      let originalName = '';

      if (normPhone && phoneOwner.has(normPhone)){
        matchedOn.push('Phone');
        originalName = phoneOwner.get(normPhone);
      }
      for (const e of emails){
        if (emailOwner.has(e)){
          matchedOn.push('Email');
          originalName = originalName || emailOwner.get(e);
        }
      }
      if (domain && domainOwner.has(domain)){
        matchedOn.push('Website Domain');
        originalName = originalName || domainOwner.get(domain);
      }

      if (matchedOn.length > 0){
        duplicates.push(Object.assign({}, r, {
          duplicateOf: originalName,
          matchedOn: Array.from(new Set(matchedOn)).join(', '),
        }));
        continue;
      }

      kept.push(r);
      if (normPhone) phoneOwner.set(normPhone, r.name);
      for (const e of emails) emailOwner.set(e, r.name);
      if (domain) domainOwner.set(domain, r.name);
    }

    return { kept, duplicates };
  }

  // Exhaustive, mutually-exclusive 4-way split of the kept (non-duplicate) records.
  function partitionLeads(records){
    const noWebsite = records.filter(r => r.website === '');
    const withWebsite = records.filter(r => r.website !== '');
    const needsFollowUp = withWebsite.filter(r => r.email === '');
    const withWebsiteAndEmail = withWebsite.filter(r => r.email !== '');
    const ownerLeads = withWebsiteAndEmail.filter(r => hasOwnerEmail(r.email));
    const generalLeads = withWebsiteAndEmail.filter(r => !hasOwnerEmail(r.email));
    return { noWebsite, needsFollowUp, ownerLeads, generalLeads };
  }

  function topCounts(records, field, limit){
    const counts = new Map();
    for (const r of records){
      const v = isBlank(r[field]) ? 'Unknown' : r[field];
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const arr = Array.from(counts.entries()).map(([name,count]) => ({ name, count }));
    arr.sort((a,b) => b.count - a.count);
    return limit ? arr.slice(0, limit) : arr;
  }

  function numberToLetter(num){
    let s = '';
    while (num > 0){
      const rem = (num - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      num = Math.floor((num - 1) / 26);
    }
    return s;
  }

  /* ---------- workbook building (ExcelJS) ---------- */

  function addDataSheet(workbook, sheetName, records, tableName, theme, tabColorArgb, columns){
    columns = columns || DATA_COLUMNS;
    const ws = workbook.addWorksheet(sheetName, { views: [{ state:'frozen', ySplit:1 }] });
    if (tabColorArgb) ws.properties.tabColor = { argb: tabColorArgb };

    const rows = records.map(r => columns.map(c => (r[c.key] === undefined ? '' : r[c.key])));
    const safeRows = rows.length ? rows : [columns.map(() => '')];

    ws.addTable({
      name: tableName,
      ref: 'A1',
      headerRow: true,
      style: { theme, showRowStripes: true },
      columns: columns.map(c => ({ name: c.header, filterButton: true })),
      rows: safeRows,
    });

    columns.forEach((c,i) => { ws.getColumn(i+1).width = c.width; });

    ws.getRow(1).eachCell(cell => {
      cell.font = { name:'Arial', bold:true, size:10, color: cell.font ? cell.font.color : undefined };
      cell.alignment = { vertical:'middle', wrapText:true };
    });

    const lastDataRow = safeRows.length + 1;
    for (let r=2; r<=lastDataRow; r++){
      ws.getRow(r).eachCell(cell => {
        cell.font = Object.assign({}, cell.font, { name:'Arial', size:10 });
      });
    }

    const numFmtByHeader = {
      'Rating': '0.0',
      'Reviews': '#,##0',
      'Distance From Center (km)': '0.0',
    };
    columns.forEach((c,i) => {
      const fmt = numFmtByHeader[c.header];
      if (!fmt) return;
      const colLetter = numberToLetter(i+1);
      for (let r=2; r<=lastDataRow; r++){
        ws.getCell(`${colLetter}${r}`).numFmt = fmt;
      }
    });

    if (records.length > 0){
      const ratingColIndex = columns.findIndex(c => c.header === 'Rating') + 1;
      if (ratingColIndex > 0){
        const ratingColLetter = numberToLetter(ratingColIndex);
        ws.addConditionalFormatting({
          ref: `${ratingColLetter}2:${ratingColLetter}${lastDataRow}`,
          rules: [{
            type:'cellIs',
            operator:'lessThan',
            formulae:[4],
            style:{ fill:{ type:'pattern', pattern:'solid', bgColor:{ argb:'FFFCE4E4' } } },
          }],
        });
      }
    }

    return ws;
  }

  function addDashboard(workbook, stats, categoryCounts, statusCounts){
    const ws = workbook.addWorksheet('Dashboard', { views: [{ showGridLines:false }] });
    ws.getColumn(1).width = 3;
    for (let c=2; c<=9; c++) ws.getColumn(c).width = 22;

    ws.getCell('B2').value = 'Lead List — Overview';
    ws.getCell('B2').font = { name:'Arial', bold:true, size:18, color:{ argb:'FF2E7D5B' } };
    ws.getCell('B3').value = 'Generated locally in your browser from the uploaded CSV — no data left your machine.';
    ws.getCell('B3').font = { name:'Arial', italic:true, size:10, color:{ argb:'FF808080' } };

    const metricsRows = [
      ['Total Businesses (after exact-duplicate removal)', stats.total],
      ['Duplicate Leads Found (moved to separate tab)', stats.duplicateCount],
      ['Unique Businesses', stats.uniqueTotal],
      ['No Website', stats.noWebsiteCount],
      ['Needs Follow-Up (website, no email)', stats.needsFollowUpCount],
      ['Owner Leads (personal email)', stats.ownerLeadsCount],
      ['General Leads (generic email)', stats.generalLeadsCount],
      ['Average Rating', stats.avgRating !== null ? Math.round(stats.avgRating*100)/100 : 'N/A'],
    ];
    const metricsStartRow = 5;
    ws.addTable({
      name:'MetricsTbl',
      ref:`B${metricsStartRow}`,
      headerRow:true,
      style:{ theme:'TableStyleMedium2', showRowStripes:true },
      columns:[{ name:'Metric' }, { name:'Value' }],
      rows: metricsRows,
    });
    ws.getColumn(2).width = 42;
    ws.getColumn(3).width = 14;

    const catStartRow = metricsStartRow + metricsRows.length + 3;
    ws.getCell(`B${catStartRow}`).value = 'Top Categories';
    ws.getCell(`B${catStartRow}`).font = { name:'Arial', bold:true, size:12, color:{ argb:'FF2E7D5B' } };
    if (categoryCounts.length){
      ws.addTable({
        name:'CategoryTbl',
        ref:`B${catStartRow+1}`,
        headerRow:true,
        style:{ theme:'TableStyleMedium9', showRowStripes:true },
        columns:[{ name:'Category' }, { name:'Count' }],
        rows: categoryCounts.map(c => [c.name, c.count]),
      });
    }

    ws.getCell('F5').value = 'Scrape Status Breakdown';
    ws.getCell('F5').font = { name:'Arial', bold:true, size:12, color:{ argb:'FF2E7D5B' } };
    if (statusCounts.length){
      ws.addTable({
        name:'StatusTbl',
        ref:'F6',
        headerRow:true,
        style:{ theme:'TableStyleMedium6', showRowStripes:true },
        columns:[{ name:'Status' }, { name:'Count' }],
        rows: statusCounts.map(s => [s.name, s.count]),
      });
    }
    ws.getColumn(6).width = 26;
    ws.getColumn(7).width = 12;
  }

  async function buildWorkbook(ExcelJSRef, rawRows){
    const allRecords = buildRecords(rawRows);
    const { kept, duplicates } = splitOutDuplicates(allRecords);
    const { noWebsite, needsFollowUp, ownerLeads, generalLeads } = partitionLeads(kept);

    const workbook = new ExcelJSRef.Workbook();
    workbook.creator = 'CSV to Excel Ledger';
    workbook.created = new Date();

    const ratings = kept.map(r => r.rating).filter(r => r !== null);
    const avgRating = ratings.length ? ratings.reduce((a,b)=>a+b,0) / ratings.length : null;
    const successScraped = kept.filter(r => r.scrapeStatus === 'success').length;

    const stats = {
      total: allRecords.length,
      duplicateCount: duplicates.length,
      uniqueTotal: kept.length,
      noWebsiteCount: noWebsite.length,
      needsFollowUpCount: needsFollowUp.length,
      ownerLeadsCount: ownerLeads.length,
      generalLeadsCount: generalLeads.length,
      avgRating,
      successScraped,
    };

    const categoryCounts = topCounts(kept, 'category', 10);
    const statusCounts = topCounts(kept, 'scrapeStatus', 10);

    addDashboard(workbook, stats, categoryCounts, statusCounts);
    addDataSheet(workbook, 'General Leads', generalLeads, 'GeneralLeadsTbl', 'TableStyleMedium2', 'FF2E7D5B');
    addDataSheet(workbook, 'Needs Follow-Up', needsFollowUp, 'FollowUpTbl', 'TableStyleMedium9', 'FFD6A94A');
    addDataSheet(workbook, 'No Website', noWebsite, 'NoWebsiteTbl', 'TableStyleMedium6', 'FFB5502F');
    addDataSheet(workbook, 'Owner Leads', ownerLeads, 'OwnerLeadsTbl', 'TableStyleMedium4', 'FF3C8A66');
    addDataSheet(workbook, 'Duplicate Leads', duplicates, 'DuplicateLeadsTbl', 'TableStyleMedium11', 'FF8A6FBF', DUPLICATE_COLUMNS);

    return { workbook, stats, kept, duplicates, noWebsite, needsFollowUp, ownerLeads, generalLeads, categoryCounts, statusCounts };
  }

  async function downloadWorkbook(workbook, filename){
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function sanitizeFilename(name) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|]+/g, '').trim();
    return cleaned || 'ghost_map_ledger';
  }

  /**
   * Parse Ghost Map CSV text and download the filtered multi-sheet workbook.
   * @param {string} csvText
   * @param {string} [filenameBase]
   * @returns {Promise<{stats: object}>}
   */
  async function buildAndDownloadXlsx(csvText, filenameBase) {
    if (typeof Papa === 'undefined' || typeof ExcelJS === 'undefined') {
      throw new Error('Ledger export libraries not loaded (PapaParse / ExcelJS)');
    }
    const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
    const parsed = Papa.parse(cleanText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim()
    });
    if (!parsed.data || !parsed.data.length) {
      throw new Error('This export has no data rows.');
    }
    const preCheck = buildRecords(parsed.data);
    if (!preCheck.length) {
      throw new Error('Could not find a business-name column (Title / Business Name / Name).');
    }
    const { workbook, stats } = await buildWorkbook(ExcelJS, parsed.data);
    const base = sanitizeFilename(String(filenameBase || 'ghost_map_ledger').replace(/\.xlsx$/i, ''));
    await downloadWorkbook(workbook, base + '.xlsx');
    return { stats };
  }

  global.GhostMapLedger = { buildAndDownloadXlsx, buildWorkbook, buildRecords };
})(typeof window !== 'undefined' ? window : globalThis);
