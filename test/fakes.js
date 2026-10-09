// Stand-ins for GitHub and for a Google calendar feed, used by the checks and by the local trial server.
const http = require('http');
const crypto = require('crypto');

const files = new Map();   // path to { content (base64), sha }
const commits = [];
const gitSha = b64 => crypto.createHash('sha1').update(b64).digest('hex');
const fakeGitHub = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const out = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (p === '/repos/o/r') return out(200, { default_branch: 'main' });
    if (p.startsWith('/repos/o/r/git/trees/')) return files.size ? out(200, { tree: [...files].map(([path, f]) => ({ path, type: 'blob', sha: f.sha })) }) : out(409, { message: 'Git Repository is empty.' });
    if (p.startsWith('/repos/o/r/git/blobs/')) { const sha = p.split('/').pop(); const f = [...files.values()].find(f => f.sha === sha); return f ? out(200, { content: f.content }) : out(404, {}); }
    if (p.startsWith('/repos/o/r/contents/')) {
      const fp = decodeURIComponent(p.slice('/repos/o/r/contents/'.length)); const cur = files.get(fp);
      if (req.method === 'GET') return cur ? out(200, { sha: cur.sha }) : out(404, {});
      if (req.method === 'PUT') {
        if (cur && body.sha !== cur.sha) return out(409, { message: 'sha mismatch' });
        if (!cur && body.sha) return out(422, { message: 'no such file' });
        const sha = gitSha(body.content + Math.random()); files.set(fp, { content: body.content, sha }); commits.push(body.message);
        return out(cur ? 200 : 201, { content: { sha } });
      }
    }
    out(404, { message: 'not found ' + p });
  });
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Fulton School Calendar
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20261005T090000
DTEND;TZID=America/Los_Angeles:20261005T113000
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261201T080000Z
EXDATE;TZID=America/Los_Angeles:20261019T090000
UID:garden
SUMMARY:Play Garden
LOCATION:Farm
DESCRIPTION:Bring <b>boots</b>.<br>Rain or shine.
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20261026T110000
DTEND;TZID=America/Los_Angeles:20261026T120000
RECURRENCE-ID;TZID=America/Los_Angeles:20261026T090000
UID:garden
SUMMARY:Play Garden moved
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261112
DTEND;VALUE=DATE:20261114
UID:conf
SUMMARY:Family conferences
END:VEVENT
BEGIN:VEVENT
DTSTART:20261010T170000Z
DTEND:20261010T190000Z
UID:sat
SUMMARY:Second Saturday
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261013T150000
DTEND;TZID=America/New_York:20261013T160000
UID:webinar
SUMMARY:Webinar from the east coast
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20261014T100000
DTEND;TZID=America/Los_Angeles:20261014T110000
UID:gone
STATUS:CANCELLED
SUMMARY:Cancelled visit
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');
const fakeFeed = http.createServer((req, res) => {
  if (req.url === '/feeds/good.ics') { res.writeHead(200, { 'Content-Type': 'text/calendar' }); res.end(ICS); }
  else if (req.url === '/feeds/page.ics') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Sign in</html>'); }
  else { res.writeHead(404); res.end('no'); }
});

module.exports = { files, commits, fakeGitHub, fakeFeed, ICS };
