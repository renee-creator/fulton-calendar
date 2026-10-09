// Fulton Calendar server
// Runs on Render. Signs educators in with personal passcodes, reads the school's Google calendars
// (reading only, nothing is ever sent back to Google), and keeps space sign-ups and settings as
// files in a private GitHub repository. Every failure returns a clear message.
//
// Render settings (Environment)
//   TEACHER_PASSCODES   Name=passcode pairs separated by commas, like  Hannah=maple garden 42,Chris=river stone 7
//   GITHUB_TOKEN        fine-grained token with Contents read and write on the records repository only
//   RECORDS_REPO        owner/name of the private records repository (default renee-creator/fulton-calendar-records)
//   DIRECTOR_NAMES      names from TEACHER_PASSCODES who may change settings and any sign-up, like  Renee
//   SCHOOL_TIMEZONE     optional, default America/Los_Angeles
//   ALLOWED_ORIGINS     extra websites allowed to use this server, separated by commas (optional)
//
// Open this service's address in a browser to see a status page. The calendar itself is at /app/

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const pathLib = require('path');
const ICAL = require('./vendor/ical.cjs');
const Core = require('./core.js');
const { fail, text } = Core;

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 256 * 1024;
const FLUSH_DELAY_MS = Number(process.env.FLUSH_DELAY_MS) || 4000;   // quick changes are gathered into one GitHub save
const FEED_TTL_MS = Number(process.env.FEED_TTL_MS) || 10 * 60 * 1000;
const FEED_MAX_BYTES = 8 * 1024 * 1024;
const RECORDS_REPO = (process.env.RECORDS_REPO || 'renee-creator/fulton-calendar-records').trim();
const GITHUB_API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const SCHOOL_TZ = (() => { const z = (process.env.SCHOOL_TIMEZONE || 'America/Los_Angeles').trim(); try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch (e) { return 'America/Los_Angeles'; } })();
const FEED_TEST_BASE = (process.env.FEED_TEST_BASE || '').replace(/\/+$/, '');   // only for the automated tests

