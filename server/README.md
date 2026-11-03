# DigiTwin Generator -- backend

The self-hostable backend for the "upload your own city" pipeline: someone
uploads a city's data, this runs it through the same building-tile bake the
main app already uses, and produces a private city they can view as soon as
the build finishes.

This is **not a service we run for you** -- it's meant to be handed off and
run on whatever machine its owner picks: a company server, or a personal
laptop. Nothing here needs an external database, a managed queue, or an
account with a paid provider. It's one Node process and one folder on disk.

## Requirements

- Node.js 24 or later (built and tested on 24; `package.json` asks for it).
  Two things depend on a recent Node: `node --env-file` (no
  `dotenv` dependency) and Node's own built-in `node:sqlite` module -- this
  backend deliberately does NOT use the popular `better-sqlite3` package,
  because it has no prebuilt binary for every Node version and falls back
  to compiling from source, which needs a full C++ toolchain (Visual Studio
  Build Tools on Windows) that a personal-computer self-hoster is unlikely
  to have installed. `node:sqlite` ships inside Node itself: nothing to
  compile, ever, on any platform.
- Enough free disk space to hold every city you expect people to upload --
  a single city's baked tiles can run into the gigabytes (see the main
  project's `NEW_CITY_CHECKLIST.md`).

## Setup

```bash
cd server
npm ci
cp .env.example .env
```

Open `.env` and set **`ADMIN_TOKEN`** -- the server refuses to start without
it (it's the only thing gating the admin page; there's no separate login
system). Generate a random value with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Everything else in `.env` has a working default; see the comments in
`.env.example` for what each one does (upload size caps, bake timeout, the
weather API key, etc.). The one weather key covers every city on the server,
the built-in Kanpur included: it is added to a city when the city is opened
(`lib/siteWeather.js`), so setting or changing it needs a restart of this
server and nothing else.

## Running it

```bash
npm start        # production
npm run dev       # restarts on file changes (Node's built-in --watch)
```

You should see:

```
[digitwin-server] listening on http://localhost:8787 (all interfaces)
[digitwin-server] storage: /path/to/server/storage
[digitwin-server] serving the front end from /path/to/dist
```

The last line appears once the front end has been built (`npm run build` in
the project root); open http://localhost:8787 for the whole app.

Confirm it's alive:

```bash
curl http://localhost:8787/api/health
```

Or open that address in a browser. Either way it shows `{"ok":true}`.

## Where data lives

Everything is under `storage/` (configurable via `STORAGE_ROOT` in `.env`),
and nothing here ever writes into the main project's `public/` folder --
that's served with no access control, so private uploaded-city data has to
live somewhere else entirely:

```
storage/
  app.db            SQLite database -- every city, job, and uploaded-file record
  uploads/<cityId>/   raw files as uploaded, before baking
  cities/<cityId>/    baked output (tiles, manifest.json) -- what actually gets served
```

Back up `storage/` (or just `storage/app.db` plus whichever `cities/`
subfolders you care about) the same way you'd back up any other small
self-hosted app's data directory.

## Connecting the front end

Nothing to configure: the front end calls `/api` and `/files` on its own
origin. This server serves the built front end itself (`../dist`, see
`FRONTEND_DIR` in `.env.example`), and `npm run dev` / `npm run preview` in
the project root proxy both paths here (`vite.config.js`). One origin for
everything is what lets a city's link or an embed work from any device.

For a real deployment (HTTPS, reverse proxy, service, backups) see the
project root's `HOSTING.md`.

## The admin page

There is no review step: a build that finishes successfully is **live at
once** (its uploader's link works, and a revision replaces the previous
build the moment it succeeds). A build that fails never takes down a city
that was already live.

The admin page is for seeing what has been uploaded to the server and
removing what shouldn't be there. Open the app at

```
http://localhost:8787/?admin=<ADMIN_TOKEN>
```

It lists every uploaded city, newest first, with its status (live,
building, build failed, files cleared), and for each one:

- **Open** -- the city in the same 3D viewer its visitors use, without
  needing its private link (`?admin=<ADMIN_TOKEN>&city=<cityId>`). Only
  offered while some build of the city is live.
- **Build log** -- every build attempt's captured output
  (`?admin=<ADMIN_TOKEN>&city=<cityId>&logs=1`, from `jobs.log_text`), so a
  failed build can be understood without SSHing into the server.
- **Delete** -- after a confirmation, stops the city's build if one is
  running and permanently removes everything stored for it: uploaded files,
  downloaded map data, the built tiles and its database rows. Its link
  stops working. This is the one way to take an unwanted city down.

The same is available over HTTP, e.g.
`curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/api/admin/cities?status=failed`
(statuses: `processing`, `live`, `failed`, `purged`; paginated with
`&limit=`/`&offset=`). The admin link carries the token, so treat it like a
password.

