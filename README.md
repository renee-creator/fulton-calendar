# Fulton Calendar

One shared calendar for Fulton Community School & Farm. It shows the school's Google calendars as view only, and lets educators sign up for the shared spaces.

## What it does

- **School calendars from Google** appear for everyone as outlined entries. They are view only. The server only reads them and never sends anything back to Google. New and changed Google events show up within about ten minutes.
- **Space sign-ups** appear as filled entries. Any educator can sign up for a space for a date and time, once or every week. Two sign-ups cannot overlap in the same space unless the director marked that space as shareable.
- **Day, Week and Month views.** The Day view puts each space in its own column, which makes free times easy to see. On a phone the Week view becomes a list.

## How it runs

- **Web page** `index.html`, published with GitHub Pages at https://renee-creator.github.io/fulton-calendar/
- **Server** `server.js`, running on Render at https://fulton-calendar.onrender.com. Open that address in a browser to see a status page. The server also serves the same page at https://fulton-calendar.onrender.com/app/
- **Records** are kept as files in the private repository `fulton-calendar-records`. Sign-ups are saved one file per month with the educator's name on every change, so earlier versions can always be recovered from GitHub's history.

This repository holds code only. It never holds sign-ups, calendar addresses, or keys.

## Server settings on Render

| Setting | What it holds |
|---|---|
| `TEACHER_PASSCODES` | Each educator's name and passcode, separated by commas, like `Hannah=maple garden 42,Chris=river stone 7`. Use the same value as Planning Studio so everyone keeps one passcode. Removing an educator signs them out. |
| `DIRECTOR_NAMES` | Names from `TEACHER_PASSCODES` who may open Settings and change or remove any sign-up. Defaults to `Renee`. |
| `GITHUB_TOKEN` | A fine-grained GitHub token with Contents read and write on `fulton-calendar-records` only |
| `RECORDS_REPO` | Optional. Defaults to `renee-creator/fulton-calendar-records` |
| `SCHOOL_TIMEZONE` | Optional. Defaults to `America/Los_Angeles` |
| `ALLOWED_ORIGINS` | Optional. Extra websites allowed to use the server |

Build command `echo no build needed`. Start command `node server.js`.

## Who can do what

Every educator can see everything, sign up for a space, and change or remove their own sign-ups. Only the director can open Settings, connect calendars, add or close spaces, and change or remove someone else's sign-up. The server enforces this, not just the page.

## Connecting a Google calendar

The director does this once per calendar, in Settings.

1. On a computer, open Google Calendar.
2. In the left column, point at the calendar's name, choose the three dots, then Settings and sharing.
3. Scroll to Integrate calendar and copy the Secret address in iCal format.
4. In Fulton Calendar, open Settings, paste the address in that calendar's box, and choose Connect.

Anyone holding a secret address can read that calendar. The address is kept in the private records repository and is never sent to an educator's browser. If Google is not offering a secret address, make the calendar public and paste its Public address in iCal format instead.

## Editing the page

The page is written in `src/app.html`. After changing it, run `python3 tools/build.py` to rebuild `index.html`. The sign-up rules live in `core.js` and are shared by the server and the preview page.

`node test/run.js` checks the server from sign-in through saving. `node test/dev.js` starts a trial server on this computer with stand-ins for GitHub and Google, so nothing real is touched.

## Free plan notes

The Render server sleeps after 15 quiet minutes. The first visit after that takes about a minute while it wakes, and the page says so. Changes reach GitHub within a few seconds.

## Credits

Google calendar feeds are read with ical.js by Philipp Kewisch and contributors, kept in `vendor/ical.cjs` under the Mozilla Public License 2.0.
