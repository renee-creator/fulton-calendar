// End to end check of the server against a stand-in for GitHub and a stand-in Google calendar feed.
// Run with  node test/run.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const { files, commits, fakeGitHub, fakeFeed } = require('./fakes.js');

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };

(async () => {
  const ghPort = await listen(fakeGitHub), feedPort = await listen(fakeFeed);
  const appPort = 4100 + Math.floor(Math.random() * 500);
  const BASE = `http://127.0.0.1:${appPort}`, FEEDS = `http://127.0.0.1:${feedPort}/feeds`;
  const start = () => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: appPort, GITHUB_API: `http://127.0.0.1:${ghPort}`, RECORDS_REPO: 'o/r', GITHUB_TOKEN: 'test-token',
      TEACHER_PASSCODES: 'Renee=willow creek 9,Hannah=maple garden 42,Chris=river stone 7', DIRECTOR_NAMES: 'Renee', FLUSH_DELAY_MS: '50', FEED_TEST_BASE: `http://127.0.0.1:${feedPort}`, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; child.stdout.on('data', d => { buf += d; if (process.env.SHOW) process.stdout.write(d); if (/Loaded \d+ sign-ups/.test(buf)) resolve(child); });
    child.stderr.on('data', d => process.stderr.write(d));
  });
  let child = await start();
  const post = async (p, body, token, origin) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin || BASE, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    // sign in
    assert.equal((await post('/login', { passcode: 'nope nope' })).status, 403);
    assert.equal((await post('/login', { passcode: 'willow creek 9' }, null, 'https://evil.example')).status, 403);
    const renee = (await post('/login', { passcode: 'Willow  Creek 9' })).body; assert.equal(renee.name, 'Renee'); assert.equal(renee.director, true);
    const hannah = (await post('/login', { passcode: 'maple garden 42' })).body; assert.equal(hannah.director, false);
    const chris = (await post('/login', { passcode: 'river stone 7' })).body;
    assert.equal((await post('/api/view', { from: '2026-10-05', to: '2026-10-11' })).status, 401);
    ok('sign in, wrong passcode, other websites refused');

    // empty start
    let v = (await post('/api/view', { from: '2026-10-05', to: '2026-10-11' }, hannah.token)).body;
    assert.equal(v.settings.spaces.length, 0); assert.equal(v.settings.calendars.length, 2); assert.equal(v.events.length, 0);
    assert.equal(v.calendarStatus.cal1.connected, false); assert.equal(v.settings.calendars[0].hasAddress, undefined);
    ok('empty start');

    // settings are director only
    const program = { calendars: [{ id: 'cal1', name: 'School calendar', color: 'sky' }, { id: 'cal2', name: 'Staff calendar', color: 'plum' }], spaces: [{ name: 'Atelier', color: 'marigold', note: 'Up to 8 children' }, { name: 'Garden', color: 'moss', shared: true }], dayStart: 420, dayEnd: 1080, weekends: true };
    assert.equal((await post('/api/settings', { program }, hannah.token)).status, 403);
    let s = await post('/api/settings', { program }, renee.token); assert.equal(s.status, 200);
    const [atelier, garden] = s.body.settings.spaces; assert.ok(atelier.id && garden.id && garden.shared);
    assert.equal((await post('/api/settings', { program: { ...program, spaces: [{ name: 'Atelier' }, { name: 'atelier' }] } }, renee.token)).status, 400);
    ok('settings saved by director only');

    // connect calendars
    assert.equal((await post('/api/calendar/connect', { id: 'cal1', address: FEEDS + '/good.ics' }, hannah.token)).status, 403);
    assert.equal((await post('/api/calendar/connect', { id: 'cal1', address: 'https://example.com/a.ics' }, renee.token)).status, 400);
    assert.equal((await post('/api/calendar/connect', { id: 'cal1', address: FEEDS + '/missing.ics' }, renee.token)).status, 422);
    assert.equal((await post('/api/calendar/connect', { id: 'cal1', address: FEEDS + '/page.ics' }, renee.token)).status, 422);
    const c = await post('/api/calendar/connect', { id: 'cal1', address: FEEDS + '/good.ics' }, renee.token);
    assert.equal(c.status, 200); assert.equal(c.body.found.name, 'Fulton School Calendar'); assert.equal(c.body.settings.calendars[0].hasAddress, true);
    assert.equal(c.body.settings.calendars[0].name, 'Fulton School Calendar');   // a starter name is replaced by Google's name
    assert.equal(c.body.settings.calendars[1].name, 'Staff calendar');
    assert.ok(!JSON.stringify(c.body).includes('good.ics'), 'address is never sent back');
    ok('calendar connect checks the address');

    // events, shown in school time
    v = (await post('/api/view', { from: '2026-10-05', to: '2026-11-15' }, hannah.token)).body;
    assert.ok(!JSON.stringify(v).includes('good.ics'));
    const titles = v.events.map(e => e.start + ' ' + e.title).sort();
    assert.deepEqual(titles, ['2026-10-05T09:00 Play Garden', '2026-10-10T10:00 Second Saturday', '2026-10-12T09:00 Play Garden', '2026-10-13T12:00 Webinar from the east coast', '2026-10-26T11:00 Play Garden moved',
      '2026-11-02T09:00 Play Garden', '2026-11-09T09:00 Play Garden', '2026-11-12 Family conferences']);
    const conf = v.events.find(e => e.title === 'Family conferences'); assert.equal(conf.allDay, true); assert.equal(conf.end, '2026-11-13');
    const pg = v.events.find(e => e.start === '2026-11-02T09:00'); assert.equal(pg.end, '2026-11-02T11:30'); assert.equal(pg.location, 'Farm'); assert.equal(pg.desc, 'Bring boots.\nRain or shine.');
    assert.equal(v.calendarStatus.cal1.ok, true); assert.equal(v.calendarStatus.cal2.connected, false);
    ok('events expand, skip exceptions, convert time zones, drop cancelled');

    // sign-ups
    let b = await post('/api/book', { spaceId: atelier.id, date: '2026-10-13', start: 540, end: 600, what: 'Clay with Poppy group' }, hannah.token);
    assert.equal(b.status, 200); const first = b.body.made[0]; assert.equal(first.by, 'Hannah');
    b = await post('/api/book', { spaceId: atelier.id, date: '2026-10-13', start: 570, end: 630 }, chris.token);
    assert.equal(b.status, 409); assert.match(b.body.error, /Atelier is already taken then\. Hannah has it from 9:00 am to 10:00 am\./);
    assert.equal((await post('/api/book', { spaceId: atelier.id, date: '2026-10-13', start: 600, end: 660 }, chris.token)).status, 200);   // back to back is fine
    assert.equal((await post('/api/book', { spaceId: garden.id, date: '2026-10-13', start: 540, end: 600 }, hannah.token)).status, 200);
    assert.equal((await post('/api/book', { spaceId: garden.id, date: '2026-10-13', start: 540, end: 600 }, chris.token)).status, 200);   // shared space
    assert.equal((await post('/api/book', { spaceId: atelier.id, date: '2026-10-13', start: 600, end: 540 }, chris.token)).status, 400);
    assert.equal((await post('/api/book', { spaceId: 'nope', date: '2026-10-13', start: 540, end: 600 }, chris.token)).status, 400);
    assert.equal((await post('/api/book', { spaceId: atelier.id, date: '2026-02-30', start: 540, end: 600 }, chris.token)).status, 400);
    ok('sign-ups, conflicts, shared spaces, bad input');

    // weekly
    b = await post('/api/book', { spaceId: atelier.id, date: '2026-10-06', start: 540, end: 585, what: 'Weekly atelier', repeatUntil: '2026-11-03' }, chris.token);
    assert.equal(b.status, 200); assert.equal(b.body.made.length, 4); assert.deepEqual(b.body.skipped.map(x => x.date), ['2026-10-13']);
    const series = b.body.made; assert.ok(series.every(x => x.seriesId === series[0].seriesId));
    ok('weekly sign-up skips the taken week and says so');

    // changing and removing
    assert.equal((await post('/api/booking/update', { id: first.id, patch: { start: 480 } }, chris.token)).status, 403);
    assert.equal((await post('/api/booking/update', { id: first.id, patch: { start: 510, end: 630 } }, hannah.token)).status, 409);   // would run into Chris at 10
    let u = await post('/api/booking/update', { id: first.id, patch: { start: 510, end: 600, what: 'Clay, earlier' } }, hannah.token); assert.equal(u.status, 200); assert.equal(u.body.booking.start, 510);
    u = await post('/api/booking/update', { id: first.id, patch: { date: '2026-11-10' } }, renee.token); assert.equal(u.status, 200);   // director may move it, across months
    assert.equal((await post('/api/booking/remove', { id: series[1].id, scope: 'following' }, hannah.token)).status, 403);
    const rm = await post('/api/booking/remove', { id: series[1].id, scope: 'following' }, chris.token); assert.equal(rm.body.removed.length, 3);
    v = (await post('/api/view', { from: '2026-10-05', to: '2026-11-15' }, chris.token)).body;
    assert.equal(v.bookings.filter(x => x.seriesId).length, 1); assert.equal(v.bookings.find(x => x.id === first.id).date, '2026-11-10');
    assert.ok(Array.isArray(v.mine));
    const again = (await post('/api/view', { from: '2026-10-05', to: '2026-11-15', stamp: v.stamp }, chris.token)).body; assert.equal(again.unchanged, true);
    ok('only the owner or director can change or remove, weekly removal works');

    // deleting a space with sign-ups is refused, turning it off works
    const cur = (await post('/api/view', { from: '2026-10-05', to: '2026-10-11' }, renee.token)).body.settings;
    const today = (await post('/api/view', { from: '2026-10-05', to: '2026-10-11' }, renee.token)).body.today;
    const future = require('../core.js').addDays(today, 3);
    await post('/api/book', { spaceId: garden.id, date: future, start: 600, end: 660 }, hannah.token);
    assert.equal((await post('/api/settings', { program: { ...cur, spaces: cur.spaces.filter(x => x.id !== garden.id) } }, renee.token)).status, 409);
    assert.equal((await post('/api/settings', { program: { ...cur, spaces: cur.spaces.map(x => x.id === garden.id ? { ...x, hidden: true } : x) } }, renee.token)).status, 200);
    assert.equal((await post('/api/book', { spaceId: garden.id, date: future, start: 700, end: 760 }, hannah.token)).status, 409);
    ok('space with upcoming sign-ups cannot be deleted, can be closed');

    // saved to the records repository, and loaded again after a restart
    await post('/api/save-now', {}, renee.token);
    assert.ok(files.has('settings/program.json') && files.has('settings/feeds.json') && files.has('bookings/2026-10.json') && files.has('bookings/2026-11.json'));
    assert.ok(commits.some(m => /by Hannah/.test(m)));
    const before = (await post('/api/view', { from: '2026-10-05', to: '2026-11-15' }, hannah.token)).body;
    child.kill('SIGTERM'); await new Promise(r => child.on('exit', r));
    child = await start();
    const after = (await post('/api/view', { from: '2026-10-05', to: '2026-11-15' }, hannah.token)).body;
    assert.deepEqual(after.bookings.map(x => x.id).sort(), before.bookings.map(x => x.id).sort());
    assert.equal(after.events.length, before.events.length); assert.equal(after.settings.spaces.length, 2);
    ok('records saved to GitHub and loaded again after a restart');

    // disconnect
    assert.equal((await post('/api/calendar/connect', { id: 'cal1', address: '' }, renee.token)).status, 200);
    assert.equal((await post('/api/view', { from: '2026-10-05', to: '2026-11-15' }, hannah.token)).body.events.length, 0);
    ok('calendar disconnect');

    // the page is served
    const page = await fetch(BASE + '/app/'); assert.ok([200, 404].includes(page.status));
    const st = await (await fetch(BASE + '/')).text(); assert.match(st, /WORKING\. Records are connected/);
    ok('status page');
    console.log(`\nAll ${passed} checks passed.`);
  } catch (e) { console.error('\nFAILED', e); process.exitCode = 1; }
  finally { const gone = new Promise(r => child.on('exit', r)); child.kill('SIGTERM'); await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]); fakeGitHub.close(); fakeFeed.close(); process.exit(); }
})();