/* ---------- helpers ---------- */
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});   // a closed log pipe must never stop or spin the server
function cleanKey(raw) { return String(raw || '').replace(/[\s"'​-‍﻿]/g, ''); }
function githubToken() { return cleanKey(process.env.GITHUB_TOKEN); }
const wallFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function wallParts(date, fmt) { const o = {}; for (const p of (fmt || wallFmt).formatToParts(date)) o[p.type] = p.value; return o; }
function schoolWall(date) { const o = wallParts(date); return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`; }
function schoolToday() { return schoolWall(new Date()).slice(0, 10); }
const pad = (n, w) => String(n).padStart(w || 2, '0');

/* ---------- educator passcodes and sessions ---------- */
function normCode(s) { return String(s == null ? '' : s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }
const PASS_RAW = String(process.env.TEACHER_PASSCODES || process.env.SCHOOL_PASSCODES || '');
const TEACHERS = PASS_RAW.split(',').map(e => e.trim()).filter(Boolean).map(e => {
  const cut = e.indexOf('=');
  const name = cut > 0 ? e.slice(0, cut).trim() : '';
  const code = normCode(cut > 0 ? e.slice(cut + 1) : e);
  return { name: /^[A-Za-z0-9 _.&'-]{1,40}$/.test(name) ? name : (cut > 0 ? '' : 'Staff'), code, hash: sha(code) };
}).filter(t => t.name && t.code.length >= 6);
const DIRECTORS = String(process.env.DIRECTOR_NAMES || 'Renee').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isDirector(name) { return DIRECTORS.includes(String(name || '').toLowerCase()); }
const SKIPPED_PASSCODES = PASS_RAW.split(',').filter(e => e.trim()).length - TEACHERS.length;
const SECRET = sha('fulton-calendar|' + (process.env.SESSION_SECRET || '') + '|' + githubToken() + '|' + PASS_RAW);
const SESSION_DAYS = 60;

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sign(body) { return b64u(crypto.createHmac('sha256', SECRET).update(body).digest()); }
function makeSession(name) { const body = b64u(JSON.stringify({ n: name, e: Date.now() + SESSION_DAYS * 864e5 })); return body + '.' + sign(body); }
function checkSession(tok) {
  if (!tok || tok.length > 600) return null;
  const [body, mac] = tok.split('.');
  if (!body || !mac) return null;
  const want = sign(body);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  let s; try { s = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
  if (!s || typeof s.n !== 'string' || !(s.e > Date.now())) return null;
  if (!TEACHERS.some(t => t.name === s.n)) return null;   // an educator removed on Render is signed out
  return { name: s.n, director: isDirector(s.n), shared: s.n === 'Staff' };   // Staff is the name given to a passcode shared by several educators
}
function readSession(req) { const h = String(req.headers.authorization || ''); return checkSession(h.startsWith('Bearer ') ? h.slice(7).trim() : ''); }
function matchPasscode(given) {
  if (typeof given !== 'string' || !given || given.length > 200) return null;
  const h = sha(normCode(given));
  let hit = null;
  for (const t of TEACHERS) if (crypto.timingSafeEqual(h, t.hash)) hit = t;
  return hit;
}
const wrongTries = new Map(); let wrongAll = [];
// Render adds the visitor's real address as the last entry, and earlier entries can be made up by the sender
function who(req) { const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return parts[parts.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown'; }
function blocked(ip) { const now = Date.now(); wrongAll = wrongAll.filter(t => t > now - 600000); if (wrongAll.length >= 60) return true; const t = wrongTries.get(ip); return !!t && t.until > now && t.count >= 10; }
function noteWrong(ip) { const now = Date.now(); wrongAll.push(now); if (wrongTries.size > 5000) for (const [k, v] of wrongTries) if (v.until <= now) wrongTries.delete(k); const t = wrongTries.get(ip); if (!t || t.until <= now) wrongTries.set(ip, { count: 1, until: now + 600000 }); else t.count++; }

/* ---------- GitHub storage ---------- */
function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GITHUB_API + path);
    const data = body ? JSON.stringify(body) : null;
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request({ method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers: {
      'Authorization': 'Bearer ' + githubToken(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fulton-calendar', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, json, text: t, headers: res.headers }); });
      res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}
const PROGRAM_PATH = 'settings/program.json', FEEDS_PATH = 'settings/feeds.json';
const store = { ready: false, error: '', branch: 'main', shas: new Map(), saveError: '' };
let core = null;                 // spaces, settings and sign-ups, made once records are loaded
let feedAddresses = {};          // calendar id to its Google address. Never sent to a browser.
const lastBy = new Map();
const KEY_NO_WRITE = 'GitHub will not let the access key save changes. On GitHub, edit the Calendar records token and set Contents to Read and write.';
const KEY_PROBLEM = 'GitHub rejected the access key, so changes cannot be saved. The GitHub token on Render has probably expired. Renew it on GitHub and paste the new one into GITHUB_TOKEN on Render.';
const SAVE_WAIT = 'Changes are taking longer than usual to reach GitHub. They are kept on the server and saving keeps trying, so keep working.';
function isRateLimit(r) { return r.status === 429 || (r.status === 403 && (/rate limit|abuse/i.test((r.json && r.json.message) || '') || !!(r.headers && (r.headers['retry-after'] || r.headers['x-ratelimit-remaining'] === '0')))); }
let rev = 0; const BOOT_ID = crypto.randomBytes(6).toString('hex');
const newId = () => crypto.randomBytes(5).toString('hex');

let loading = null;
function loadAll() { if (!loading) loading = doLoad().finally(() => { loading = null; if (!store.ready && githubToken()) setTimeout(loadAll, 60000).unref(); }); return loading; }
async function doLoad() {
  if (!githubToken()) { store.error = 'No GITHUB_TOKEN is saved on Render. Add it under Environment.'; log(store.error); return; }
  try {
    const repo = await gh('GET', `/repos/${RECORDS_REPO}`);
    if (repo.status === 404) throw new Error(`The records repository ${RECORDS_REPO} was not found, or the GitHub token cannot see it. Check RECORDS_REPO and give the token access to that repository.`);
    if (repo.status === 401) throw new Error('GitHub rejected the token. Make a new fine-grained token with Contents read and write on the records repository.');
    if (repo.status !== 200) throw new Error('GitHub answered ' + repo.status + ' when opening the records repository.');
    store.branch = repo.json.default_branch || 'main';
    const tree = await gh('GET', `/repos/${RECORDS_REPO}/git/trees/${encodeURIComponent(store.branch)}?recursive=1`);
    let files = [];
    if (tree.status === 200) files = (tree.json.tree || []).filter(t => t.type === 'blob');
    else if (tree.status !== 409 && tree.status !== 404) throw new Error('GitHub answered ' + tree.status + ' when listing records.');   // 409 and 404 mean the repository is still empty
    const docs = new Map(); const jobs = files.filter(f => f.path === PROGRAM_PATH || f.path === FEEDS_PATH || /^bookings\/\d{4}-\d{2}\.json$/.test(f.path));
    let i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const j = jobs[i++];
        const b = await gh('GET', `/repos/${RECORDS_REPO}/git/blobs/${j.sha}`);
        if (b.status !== 200) throw new Error('GitHub answered ' + b.status + ' when reading ' + j.path);
        store.shas.set(j.path, j.sha);
        try { docs.set(j.path, JSON.parse(Buffer.from(b.json.content, 'base64').toString('utf8'))); } catch (e) { log('Skipped unreadable record', j.path); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const bookings = [];
    for (const [p, d] of docs) if (p.startsWith('bookings/') && d && d.items) for (const b of Object.values(d.items)) bookings.push(b);
    const f = docs.get(FEEDS_PATH); feedAddresses = {};
    if (f && f.addresses && typeof f.addresses === 'object') for (const [k, v] of Object.entries(f.addresses)) if (typeof v === 'string' && v) feedAddresses[k] = v;
    core = Core.createCore({ program: docs.get(PROGRAM_PATH), bookings, newId, today: schoolToday,
      onBooking: (month, by) => { rev++; lastBy.set(`bookings/${month}.json`, by); scheduleSave(`bookings/${month}.json`); },
      onProgram: (by, goneCalendars) => { rev++; lastBy.set(PROGRAM_PATH, by); scheduleSave(PROGRAM_PATH); let changed = false; for (const id of goneCalendars || []) if (feedAddresses[id]) { delete feedAddresses[id]; feeds.delete(id); changed = true; } if (changed) { lastBy.set(FEEDS_PATH, by); scheduleSave(FEEDS_PATH); } } });
    store.ready = true; store.error = '';
    log(`Loaded ${core.count()} sign-ups, ${core.program.spaces.length} spaces, ${Object.keys(feedAddresses).length} calendar addresses`);
  } catch (e) { store.error = e.message; log('Could not load records.', e.message); }
}
function docFor(path) {
  if (path === PROGRAM_PATH) return core.program;
  if (path === FEEDS_PATH) return { note: 'Addresses of the Google calendars shown in Fulton Calendar. Keep this file private.', addresses: feedAddresses };
  const m = path.match(/^bookings\/(\d{4}-\d{2})\.json$/);
  const items = {}; for (const b of core.view(m[1] + '-01', m[1] + '-31').sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start)) items[b.id] = b;
  return { month: m[1], items };
}

// Saving to GitHub. Each file is saved by one chain at a time, and quick changes are gathered.
const chains = new Map(); const timers = new Map(); const dirtyPaths = new Set(); const failingSince = new Map();
let stopping = false;
function saveWarn() { const now = Date.now(); for (const t of failingSince.values()) if (now - t > 90000) return SAVE_WAIT; return ''; }
function scheduleSave(path) { dirtyPaths.add(path); clearTimeout(timers.get(path)); timers.set(path, setTimeout(() => flushPath(path), FLUSH_DELAY_MS)); }
function flushPath(path) {
  clearTimeout(timers.get(path)); timers.delete(path);
  if (!dirtyPaths.has(path)) return chains.get(path) || Promise.resolve();
  dirtyPaths.delete(path);
  const run = (chains.get(path) || Promise.resolve()).then(() => writeFile(path)).then(() => { failingSince.delete(path); }, e => {
    log('Save failed', path, e.message); if (!failingSince.has(path)) failingSince.set(path, Date.now());
    dirtyPaths.add(path);
    if (!stopping) { clearTimeout(timers.get(path)); timers.set(path, setTimeout(() => flushPath(path), 30000)); } });
  chains.set(path, run);
  return run;
}
async function flushEverything() { await Promise.all([...dirtyPaths].map(flushPath)); await Promise.all([...chains.values()]); return dirtyPaths.size === 0; }
async function currentSha(path) { const r = await gh('GET', `/repos/${RECORDS_REPO}/contents/${path}?ref=${encodeURIComponent(store.branch)}`); return r.status === 200 ? r.json.sha : null; }
async function writeFile(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = Buffer.from(JSON.stringify(docFor(path), null, 2) + '\n', 'utf8').toString('base64');
    const by = lastBy.get(path) ? ` by ${lastBy.get(path)}` : '';
    const label = path === PROGRAM_PATH ? 'Update settings' : path === FEEDS_PATH ? 'Update calendar addresses' : 'Update sign-ups for ' + path.slice(9, 16);
    const known = store.shas.get(path);
    const r = await gh('PUT', `/repos/${RECORDS_REPO}/contents/${path}`, { message: label + by, content, branch: store.branch, ...(known ? { sha: known } : {}) });
    if (r.status === 200 || r.status === 201) { store.shas.set(path, r.json.content.sha); store.saveError = ''; return; }
    if (r.status === 409 || r.status === 422) { const s = await currentSha(path); if (s) store.shas.set(path, s); else store.shas.delete(path); continue; }   // changed on GitHub directly, keep the app's copy
    if (isRateLimit(r)) { log('GitHub asked to slow down'); throw new Error('GitHub rate limit, trying again shortly'); }
    if (r.status === 401) { store.saveError = KEY_PROBLEM; log('GitHub rejected the token'); }
    if (r.status === 403) { store.saveError = KEY_NO_WRITE; log('GitHub key cannot write'); }
    throw new Error('GitHub answered ' + r.status + ' ' + ((r.json && r.json.message) || ''));
  }
  throw new Error('GitHub kept refusing the save');
}
async function probeKey() {
  if (!store.saveError || !store.ready) return;
  try {
    const path = 'server-check.json'; const sha0 = await currentSha(path);
    const r = await gh('PUT', `/repos/${RECORDS_REPO}/contents/${path}`, { message: 'Check that saving works again', content: Buffer.from(JSON.stringify({ checkedAt: new Date().toISOString() }) + '\n').toString('base64'), branch: store.branch, ...(sha0 ? { sha: sha0 } : {}) });
    if (r.status === 200 || r.status === 201) { store.saveError = ''; log('Saving to GitHub works again'); for (const p of [...dirtyPaths]) flushPath(p); }
  } catch (e) {}
}
setInterval(probeKey, 120000).unref();

/* ---------- Google calendars, read only ---------- */
const NOT_GOOGLE = 'Only Google Calendar and SignUpGenius addresses can be connected. For a Google calendar, open its Settings and sharing page and copy the Secret address in iCal format. For SignUpGenius, open the calendar feed, choose Calendar Help, and copy the webcal link.';
const isGenius = host => /(^|\.)signupgenius\.com$/i.test(host);
function publicAddress(calendarId) { return 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(calendarId) + '/public/basic.ics'; }
// Accepts the secret or public iCal address, a calendar ID, or an embed or share link, and returns the address to read
function normalizeFeed(raw) {
  let s = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!s) return '';
  if (s.length > 600) throw fail(400, NOT_GOOGLE);
  s = s.replace(/^webcals?:\/\//i, 'https://');
  if (/^[^\s\/@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return publicAddress(s);
  let u; try { u = new URL(s); } catch (e) { throw fail(400, NOT_GOOGLE); }
  if (FEED_TEST_BASE && s.startsWith(FEED_TEST_BASE + '/')) return s;
  if (u.protocol === 'https:' && isGenius(u.hostname) && !u.username && !u.port) return u.href;   // a SignUpGenius calendar feed, read the same way
  if (u.protocol !== 'https:' || !/^(calendar\.google\.com|www\.google\.com)$/i.test(u.hostname)) throw fail(400, NOT_GOOGLE);
  const m = u.pathname.match(/^\/calendar\/ical\/([^/]+)\/(public|private-[a-z0-9]+)\/(basic|full)\.ics$/i);
  if (m) return 'https://calendar.google.com' + u.pathname;
  let id = u.searchParams.get('src') || u.searchParams.get('cid') || '';
  if (id && !id.includes('@')) { try { const d = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); if (/^[\x20-\x7e]+@[\x20-\x7e]+$/.test(d)) id = d; } catch (e) {} }
  if (/^[^\s\/@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(id)) return publicAddress(id);
  throw fail(400, NOT_GOOGLE);
}
function okFeedHost(u) { return (u.protocol === 'https:' && (/(^|\.)(google\.com|googleusercontent\.com)$/i.test(u.hostname) || isGenius(u.hostname))) || (!!FEED_TEST_BASE && u.href.startsWith(FEED_TEST_BASE + '/')); }
function fetchText(address, hops) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(address); } catch (e) { reject(new Error('bad address')); return; }
    if (!okFeedHost(u)) { reject(new Error('The calendar address pointed somewhere other than Google or SignUpGenius.')); return; }
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'User-Agent': 'fulton-calendar', 'Accept': 'text/calendar, text/plain' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if ((hops || 0) >= 3) { reject(new Error('The calendar address redirected too many times.')); return; }
        let next; try { next = new URL(res.headers.location, u).href; } catch (e) { reject(new Error('bad redirect')); return; }
        fetchText(next, (hops || 0) + 1).then(resolve, reject); return;
      }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > FEED_MAX_BYTES) { req.destroy(new Error('That calendar is too large to load.')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('The calendar did not answer in time.')));
    req.on('error', reject);
  });
}
function stripHtml(s) { return String(s || '').replace(/<br\s*\/?>(\r?\n)?/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]{0,400}>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function longText(v, max) { return stripHtml(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
function parseFeed(body) {
  if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 2000))) throw new Error('not a calendar');
  const comp = new ICAL.Component(ICAL.parse(body));
  for (const tz of comp.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(tz); } catch (e) {} }
  const all = comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v));
  const masters = new Map(); const events = [];
  for (const e of all) if (!e.isRecurrenceException()) { masters.set(e.uid, e); events.push(e); }
  for (const e of all) if (e.isRecurrenceException()) { const m = masters.get(e.uid); if (m) { try { m.relateException(e); } catch (x) {} } else events.push(e); }
  return { name: text(comp.getFirstPropertyValue('x-wr-calname'), 60), events };
}
// A time from the feed, as the date and clock time people at the school would see
function wall(t) {
  if (t.isDate) return { allDay: true, day: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}` };
  const asIs = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
  const tzid = t.zone && t.zone.tzid;
  if (!tzid || tzid === 'floating') return { allDay: false, at: asIs, day: asIs.slice(0, 10) };
  const at = schoolWall(t.toJSDate());
  return { allDay: false, at, day: at.slice(0, 10) };
}
function occurrence(calId, item, start, end, from, to) {
  if (!start) return null;
  const s = wall(start); const e = end ? wall(end) : s;
  let out;
  if (s.allDay) {
    let last = e.allDay && e.day > s.day ? Core.addDays(e.day, -1) : s.day;   // the feed's end date is the day after the last day
    out = { allDay: true, start: s.day, end: last };
  } else {
    let endAt = e.allDay ? s.at : e.at; if (endAt < s.at) endAt = s.at;
    out = { allDay: false, start: s.at, end: endAt };
  }
  if (out.start.slice(0, 10) > to || out.end.slice(0, 10) < from) return null;
  const c = item.component;
  out.id = calId + '.' + crypto.createHash('sha1').update(String(item.uid) + '|' + out.start).digest('hex').slice(0, 12);
  out.cal = calId; out.title = text(item.summary, 140) || 'Busy';
  const loc = text(item.location, 200); if (loc) out.location = loc;
  const desc = longText(item.description, 800); if (desc) out.desc = desc;
  if (String(c.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return null;
  return out;
}
function expand(calId, parsed, from, to) {
  const out = [];
  for (const e of parsed.events) {
    try {
      if (!e.isRecurring()) { const o = occurrence(calId, e, e.startDate, e.endDate, from, to); if (o) out.push(o); continue; }
      const it = e.iterator(); let next, guard = 0;
      while (guard++ < 4000 && (next = it.next())) {
        const d = e.getOccurrenceDetails(next);
        const startDay = wall(d.startDate).day;
        if (startDay > to) break;
        const o = occurrence(calId, d.item, d.startDate, d.endDate, from, to); if (o) out.push(o);
      }
    } catch (x) { /* one unreadable event should not hide the rest */ }
  }
  return out;
}
// A calendar still carrying a starter name takes the name Google gives it. A name the director typed is left alone.
const STARTER_NAMES = new Set(['School calendar', 'Second calendar', 'Calendar', 'New calendar']);
function adoptName(calId, name) {
  if (!name || !core) return;
  const p = core.program; const cal = p.calendars.find(c => c.id === calId);
  if (!cal || !STARTER_NAMES.has(cal.name) || p.calendars.some(c => c.name === name)) return;
  try { core.setProgram({ director: true, name: 'the server' }, Object.assign({}, p, { calendars: p.calendars.map(c => c.id === calId ? Object.assign({}, c, { name }) : c) })); log('Calendar', calId, 'named from Google'); } catch (e) {}
}
const feeds = new Map();   // calendar id to { address, fetchedAt, parsed, error, hash, running }
let feedRev = 0;
function feedError(status, address) {
  let genius = false; try { genius = isGenius(new URL(address).hostname); } catch (e) {}
  if (genius) return status === 404 || status === 403 || status === 401 ? 'SignUpGenius would not share this calendar feed. Open the feed in SignUpGenius, choose Calendar Help, copy the webcal link again and paste it here.' : 'SignUpGenius answered ' + status + ' for this calendar feed. It will be tried again shortly.';
  if (status === 404 || status === 403 || status === 401) return 'Google would not share this calendar. Paste the Secret address in iCal format from the calendar\'s Settings and sharing page, or make the calendar public.';
  return 'Google answered ' + status + ' for this calendar. It will be tried again shortly.';
}
function loadFeed(calId) {
  const address = feedAddresses[calId]; if (!address) { feeds.delete(calId); return Promise.resolve(null); }
  let f = feeds.get(calId);
  if (!f || f.address !== address) { f = { address, fetchedAt: 0, parsed: null, error: '', hash: '', running: null }; feeds.set(calId, f); }
  if (f.running) return f.running;
  f.running = (async () => {
    let error = '', parsed = null, hash = '';
    try {
      const r = await fetchText(address);
      if (r.status !== 200) error = feedError(r.status, address);
      else { hash = crypto.createHash('sha1').update(r.text).digest('hex'); if (hash === f.hash && f.parsed) parsed = f.parsed; else parsed = parseFeed(r.text); }
    } catch (e) { error = e.message === 'not a calendar' ? 'That address did not return a calendar. Copy the address again and paste it here.' : 'This calendar could not be read just now. ' + (e.message || ''); }
    if (feeds.get(calId) !== f) return f;   // disconnected or replaced while loading
    const before = f.hash + '|' + f.error;
    f.fetchedAt = Date.now(); f.error = error;
    if (parsed) { if (hash !== f.hash) log('Calendar', calId, 'read,', parsed.events.length, 'entries'); f.parsed = parsed; f.hash = hash; adoptName(calId, parsed.name); }
    if (f.hash + '|' + f.error !== before) { feedRev++; viewCache.clear(); }
    if (error) log('Calendar', calId, 'problem.', error);
    return f;
  })().finally(() => { f.running = null; });
  return f.running;
}
const viewCache = new Map();
async function eventsFor(from, to) {
  const out = []; const status = {};
  await Promise.all(core.program.calendars.map(async c => {
    if (!feedAddresses[c.id]) { status[c.id] = { connected: false }; return; }
    let f = feeds.get(c.id);
    if (!f || f.address !== feedAddresses[c.id] || (!f.parsed && !f.error)) f = await Promise.race([loadFeed(c.id), new Promise(r => setTimeout(() => r(feeds.get(c.id)), 12000))]);
    else if (Date.now() - f.fetchedAt > (f.error ? 60000 : FEED_TTL_MS)) loadFeed(c.id);   // refresh in the background, show what is known now
    status[c.id] = { connected: true, ok: !!(f && f.parsed && !f.error), error: (f && f.error) || undefined, loading: !f || (!f.parsed && !f.error) || undefined, readAt: (f && f.fetchedAt) || undefined };
    if (f && f.parsed) {
      const key = c.id + '|' + f.hash + '|' + from + '|' + to; let list = viewCache.get(key);
      if (!list) { list = expand(c.id, f.parsed, from, to); if (viewCache.size > 60) viewCache.clear(); viewCache.set(key, list); }
      out.push(...list);
    }
  }));
  return { events: out, status };
}

/* ---------- HTTP ---------- */
const ALLOWED_ORIGINS = ['https://renee-creator.github.io'].concat(String(process.env.ALLOWED_ORIGINS || '').split(',')).map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
function originOk(req) {
  const o = String(req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
  if (!o) return false;
  if (ALLOWED_ORIGINS.includes(o)) return true;
  const host = String(req.headers.host || '').toLowerCase();
  return !!host && (o === 'https://' + host || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && o === 'http://' + host));   // the copy of the page this server serves at /app/
}
function corsFor(req) {
  return originOk(req) ? { 'Access-Control-Allow-Origin': req.headers.origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } : {};
}
function send(req, res, status, headers, body) {
  try { if (res.headersSent) { res.end(); return; } res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, corsFor(req), headers)); res.end(body); }
  catch (e) { log('Could not send', e.message); }
}
function json(req, res, status, obj) { send(req, res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj)); }
function err(req, res, status, message) { json(req, res, status, { error: message }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function statusPage(req, res) {
  const connected = core ? core.program.calendars.filter(c => feedAddresses[c.id]).length : 0;
  const lines = [
    [store.ready, store.ready ? `Records are connected. ${core.count()} sign-ups and ${core.program.spaces.length} spaces are loaded from ${RECORDS_REPO}.` : (store.error || 'Records are still loading.')],
    [TEACHERS.length > 0, TEACHERS.length ? `${TEACHERS.length} educator passcodes are set. Director access for ${TEACHERS.filter(t => isDirector(t.name)).map(t => t.name).join(', ') || 'nobody yet, so set DIRECTOR_NAMES'}.` : 'No educator passcodes are set. Add TEACHER_PASSCODES under Environment, like Hannah=maple garden 42.'],
  ];
  if (store.ready) lines.push([connected > 0, connected ? `${connected} school ${connected === 1 ? 'calendar is' : 'calendars are'} connected for viewing.` : 'No school calendars are connected yet. The director adds them in the calendar\'s Settings.']);
  if (store.saveError) lines.unshift([false, store.saveError]);
  else if (saveWarn()) lines.unshift([false, saveWarn()]);
  if (SKIPPED_PASSCODES) lines.push([false, `${SKIPPED_PASSCODES} passcode entries were ignored. Each must be a passcode of at least 6 characters, or Name=passcode.`]);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fulton Calendar server status</title></head><body style="font-family:system-ui,sans-serif;font-size:18px;line-height:1.5;max-width:680px;margin:32px auto;padding:0 16px"><h1 style="font-size:22px">Fulton Calendar server</h1><p>The server is running.</p>' +
    lines.map(([ok, t]) => `<p style="font-weight:600;color:${ok ? '#1a7f37' : '#b42318'}">${ok ? 'WORKING.' : 'NEEDS ATTENTION.'} ${t}</p>`).join('') +
    (PAGE ? '<p><a href="/app/">Open the calendar</a></p>' : '') + '</body></html>';
  send(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
}
// The calendar page and its icons, served from this folder so the app also works at /app/
const STATIC = { 'favicon.svg': 'image/svg+xml', 'apple-touch-icon.png': 'image/png', 'icon-192.png': 'image/png', 'icon-512.png': 'image/png', 'icon-maskable-512.png': 'image/png', 'manifest.webmanifest': 'application/manifest+json' };
function readLocal(name) { try { return fs.readFileSync(pathLib.join(__dirname, name)); } catch (e) { return null; } }
const PAGE = readLocal('index.html');

function settingsFor(me) {
  const p = core.program;
  if (!me.director) return p;
  return Object.assign({}, p, { calendars: p.calendars.map(c => Object.assign({}, c, { hasAddress: !!feedAddresses[c.id], publicAddress: /\/public\/(basic|full)\.ics$/.test(feedAddresses[c.id] || '') })) });
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://x'); const path = url.pathname;
  if (req.method === 'OPTIONS') { send(req, res, 204, {}, undefined); return; }
  if (req.method === 'GET' && (path === '/' || path === '/status')) { statusPage(req, res); return; }
  if (req.method === 'GET' && path === '/health') { json(req, res, 200, { ok: true, ready: store.ready, error: store.error || undefined, bootId: BOOT_ID }); return; }
  if (req.method === 'GET' && path === '/app') { send(req, res, 302, { Location: '/app/' }, ''); return; }
  if (req.method === 'GET' && path.startsWith('/app/')) {
    const name = path.slice(5);
    if (name === '' || name === 'index.html') { if (PAGE) send(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, PAGE); else send(req, res, 404, { 'Content-Type': 'text/plain' }, 'Not found'); return; }
    const file = Object.prototype.hasOwnProperty.call(STATIC, name) ? readLocal(name) : null;
    if (file) send(req, res, 200, { 'Content-Type': STATIC[name], 'Cache-Control': 'public, max-age=86400' }, file); else send(req, res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    return;
  }
  if (req.method !== 'POST') { err(req, res, 405, 'Not allowed'); return; }
  if (!originOk(req)) { req.resume(); err(req, res, 403, 'This website is not allowed to use the Fulton Calendar server. Origin received ' + (String(req.headers.origin || '') || 'none') + '.'); return; }

  let body;
  try { body = await readBody(req); }
  catch (e) { err(req, res, e.message === 'too_big' ? 413 : 400, 'The request could not be read.'); return; }

  if (path === '/login') {
    const ip = who(req);
    if (blocked(ip)) { err(req, res, 429, 'Too many wrong passcodes. Wait ten minutes and try again.'); return; }
    if (!TEACHERS.length) { err(req, res, 503, 'No educator passcodes are set on the server yet.'); return; }
    const t = matchPasscode(body.passcode);
    if (!t) { noteWrong(ip); err(req, res, 403, 'That passcode is not right. Check with Renee if you have forgotten it.'); return; }
    log('Signed in', t.name);
    json(req, res, 200, { token: makeSession(t.name), name: t.name, director: isDirector(t.name), shared: t.name === 'Staff' });
    return;
  }

  const me = readSession(req);
  if (!me) { err(req, res, 401, 'Please sign in again.'); return; }
  if (!store.ready) { await loadAll(); if (!store.ready) { err(req, res, 503, store.error || 'Records are still loading. Try again in a moment.'); return; } }
  const writing = path !== '/api/view';
  if (writing && store.saveError) { err(req, res, 503, store.saveError + ' Your change was not saved.'); return; }
  if (writing && stopping) { err(req, res, 503, 'The server is restarting. Your change was not saved yet, so try again in a minute.'); return; }

  if (path === '/api/view') {
    const { from, to } = body;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || !Core.validDate(from) || !Core.validDate(to) || to < from || Core.dayNum(to) - Core.dayNum(from) > 100) { err(req, res, 400, 'That date range is not valid.'); return; }
    const ev = await eventsFor(from, to);
    const who = me.shared ? text(body.who, 40) : '';
    const stamp = [BOOT_ID, rev, feedRev, from, to, schoolToday(), crypto.createHash('sha1').update(who).digest('hex').slice(0, 8)].join('.');
    const base = { stamp, saveError: store.saveError || undefined, saveWarn: saveWarn() || undefined, calendarStatus: ev.status };
    if (body.stamp === stamp) { json(req, res, 200, Object.assign(base, { unchanged: true })); return; }
    json(req, res, 200, Object.assign(base, { me: me.name, director: me.director, today: schoolToday(), settings: settingsFor(me), bookings: core.view(from, to), events: ev.events, shared: me.shared || undefined, mine: me.shared ? (who ? core.mine(me.name, 8, who) : []) : core.mine(me.name, 8) }));
    return;
  }
  if (path === '/api/book') { json(req, res, 200, core.book(me, body)); return; }
  if (path === '/api/booking/update') { json(req, res, 200, core.update(me, String(body.id || ''), body.patch)); return; }
  if (path === '/api/booking/remove') { json(req, res, 200, core.remove(me, String(body.id || ''), body.scope)); return; }
  if (path === '/api/settings') { core.setProgram(me, body.program); json(req, res, 200, { settings: settingsFor(me) }); return; }
  if (path === '/api/calendar/connect') {
    if (!me.director) { err(req, res, 403, 'Only the director can connect calendars.'); return; }
    const cal = core.program.calendars.find(c => c.id === body.id);
    if (!cal) { err(req, res, 404, 'Save the settings first, then connect this calendar.'); return; }
    const address = normalizeFeed(body.address);
    if (!address) { delete feedAddresses[cal.id]; feeds.delete(cal.id); }
    else {
      const r = await fetchText(address).catch(e => ({ status: 0, message: e.message }));
      if (r.status !== 200) { err(req, res, 422, r.status ? feedError(r.status, address) : 'The calendar could not be reached just now. ' + (r.message || '') + ' Try again in a minute.'); return; }
      let parsed; try { parsed = parseFeed(r.text); } catch (e) { err(req, res, 422, 'That address did not return a calendar. Copy the address again and paste it here.'); return; }
      feedAddresses[cal.id] = address;
      feeds.set(cal.id, { address, fetchedAt: Date.now(), parsed, error: '', hash: crypto.createHash('sha1').update(r.text).digest('hex'), running: null });
      body.found = { name: parsed.name, events: parsed.events.length };
      adoptName(cal.id, parsed.name);
    }
    feedRev++; viewCache.clear(); lastBy.set(FEEDS_PATH, me.name); scheduleSave(FEEDS_PATH);
    json(req, res, 200, { settings: settingsFor(me), found: body.found || null });
    return;
  }
  if (path === '/api/calendar/refresh') {
    await Promise.all(core.program.calendars.map(c => { const f = feeds.get(c.id); return feedAddresses[c.id] && (!f || Date.now() - f.fetchedAt > 30000) ? loadFeed(c.id) : null; }));
    json(req, res, 200, { ok: true }); return;
  }
  if (path === '/api/save-now') { const ok = await flushEverything().catch(() => false); if (ok) json(req, res, 200, { ok: true }); else err(req, res, 502, 'Some changes have not reached GitHub yet. Saving keeps trying.'); return; }
  err(req, res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e && e.expose && e.status) { err(req, res, e.status, e.message); return; }
    log('Request error', e && e.stack); err(req, res, 500, 'Something went wrong on the server. Try again.');
  });
});
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch (x) {} });
process.on('uncaughtException', e => log('Unexpected error, server kept running', e && e.stack));
process.on('unhandledRejection', e => log('Unexpected rejection, server kept running', e));
// Render stops the server when it sleeps or redeploys. Save anything waiting first.
async function stop(sig) {
  if (stopping) return; stopping = true; log('Stopping on', sig, 'saving waiting changes');
  try { server.close(); } catch (e) {}
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    for (const t of timers.values()) clearTimeout(t);
    const ok = await Promise.race([flushEverything().catch(() => false), new Promise(r => setTimeout(() => r(false), Math.max(1000, until - Date.now())))]);
    if (ok) { log('All changes saved'); break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (dirtyPaths.size) log('Stopped with', dirtyPaths.size, 'changes not saved to GitHub');
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));

if (require.main === module) {
  server.listen(PORT, () => {
    log('Fulton Calendar server on port', PORT, 'records in', RECORDS_REPO, 'times shown in', SCHOOL_TZ);
    log(TEACHERS.length + ' educator passcodes set');
    log('GitHub key ' + (githubToken() ? 'saved' : 'MISSING'));
    loadAll();
  });
}
module.exports = { normalizeFeed, parseFeed, expand, checkSession, makeSession };