## Using it as an uploader

Open the main app (the Vite project one level up) and click "Upload a city"
-- a three-step wizard: search for the place and draw its area on a movable
map, choose where the buildings come from (plus any optional municipal
layers: wards, zones, landmarks, city outline), then review and build. No
email is asked for.

The buildings: by default ("Get them for me from Google Open Buildings")
the build's first step downloads every building in the drawn area with its
height from Google's public storage (`jobs/buildingsJob.js` runs
`scripts/fetch-open-buildings.mjs`; needs outbound HTTPS to
`storage.googleapis.com`). An area Google doesn't cover, or a failed
download, stops the build with the reason on the Review & build page; a
revision of the same area reuses the earlier download. Or the uploader
attaches their own buildings file and names its height property.

Roads, railway, amenities, localities, land use, vegetation and water
are downloaded from OpenStreetMap (Overpass API) for the drawn area during
the build itself -- the server needs outbound internet access for that
(`OVERPASS_ENDPOINTS` in `.env` to use your own instance).

A large area is asked for in parts (Delhi with its satellite cities: 17
requests), and each part is saved as it arrives and kept for a week. The
public servers turn away more than half of all requests at busy hours;
the download keeps away from a server for as long as that server says and
tries again. If a part still can't be had, its layer is reported missing
on the Review & build page and revising the city asks only for that part.
From 60,000 roads up, a city's roads are written as tiles the viewer
loads around the camera (`lib/roadTiles.js`), not as one `roads.geojson`.
`node scripts/test-osm-download.mjs` checks all of this against a
stand-in server, with no internet.

Submitting turns the wizard's last step into the build's live progress page
(`?status=1&city=<id>&t=<token>`): queue position, OpenStreetMap download,
3D bake, live. Everything on it is read from the server, so it can be
closed and reopened any time, on any device -- "My cities" (in the top bar)
remembers what you've uploaded or opened from this browser, via
`localStorage`. Builds are durable: if the server stops mid-build, queued
builds wait and the interrupted one is rebuilt from scratch on the next start
(up to 3 attempts).

A live city not rendering right, or need to change your data? Open its
Review & build page and revise it -- same city, same link, and the version
that's live keeps serving while the revision builds, then the revision
takes over. The same page can delete the city.

The app is built for a mouse or trackpad on a laptop, desktop or tablet.
Phones and touch-only use are not supported.

See `public/DATA_SOURCES.md` for where to actually get building/road/etc.
data from (linked from every upload slot in the wizard too).

There is deliberately **no email** anywhere in this flow -- "finding your
way back" is handled entirely client-side:
`localStorage` remembers your cities and an in-progress upload draft across
closing the browser, and the app itself surfaces a "welcome back" banner
for it on load. That means access genuinely depends on the link/browser you
used -- there's no account recovery. Bookmark the status/viewer link if you
want a durable way back in from elsewhere.

## Automatic safety nets

A few automatic, `.env`-tunable safety nets -- see `.env.example` for every
variable's default:

- **Retention sweep**: a city whose build failed, and that has no live
  version at all, has its files (not its database row -- that stays, marked
  `purged`, for the record) deleted `RETENTION_DAYS` after that build. Runs
  in-process on boot and every 12 hours after -- no cron to set up. A city
  *with* a live version is never touched by this even if its latest
  revision failed; superseded (replaced) build output is swept immediately,
  since there's no rollback feature to keep it around for.
- **Per-uploader quota**: `MAX_CONCURRENT_UPLOADS_PER_UPLOADER`, how many of
  one uploader's cities may be building or waiting to build at once. It is
  keyed by the uploading browser's IP address (uploads don't ask for an
  email), so it stops accidental pile-up, not a determined abuser (put the
  upload endpoint behind your own auth/reverse proxy for that). Behind a
  reverse proxy, set `TRUST_PROXY` or every uploader shares the proxy's
  address.
- **Disk pre-flight checks**: `MIN_FREE_SPACE_GB`, checked both when an
  upload arrives (a fast estimate) and right before a bake actually starts
  (the exact file size) -- refuses rather than risks running the host out
  of disk mid-write.
- **CORS**: wide open by default; set `ALLOWED_ORIGINS` for a strict
  allowlist instead.

## Status

Everything above is built and tested: upload -> OpenStreetMap download ->
bake -> live, revisions, durable builds, the admin page (list, open, build
log, delete), the safety nets, and metro-sized cities (tested with a
Delhi-sized test file of 58 lakh buildings and Delhi's real OpenStreetMap
layers). Deliberately left out: manual
review (approve / reject) -- a build goes live when it succeeds, and the
admin deletes what shouldn't be there -- and any email or other
notification channel. Deploying beyond a LAN is documented in the project
root's `HOSTING.md`.
