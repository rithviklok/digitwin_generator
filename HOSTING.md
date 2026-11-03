# Hosting DigiTwin Generator on a Linux server

For the IT team deploying DigiTwin Generator on an institute or on-premises Linux server. It assumes you're comfortable with systemd, nginx (or Apache) and TLS certificates. Tested with Node.js 24.19. Anything marked **estimate** has not been measured on a Linux server.

## How it fits together

One Node.js process (`server/app.js`) serves everything on a single port:
- the web app (the built `dist/` folder);
- the API (`/api/...`);
- the 3D data for each city (`/files/...` and `/data/...`).

Put nginx or Apache in front of it for HTTPS, upload limits and compression. Because everything shares one address, links and embeds work from any device. Nothing else is required: no database server, no cloud account. Uploads, built cities and the SQLite database live in one folder, `server/storage/`.

```
browser ──HTTPS──> nginx :443 ──HTTP──> node server/app.js 127.0.0.1:8787
                                          ├─ /          web app (dist/)
                                          ├─ /api/...   uploads, build status, admin, city configs
                                          ├─ /files/... uploaded cities' tiles
                                          └─ /data/...  the built-in city (Kanpur)
```

## What you need

| | |
|---|---|
| OS | Any current 64-bit Linux, e.g. Ubuntu 22.04/24.04, RHEL/Rocky 9 |
| Node.js | 24 LTS. Older versions lack the built-in SQLite module the server uses. |
| CPU / RAM | 4+ cores, 8 GB RAM. One build runs at a time, and its memory grows with the number of buildings, not the size of the file. Measured: Kanpur (7.3 lakh buildings) peaks at about 0.5 GB, and a Delhi-sized test file (58 lakh buildings, 2.3 GB) at about 1 GB. The OpenStreetMap step runs before it, not alongside, and peaked at 0.7 GB for that city (0.9 GB when its roads came as a 436 MB file of the uploader's own). |
| Disk | About 5 GB for the app plus Kanpur (2.2 GB of data, copied again into `dist/` by the build). Each uploaded city keeps its buildings file and needs about 7× that for its tiles: 283 MB in → about 1.9 GB of tiles for Kanpur, 2.3 GB in → 15.6 GB for the Delhi-sized test file. A metro's roads and other OpenStreetMap layers add about 0.4 GB. The server refuses uploads that would leave less than `MIN_FREE_SPACE_GB` (default 5) free. |
| Hostname | Its **own hostname**, e.g. `digitwin.example.ac.in`. A sub-path such as `example.ac.in/digitwin/` does **not** work, because the app uses root paths (`/api`, `/files`, `/shared`). |
| TLS | A certificate for that hostname: your institute's wildcard certificate, or Let's Encrypt if the host is reachable from the internet on port 80. |
| Outbound (server) | HTTPS (443) to the OpenStreetMap Overpass servers: `lz4.overpass-api.de`, `z.overpass-api.de`, `overpass-api.de`, `overpass.private.coffee`, `maps.mail.ru`. These are used only while building an uploaded city. Direct access or an HTTP proxy both work (step 3). Without either, cities still build, just without OpenStreetMap roads, land use and so on, and the uploader is told which layers are missing. |
| Outbound (install) | HTTPS to `registry.npmjs.org` for `npm ci` (step 2), and to NodeSource or nodejs.org for Node.js itself (step 1). Only while installing or updating: the packages are not in the zip, because some are built for the machine they are installed on. Behind the institute proxy, give npm the proxy as the `digitwin` user: `npm config set proxy http://proxy.example.ac.in:3128` and `npm config set https-proxy http://proxy.example.ac.in:3128`. |
| Outbound (server, buildings) | HTTPS (443) to `storage.googleapis.com` (Google Open Buildings), used while building a city whose uploader chose "Get them for me from Google Open Buildings", the upload form's default. Without it those builds stop at the buildings step with a message, and uploaders can attach a buildings file instead. Direct access or the same HTTP proxy as for OpenStreetMap. Running `scripts/fetch-open-buildings.mjs` by hand needs the same, plus `raw.githubusercontent.com` and `bfppub.blob.core.windows.net` for its Microsoft fallback; behind the proxy, set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` in that shell. |
| Outbound (visitors' browsers) | `api.openweathermap.org` (live weather, if a key is set), `tile.openstreetmap.org` and `nominatim.openstreetmap.org` (map and place search on the upload page). The server doesn't need these. |
| Visitors' devices | A desktop or laptop browser, or a tablet with a mouse or trackpad, with a window at least about 768 px wide. Phones and touch-only use are not supported. |

## 1. Install Node.js 24

On Ubuntu/Debian, use NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v24.x
```

If piping a script to bash isn't allowed, install the official Linux binary from https://nodejs.org/en/download instead. Check `node --version` again afterwards.

## 2. Get the code and data

```sh
sudo useradd --system --create-home --home-dir /opt/digitwin --shell /usr/sbin/nologin digitwin
```

**From the handover zip** (one `.zip` file, e.g. `DigiTwin-Generator.zip`). It holds the code, all of Kanpur's data (including the two large data sets below that are not in git) and the cities built so far, in `server/storage/`: their database, their files, and `CITY_LINKS.md` with each city's private link. It has no `node_modules/`, no built `dist/` and no `server/.env`: those are made in the next steps. Copy it to the server, then:

```sh
sudo -u digitwin -s                       # the rest of this step as that user
cd /opt/digitwin
unzip /path/to/DigiTwin-Generator.zip -d app   # the zip's actual name; its files are at the top of it ("unzip" package)
cd app
```

**Or from git:** `git clone <your repository URL> app` in `/opt/digitwin`, as the `digitwin` user. Two data sets are **not in git**: they're too large, and GitHub rejects files over 100 MB. Copy them from the development machine (or out of the zip) into the same paths. From that machine, in the project folder:

```sh
scp -r public/data/kanpur/tiles                            digitwin-host:/opt/digitwin/app/public/data/kanpur/
scp    public/data/kanpur/Kanpur_OpenBuildings_2_5D.geojson digitwin-host:/opt/digitwin/app/public/data/kanpur/
```

The two data sets:

- `public/data/kanpur/tiles/` (about 1.9 GB) is the pre-built 3D buildings. The site needs it.
- `public/data/kanpur/Kanpur_OpenBuildings_2_5D.geojson` (283 MB) is the source the tiles are built from. It's only needed to rebuild them, and as a fallback if `tiles/` is missing.

Then install and build:

```sh
npm ci                        # web app dependencies (also used by the city builder)
npm run build                 # -> dist/ (copies public/, so ~2.2 GB; takes ~15 s)
cd server && npm ci && cd ..  # server dependencies
```

Recent npm versions may warn that `esbuild`'s install script was not run (`npm warn allow-scripts`). Nothing needs doing: the build works without it.

## 3. Configure

```sh
cp server/.env.example server/.env
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # paste as ADMIN_TOKEN
chmod 600 server/.env
```

Edit `server/.env`. Every setting is explained in the file itself. The ones that matter for this setup:

| Setting | Value here | Why |
|---|---|---|
| `ADMIN_TOKEN` | the random value | Required. It unlocks the admin page: every uploaded city, its build logs, and deleting a city. |
| `HOST` | `127.0.0.1` | Only nginx can reach Node. |
| `TRUST_PROXY` | `loopback` | Without it, every visitor appears to come from nginx's address and they all share one upload quota. |
| `PUBLIC_API_BASE_URL` | *(blank)* | Blank makes cities use relative URLs, which work at any address. **Never** set it to `http://localhost:...`. |
| `WEATHER_API_KEY` | an OpenWeatherMap key, or blank | Live weather and the automatic day/night, for every city on the server, Kanpur included. Free at openweathermap.org. It is added to a city when the city is opened, so a new or changed key takes effect after a restart of the service; nothing is rebuilt. Blank: no live weather, and the Day / Night button switches by hand. |
| `EMBED_ALLOWED_ORIGINS` | **decide before going live**, see [Embedding](#embedding-in-airawatos-and-other-platforms) | Which sites may embed the viewer *and* control it through its API. Blank = any site. |
| `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | `1`, `http://proxy.example.ac.in:3128`, `localhost,127.0.0.1` | Only if outbound HTTPS must go through the institute proxy. Node ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is also set. |
| `MAX_UPLOAD_MB` | default 4096 (4 GB) | The largest buildings file accepted. 4 GB is about twice the largest Indian metro's: counted in Google Open Buildings, Delhi is 36 lakh buildings (about 1.4 GB) and Delhi with Gurgaon, Noida, Ghaziabad and Faridabad 54 lakh (about 2.1 GB). Kanpur is 7.3 lakh (283 MB). Every other file (a roads survey, an OpenStreetMap export) is limited to 500 MB whatever this is set to. The proxy in step 5 must allow at least as much. |
| `UPLOAD_TIMEOUT_MIN` | default 120 | How long one upload may take to arrive. 2 GB in two hours needs only 2.4 Mbit/s. (Node's own default is 5 minutes, which cut off a slow upload in testing.) |
| `BAKE_TIMEOUT_MIN` | default 120 | How long one city's build may run. Measured on a desktop PC: Kanpur builds in about 25 seconds, and a Delhi-sized test file (58 lakh buildings, 2.3 GB) in about 5 minutes, so 120 minutes leaves wide room for slower servers. Uploaders see a time-left estimate while their city builds. |
| `OSM_FETCH_TIMEOUT_MIN` | default 20 | How long the OpenStreetMap download may take for an ordinary city. A large area is asked for in parts, and each part after the first adds 2 minutes: a Delhi-sized area is 17 requests and gets 48 minutes (it took 7 when tested, with the public servers refusing more than half the requests). If the time runs out the city is still built with the layers that arrived, and the uploader is told which are missing. An area that would need more than 80 parts (about 1.5 × 1.5 degrees, a district rather than a city) is not downloaded at all. |
| `BUILDINGS_FETCH_TIMEOUT_MIN` | default 90 | How long downloading a city's buildings from Google Open Buildings may take, when the uploader chose that. Kanpur is about 0.7 GB and took about 6 minutes on a fast line; a metro is several times that. If it runs out, the build stops and says so. |

## 4. Run it as a service

`/etc/systemd/system/digitwin.service`:

```ini
[Unit]
Description=DigiTwin Generator
After=network-online.target
Wants=network-online.target

[Service]
User=digitwin
WorkingDirectory=/opt/digitwin/app/server
ExecStart=/usr/bin/node --env-file=.env app.js
Restart=on-failure
RestartSec=5
# Let a build child process finish writing before a stop turns into a kill.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now digitwin
journalctl -u digitwin -f     # expect "listening on http://127.0.0.1:8787" and "serving the front end from .../dist"
```

Builds survive restarts: a build that was queued or running when the service stopped starts again from the beginning (up to 3 attempts).

## 5. nginx in front

`/etc/nginx/sites-available/digitwin` (enable it with a symlink into `sites-enabled/`):

```nginx
# Keep admin links (?admin=<token>) out of the access log.
map $arg_admin $digitwin_loggable { "" 1; default 0; }

server {
    listen 80;
    server_name digitwin.example.ac.in;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    # http2 on;   # nginx >= 1.25.1 (older: "listen 443 ssl http2;") -- helps tiles load in parallel
    server_name digitwin.example.ac.in;

    ssl_certificate     /etc/ssl/certs/digitwin.example.ac.in.crt;
    ssl_certificate_key /etc/ssl/private/digitwin.example.ac.in.key;

    access_log /var/log/nginx/digitwin.access.log combined if=$digitwin_loggable;

    # Uploads: one buildings file can be up to MAX_UPLOAD_MB (4096 MB = 4 GB),
    # plus optional municipal files in the same request, so allow a little
    # more than that. Stream straight to Node: with buffering on, nginx would
    # first write the whole upload to its own temp folder.
    client_max_body_size 5g;
    proxy_request_buffering off;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;

    # 3D tiles are raw typed arrays and compress to ~17% (measured on Kanpur's
    # tiles; GeoJSON ~26%): a first visit drops from ~205 MB to ~40 MB.
    # gzip_proxied any: campus proxies add a Via header, which otherwise turns gzip off.
    gzip on;
    gzip_proxied any;
    gzip_comp_level 4;
    gzip_min_length 1024;
    gzip_types application/octet-stream application/json application/geo+json
               application/javascript text/css text/markdown image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Do not add `X-Frame-Options`** here or in a global nginx include (some hardening templates add `X-Frame-Options: SAMEORIGIN` everywhere). It stops other sites and platforms from embedding the viewer. The app sets its own, finer-grained `Content-Security-Policy: frame-ancestors` from `EMBED_ALLOWED_ORIGINS`.

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Using **Apache** instead (with `mod_proxy`, `mod_proxy_http`, `mod_headers`, `mod_deflate` and `mod_ssl` enabled), the equivalent of the `443` block is:

```apache
<VirtualHost *:443>
    ServerName digitwin.example.ac.in
    SSLEngine on
    SSLCertificateFile    /etc/ssl/certs/digitwin.example.ac.in.crt
    SSLCertificateKeyFile /etc/ssl/private/digitwin.example.ac.in.key

    # 0 = no limit here; the app enforces MAX_UPLOAD_MB itself. Apache's own
    # limit can't be set above 2 GB, which is less than a metro's buildings file.
    LimitRequestBody 0
    ProxyTimeout 600
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass        / http://127.0.0.1:8787/
    ProxyPassReverse / http://127.0.0.1:8787/

    AddOutputFilterByType DEFLATE application/octet-stream application/json application/geo+json application/javascript text/css text/markdown image/svg+xml
</VirtualHost>
```

## 6. Firewall

Open 443, plus 80 for the redirect and Let's Encrypt renewals. Keep 8787 closed. With `HOST=127.0.0.1` Node doesn't listen on outside interfaces anyway.

```sh
sudo ufw allow 80,443/tcp      # or the firewalld / institute-firewall equivalent
```

## 7. Check it works

```sh
curl -s http://127.0.0.1:8787/api/health            # {"ok":true}
curl -sI https://digitwin.example.ac.in/ | head -5  # 200, text/html
curl -s -o /dev/null -w '%{size_download} bytes\n' -H 'Accept-Encoding: gzip' \
  https://digitwin.example.ac.in/data/kanpur/tiles/manifest.json   # much smaller than 308370 = compression is on
```

In a browser, from a machine other than the server:

1. Open `https://digitwin.example.ac.in/`. Kanpur loads (a few seconds on a fast link), and the top bar shows the time and, if `WEATHER_API_KEY` is set, the weather.
2. Press **Share**, copy the link, and open it in another browser or on another computer. It opens at the same view.
3. Upload a small test city (**Upload a city**, draw a small area, attach a buildings GeoJSON). Its Review & build page should reach "Your city is live", and **View your city** should open it. The OpenStreetMap step shows whether outbound access or the proxy works.
4. Open `https://digitwin.example.ac.in/?admin=<ADMIN_TOKEN>`. The test city is listed; delete it from there.

## Embedding in AirawatOS and other platforms

- The embed code comes from the viewer's **Share** panel. Developers of the host platform should read `https://digitwin.example.ac.in/EMBED.md`, the link parameters and control API reference.
- The embedded frame needs at least 480 × 360 px. The embed code sets that as its minimum.
- **Both sides must use HTTPS.** Browsers block an `http://` iframe inside an `https://` page (mixed content).

### Decision for IT: which sites may embed and control the viewer

A site that embeds the viewer can also drive it through its control API. It can fly the camera, search, and switch day/night. It also **receives what users click**: building heights and types, road names, and ward names and populations. For an uploaded city, that data belongs to a *private* city, which is only reachable through its secret link.

`EMBED_ALLOWED_ORIGINS` is the one setting for this. The server sends it as a `Content-Security-Policy: frame-ancestors` header, so the browser refuses to show the viewer inside any site not on the list. That also means no other site can send it commands or receive its click events. The app has no second list to maintain.

| Choose | Set | When |
|---|---|---|
| Only named platforms (recommended once live) | `EMBED_ALLOWED_ORIGINS=https://airawat.example.ac.in,https://partner.example.com` | You know which platforms will embed it. Exact origins: scheme + host (+ port), no path, no trailing slash. |
| Any site | leave blank | Open embedding of public cities, e.g. Kanpur, on any website. |

Plain-`http://` sites can't embed the HTTPS twin anyway (see above), so an allowlist of `https://` origins also covers "secure sites only". After changing the setting, restart the service (`sudo systemctl restart digitwin`). Check it by embedding from a listed site and from an unlisted one: the unlisted one should show a blank frame, with a `frame-ancestors` message in the browser console.

## Managing uploaded cities

There is no approval step. An uploaded city goes live as soon as its build finishes, and only people who have its private link can open it. The admin page is where you see what has been uploaded and remove what shouldn't be there:

- Open `https://digitwin.example.ac.in/?admin=<ADMIN_TOKEN>`. It lists every uploaded city with its status (live, building, build failed, files cleared).
- For each city you can **Open** it in the viewer, read its **Build log**, or **Delete** it. Delete asks for confirmation, then permanently removes the city's files and records, and its link stops working.
- The same list is available as `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://digitwin.example.ac.in/api/admin/cities`. See `server/README.md` → "The admin page".

Treat `ADMIN_TOKEN` like a password: anyone with the admin link can delete any city. The nginx config above keeps admin links out of its access log. Change the token in `server/.env` and restart if it leaks.

## Backups

Everything that changes lives in `server/storage/`:
- `app.db` (plus `app.db-wal` and `app.db-shm`), the database;
- `uploads/`, the uploaded source files;
- `cities/`, the built tiles.

For a consistent copy:

```sh
sudo systemctl stop digitwin
sudo tar czf /backup/digitwin-storage-$(date +%F).tgz -C /opt/digitwin/app/server storage
sudo systemctl start digitwin
```

`cities/` can be rebuilt from `uploads/` by resubmitting ("Revise and resubmit"), so if space is tight, back up `app.db` and `uploads/` daily and `cities/` less often. Also keep one copy of `public/data/kanpur/` (step 2): its large files aren't in git (they are in the handover zip).

## Updating

An update comes as a new zip. Unpack and build it next to the running copy, then stop the service, move the settings and data across, and swap the folders:

```sh
sudo -u digitwin -s
cd /opt/digitwin
unzip /path/to/DigiTwin-Generator.zip -d app-new        # the new zip
cp app/server/.env app-new/server/.env
cd app-new && npm ci && npm run build && cd server && npm ci
exit
sudo systemctl stop digitwin
sudo -u digitwin sh -c 'cd /opt/digitwin && rm -rf app-new/server/storage && mv app/server/storage app-new/server/storage && mv app app-old && mv app-new app'
sudo systemctl start digitwin     # delete /opt/digitwin/app-old once the new version works
```

The `rm -rf` drops the copy of the cities that came in the zip: the running copy's `storage/` is newer, and `mv` onto an existing folder would put it inside that folder instead of replacing it.

With a git checkout instead (step 2's other route): `git pull` in `/opt/digitwin/app` as the `digitwin` user, then `npm ci && npm run build`, `cd server && npm ci`, and `sudo systemctl restart digitwin`.

The database upgrades itself on start. The service log prints a line for each migration step.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Embedded viewer is blank, or says it "refused to connect" | nginx or a global include adds `X-Frame-Options`; the host site isn't in `EMBED_ALLOWED_ORIGINS`; or the host page is HTTPS and the twin is HTTP. |
| Uploads fail almost immediately ("413 Request Entity Too Large") | `client_max_body_size` / `LimitRequestBody` is too small. It must be at least `MAX_UPLOAD_MB`. |
| The upload form turns a file away as soon as it is chosen ("this server takes files up to …") | The file is over `MAX_UPLOAD_MB`. Only the buildings file may be that large; every other file is limited to 500 MB. |
| Uploads of large files fail after a minute or two | Proxy timeouts, or `proxy_request_buffering` left on with a small temp disk. |
| A large upload on a slow connection stops after two hours | It ran past `UPLOAD_TIMEOUT_MIN`. Raise it. |
| A very large city's build fails with "the server ran out of memory" | The machine has too little RAM for that many buildings (see "What you need"). |
| Everyone gets "too many uploads in progress" | `TRUST_PROXY` isn't set, so all visitors share nginx's address. |
| A build stops at "Downloading buildings from Google Open Buildings" | The Review & build page gives the reason. "Google Open Buildings has no footprints for this area": the city is outside Google's coverage (Africa, South and Southeast Asia, Latin America, the Caribbean), so the uploader attaches a buildings file instead. A network error or a timeout: check outbound access to `storage.googleapis.com` and the proxy settings (the build log is on the admin page → Build log). "This script needs updating": Google has changed its files; uploaders can attach a file meanwhile (DATA_SOURCES.md). |
| Built cities have no roads, land use or water | The city's Review & build page says why. "This server can't reach OpenStreetMap at all": check outbound access and the proxy settings (the build log is on the admin page → Build log). "OpenStreetMap's servers were too busy": nothing is wrong here. The public servers turn requests away at busy hours. The parts that did arrive are kept for a week, so revising the city asks only for the rest. |
| A shared city link works on the server itself but not elsewhere | That city was built while `PUBLIC_API_BASE_URL` pointed at localhost. Blank `PUBLIC_API_BASE_URL`, restart, and rebuild the city ("Revise and resubmit"). |
| First visit is slow on the campus network | Compression is off. Re-check the `gzip` lines and `gzip_proxied any`. |
| A metro-sized city is slow to open | Check compression first, as above. A large city loads only the part around the visitor: the first view of the Delhi-sized test city is about 240 MB before compression (Kanpur: 205 MB), and about 65 MB with the `gzip` lines on (its building tiles compress to 21%, its road tiles to 51%). Each new part of the city a visitor moves to is a further download. |

## Quick LAN-only setup (no IT involvement)

For a demo on the local network only, with no HTTPS, domain or proxy:

```sh
npm ci
npm run build
cd server
npm ci
cp .env.example .env    # set ADMIN_TOKEN, leave HOST blank
npm start               # then open http://<this machine's IP>:8787
```

These lines work in Windows PowerShell as well as a Linux shell. For a first time on Windows, [README.md](README.md#run-it-on-your-own-windows-pc), "Run it on your own Windows PC", explains each step. On Windows, allow Node.js through the firewall prompt the first time. The machine's LAN IP can change after a reboot or on another network, and links to it break when it does. That's one reason to use a real hostname.
