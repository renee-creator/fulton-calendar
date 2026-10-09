/* Fulton Calendar rules for spaces and sign-ups.
   One copy of the rules, used by the server and by the preview page, so both behave the same. */
(function (root) {
  'use strict';
  const COLORS = ['moss', 'sky', 'marigold', 'clay', 'plum', 'teal', 'rose', 'slate'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_WEEKS = 60;

  function fail(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
  function dayNum(s) { const p = s.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); }
  function fromDayNum(n) { return new Date(n * 864e5).toISOString().slice(0, 10); }
  function validDate(s) { return typeof s === 'string' && DATE_RE.test(s) && fromDayNum(dayNum(s)) === s; }
  function addDays(s, n) { return fromDayNum(dayNum(s) + n); }
  function clock(min) { const h = Math.floor(min / 60), m = min % 60; const h12 = h % 12 === 0 ? 12 : h % 12; return h12 + ':' + String(m).padStart(2, '0') + (h >= 12 && h < 24 ? ' pm' : ' am'); }
  function niceDate(s) { return new Date(dayNum(s) * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }); }
  function text(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
  function defaultProgram() {
    return { calendars: [{ id: 'cal1', name: 'School calendar', color: 'sky' }, { id: 'cal2', name: 'Second calendar', color: 'plum' }], spaces: [], dayStart: 420, dayEnd: 1080, weekends: true };
  }
  function cleanProgram(p) {
    const d = defaultProgram(); p = p && typeof p === 'object' ? p : {};
    const out = { calendars: [], spaces: [], dayStart: d.dayStart, dayEnd: d.dayEnd, weekends: p.weekends !== false };
    for (const c of Array.isArray(p.calendars) ? p.calendars : d.calendars) if (c && /^[a-z0-9]{3,16}$/.test(c.id || '')) out.calendars.push({ id: c.id, name: text(c.name, 40) || 'Calendar', color: COLORS.includes(c.color) ? c.color : 'sky' });
    for (const s of Array.isArray(p.spaces) ? p.spaces : []) if (s && /^[a-z0-9]{3,16}$/.test(s.id || '') && text(s.name, 40)) out.spaces.push({ id: s.id, name: text(s.name, 40), color: COLORS.includes(s.color) ? s.color : 'moss', note: text(s.note, 120), shared: !!s.shared, hidden: !!s.hidden });
    if (Number.isInteger(p.dayStart) && Number.isInteger(p.dayEnd) && p.dayStart >= 0 && p.dayEnd <= 1440 && p.dayEnd - p.dayStart >= 120) { out.dayStart = p.dayStart; out.dayEnd = p.dayEnd; }
    return out;
  }

  function createCore(opts) {
    const newId = opts.newId, today = opts.today;
    const onBooking = opts.onBooking || function () {}, onProgram = opts.onProgram || function () {};
    let program = cleanProgram(opts.program);
    const byId = new Map(), byDay = new Map();

    function put(b) { byId.set(b.id, b); if (!byDay.has(b.date)) byDay.set(b.date, new Map()); byDay.get(b.date).set(b.id, b); }
    function drop(b) { byId.delete(b.id); const m = byDay.get(b.date); if (m) { m.delete(b.id); if (!m.size) byDay.delete(b.date); } }
    function okBooking(b) { return b && typeof b.id === 'string' && validDate(b.date) && Number.isInteger(b.start) && Number.isInteger(b.end) && b.end > b.start && typeof b.spaceId === 'string' && typeof b.by === 'string'; }
    for (const b of opts.bookings || []) if (okBooking(b)) put(b);

    function spaceFor(id) { return program.spaces.find(s => s.id === id); }
    function clashFor(spaceId, date, start, end, exceptId) {
      const m = byDay.get(date); if (!m) return null;
      for (const b of m.values()) if (b.spaceId === spaceId && b.id !== exceptId && b.start < end && start < b.end) return b;
      return null;
    }
    function checkTimes(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start % 5 || end % 5) throw fail(400, 'Choose a start and end time.');
      if (end <= start) throw fail(400, 'The end time needs to be after the start time.');
    }
    function checkDate(date) {
      if (!validDate(date)) throw fail(400, 'Choose a date.');
      const n = dayNum(date) - dayNum(today());
      if (n > 400) throw fail(400, 'Sign-ups can be made up to about a year ahead.');
      if (n < -400) throw fail(400, 'That date is too far in the past.');
    }
    const nameOf = b => b.who || b.by;   // with a shared passcode the educator's own name is kept in who
    function takenLine(space, c) { return space.name + ' is already taken then. ' + nameOf(c) + ' has it from ' + clock(c.start) + ' to ' + clock(c.end) + '.'; }
    function mayChange(ctx, b) { return ctx.director || b.by === ctx.name; }

    function book(ctx, input) {
      input = input || {};
      const space = spaceFor(input.spaceId);
      if (!space) throw fail(400, 'Choose a space.');
      if (space.hidden) throw fail(409, space.name + ' is not open for sign-ups right now.');
      checkDate(input.date); checkTimes(input.start, input.end);
      const what = text(input.what, 80), who = text(input.who, 40);
      if (ctx.shared && !who) throw fail(400, 'Add your name so everyone can see who has the space.');
      const dates = [input.date];
      if (input.repeatUntil) {
        if (!validDate(input.repeatUntil) || input.repeatUntil < input.date) throw fail(400, 'The last week needs to be on or after the first date.');
        for (let d = addDays(input.date, 7); d <= input.repeatUntil; d = addDays(d, 7)) dates.push(d);
        if (dates.length > MAX_WEEKS) throw fail(400, 'A weekly sign-up can run for up to ' + MAX_WEEKS + ' weeks. Choose an earlier last week.');
        checkDate(dates[dates.length - 1]);
      }
      const plan = dates.map(d => ({ date: d, clash: space.shared ? null : clashFor(space.id, d, input.start, input.end, null) }));
      const open = plan.filter(p => !p.clash);
      if (!open.length) throw fail(409, takenLine(space, plan[0].clash) + (dates.length > 1 ? ' Every week you chose is taken.' : ''));
      const seriesId = dates.length > 1 ? newId() : undefined;
      const made = [], months = new Set();
      for (const p of open) {
        const b = { id: newId(), spaceId: space.id, date: p.date, start: input.start, end: input.end, by: ctx.name, what, createdAt: Date.now() };
        if (who) b.who = who;
        if (seriesId) b.seriesId = seriesId;
        put(b); made.push(b); months.add(b.date.slice(0, 7));
      }
      for (const m of months) onBooking(m, ctx.name);
      return { made, skipped: plan.filter(p => p.clash).map(p => ({ date: p.date, by: nameOf(p.clash), start: p.clash.start, end: p.clash.end })) };
    }

    function update(ctx, id, patch) {
      const b = byId.get(id); patch = patch || {};
      if (!b) throw fail(404, 'That sign-up no longer exists. Someone may have removed it.');
      if (!mayChange(ctx, b)) throw fail(403, 'Only ' + nameOf(b) + ' or the director can change this sign-up.');
      const next = { spaceId: patch.spaceId != null ? patch.spaceId : b.spaceId, date: patch.date != null ? patch.date : b.date, start: patch.start != null ? patch.start : b.start, end: patch.end != null ? patch.end : b.end, what: patch.what != null ? text(patch.what, 80) : b.what };
      const who = patch.who != null ? text(patch.who, 40) : (b.who || '');
      if (ctx.shared && !who) throw fail(400, 'Add your name so everyone can see who has the space.');
      const space = spaceFor(next.spaceId);
      if (!space) throw fail(400, 'Choose a space.');
      if (space.hidden && next.spaceId !== b.spaceId) throw fail(409, space.name + ' is not open for sign-ups right now.');
      checkDate(next.date); checkTimes(next.start, next.end);
      const clash = space.shared ? null : clashFor(space.id, next.date, next.start, next.end, b.id);
      if (clash) throw fail(409, takenLine(space, clash));
      const oldMonth = b.date.slice(0, 7);
      drop(b); Object.assign(b, next, { updatedByName: ctx.name, updatedAt: Date.now() }); if (who) b.who = who; else delete b.who; put(b);
      onBooking(oldMonth, ctx.name); if (b.date.slice(0, 7) !== oldMonth) onBooking(b.date.slice(0, 7), ctx.name);
      return { booking: b };
    }

    function remove(ctx, id, scope) {
      const b = byId.get(id);
      if (!b) return { removed: [] };
      let targets = [b];
      if (scope === 'following' && b.seriesId) targets = [...byId.values()].filter(x => x.seriesId === b.seriesId && x.date >= b.date);
      for (const t of targets) if (!mayChange(ctx, t)) throw fail(403, 'Only ' + nameOf(t) + ' or the director can remove this sign-up.');
      const months = new Set();
      for (const t of targets) { drop(t); months.add(t.date.slice(0, 7)); }
      for (const m of months) onBooking(m, ctx.name);
      return { removed: targets.map(t => t.id) };
    }

    function setProgram(ctx, input) {
      if (!ctx.director) throw fail(403, 'Only the director can change settings.');
      input = input && typeof input === 'object' ? input : {};
      const cals = Array.isArray(input.calendars) ? input.calendars : [];
      const spaces = Array.isArray(input.spaces) ? input.spaces : [];
      if (cals.length > 4) throw fail(400, 'Up to four school calendars can be shown.');
      if (spaces.length > 40) throw fail(400, 'Up to 40 spaces can be listed.');
      const fix = list => list.map(x => Object.assign({}, x, { id: /^[a-z0-9]{3,16}$/.test((x && x.id) || '') ? x.id : newId() }));
      const named = fix(spaces).filter(s => text(s.name, 40));
      const names = named.map(s => text(s.name, 40).toLowerCase());
      if (new Set(names).size !== names.length) throw fail(400, 'Two spaces have the same name. Give each space its own name.');
      if (!Number.isInteger(input.dayStart) || !Number.isInteger(input.dayEnd) || input.dayEnd - input.dayStart < 120) throw fail(400, 'The hours shown need to cover at least two hours.');
      const next = cleanProgram({ calendars: fix(cals), spaces: named, dayStart: input.dayStart, dayEnd: input.dayEnd, weekends: input.weekends });
      const t = today();
      for (const s of program.spaces) if (!next.spaces.some(n => n.id === s.id)) {
        const n = [...byId.values()].filter(b => b.spaceId === s.id && b.date >= t).length;
        if (n) throw fail(409, s.name + ' still has ' + n + (n === 1 ? ' upcoming sign-up' : ' upcoming sign-ups') + '. Remove those first, or turn off sign-ups for the space instead of deleting it.');
      }
      const gone = program.calendars.filter(c => !next.calendars.some(n => n.id === c.id)).map(c => c.id);
      program = next; onProgram(ctx.name, gone);
      return { program };
    }

    function view(from, to) { const out = []; for (const [date, m] of byDay) if (date >= from && date <= to) for (const b of m.values()) out.push(b); return out; }
    function mine(name, limit, who) {
      const t = today();
      const seen = new Set();   // a weekly sign-up is listed once, by its next date
      return [...byId.values()].filter(b => b.by === name && (!who || b.who === who) && b.date >= t).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start)
        .filter(b => { if (!b.seriesId) return true; if (seen.has(b.seriesId)) return false; seen.add(b.seriesId); return true; }).slice(0, limit || 8);
    }
    return { book, update, remove, setProgram, view, mine, get program() { return program; }, count: () => byId.size };
  }

  const api = { COLORS, MAX_WEEKS, fail, dayNum, fromDayNum, validDate, addDays, clock, niceDate, text, defaultProgram, cleanProgram, createCore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FCCore = api;
})(typeof self !== 'undefined' ? self : this);
