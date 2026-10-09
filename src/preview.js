/* Preview only. Stands in for the server so the page can be tried with example entries. Nothing is saved. */
(function () {
  'use strict';
  const C = window.FCCore;
  const pad = n => String(n).padStart(2, '0');
  const d0 = new Date(); const today = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
  const dow = s => new Date(C.dayNum(s) * 864e5).getUTCDay();
  const sunday = C.addDays(today, -dow(today));
  let n = 0; const newId = () => 'p' + String(++n).padStart(4, '0');
  let ctx = { name: 'Renee', director: true };
  const connected = { cal1: true, cal2: true };
  let rev = 0;
  const core = C.createCore({ newId, today: () => today, onBooking: () => { rev++; }, onProgram: () => { rev++; },
    program: { calendars: [{ id: 'cal1', name: 'School calendar', color: 'sky' }, { id: 'cal2', name: 'Staff calendar', color: 'plum' }],
      spaces: [{ id: 'sp01', name: 'Atelier', color: 'marigold', note: 'Example space' }, { id: 'sp02', name: 'Garden', color: 'moss', note: 'Example space', shared: true }, { id: 'sp03', name: 'Kitchen', color: 'clay', note: 'Example space' }, { id: 'sp04', name: 'Library corner', color: 'teal', note: 'Example space' }],
      dayStart: 420, dayEnd: 1080, weekends: true } });
  const seed = (who, spaceId, offset, start, end, what, weeks) => { try { const date = C.addDays(sunday, offset); core.book({ name: who }, { spaceId, date, start, end, what, repeatUntil: weeks ? C.addDays(date, 7 * weeks) : undefined }); } catch (e) {} };
  seed('Hannah', 'sp01', 1, 570, 630, 'Small group clay work', 3);
  seed('Chris', 'sp01', 2, 540, 600, 'Wire and paper');
  seed('Renee', 'sp01', 3, 600, 660, 'Light table');
  seed('Chris', 'sp02', 1, 600, 660, 'Planting peas', 3);
  seed('Hannah', 'sp02', 1, 615, 675, 'Compost walk');
  seed('Hannah', 'sp02', 4, 540, 600, 'Harvest basket');
  seed('Renee', 'sp03', 2, 630, 720, 'Bread baking', 3);
  seed('Chris', 'sp03', 4, 600, 660, 'Apple tasting');
  seed('Hannah', 'sp04', 3, 780, 825, 'Story circle');
  seed('Chris', 'sp04', 5, 780, 825, 'Book making');
  seed('Renee', 'sp04', 2, 840, 900, 'Family tour');
  rev = 0;

  function events(from, to) {
    const out = []; const add = (cal, title, date, start, end, extra) => out.push(Object.assign({ id: cal + '.' + date + '.' + title.length, cal, title, allDay: start == null, start: start == null ? date : date + 'T' + pad(Math.floor(start / 60)) + ':' + pad(start % 60), end: start == null ? date : date + 'T' + pad(Math.floor(end / 60)) + ':' + pad(end % 60) }, extra || {}));
    for (let d = from; d <= to; d = C.addDays(d, 1)) {
      const w = dow(d), day = Number(d.slice(8));
      if (connected.cal1 && w === 1) add('cal1', 'Play Garden', d, 540, 690, { location: 'Example location', desc: 'Example entry. Real entries come from your Google calendar.' });
      if (connected.cal1 && w === 6 && day >= 8 && day <= 14) add('cal1', 'Second Saturday', d, 600, 720);
      if (connected.cal1 && d === C.addDays(sunday, 4)) add('cal1', 'Picture day', d, null, null);
      if (connected.cal2 && w === 3) add('cal2', 'Staff meeting', d, 930, 990);
      if (connected.cal2 && w === 5) add('cal2', 'Planning time', d, 780, 840);
    }
    return out;
  }
  function settingsFor() {
    const p = core.program;
    if (!ctx.director) return p;
    return Object.assign({}, p, { calendars: p.calendars.map(c => Object.assign({}, c, { hasAddress: !!connected[c.id], secret: true })) });
  }
  function call(path, body) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          if (path === '/api/view') {
            const status = {}; for (const c of core.program.calendars) status[c.id] = connected[c.id] ? { connected: true, ok: true } : { connected: false };
            const stamp = [rev, body.from, body.to, ctx.name].join('.');
            if (body.stamp === stamp) return resolve({ stamp, unchanged: true, calendarStatus: status });
            return resolve(JSON.parse(JSON.stringify({ stamp, calendarStatus: status, me: ctx.name, director: ctx.director, today, settings: settingsFor(), bookings: core.view(body.from, body.to), events: events(body.from, body.to).filter(e => core.program.calendars.some(c => c.id === e.cal)), mine: core.mine(ctx.name, 8) })));
          }
          if (path === '/api/book') return resolve(JSON.parse(JSON.stringify(core.book(ctx, body))));
          if (path === '/api/booking/update') return resolve(JSON.parse(JSON.stringify(core.update(ctx, body.id, body.patch))));
          if (path === '/api/booking/remove') return resolve(core.remove(ctx, body.id, body.scope));
          if (path === '/api/settings') { const before = new Set(core.program.calendars.map(c => c.id)); core.setProgram(ctx, body.program); for (const id of before) if (!core.program.calendars.some(c => c.id === id)) delete connected[id]; return resolve({ settings: settingsFor() }); }
          if (path === '/api/calendar/connect') {
            if (!ctx.director) throw C.fail(403, 'Only the director can connect calendars.');
            const a = String(body.address || '').trim();
            if (a && !/calendar\.google\.com|@/.test(a)) throw C.fail(400, 'Only Google Calendar addresses can be connected. In Google Calendar, open the calendar\'s Settings and sharing, then copy the Secret address in iCal format.');
            if (a) connected[body.id] = true; else delete connected[body.id]; rev++;
            return resolve({ settings: settingsFor(), found: a ? { name: 'an example calendar', events: 0 } : null });
          }
          resolve({ ok: true });
        } catch (e) { reject({ status: e.status || 500, message: e.expose ? e.message : 'Something went wrong in the preview.' }); }
      }, 120);
    });
  }
  function mount(bar, changed) {
    bar.hidden = false;
    const text = document.createElement('span'); text.textContent = 'Preview with example entries. Nothing here is saved or shared with staff.';
    const seg = document.createElement('span'); seg.className = 'seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'See the calendar as');
    const mk = (label, who) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(ctx.name === who.name)); b.onclick = () => { ctx = who; for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b)); changed(); }; return b; };
    seg.append(mk('See as director', { name: 'Renee', director: true }), mk('See as educator', { name: 'Hannah', director: false }));
    bar.append(text, seg);
  }
  window.FC_PREVIEW = { call, mount };
})();
