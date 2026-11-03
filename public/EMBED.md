# Embedding a DigiTwin city

This guide is for developers who want to show a DigiTwin city inside their own site or platform (AirawatOS, a dashboard, a client portal), and optionally control it from their page.

## 1. Get the link

Open the city and press **Share** (the share icon in the right-hand button column). The panel gives you two things:

- **Link**: opens the city in a browser tab. With **Open at the current view** ticked, it opens exactly where your camera is.
- **Embed code**: an `<iframe>` you paste into your page.

Links to uploaded cities contain the city's private key (`t=…`). Anyone who has the link can open the city, so share it only with people who should see it.

## 2. Link parameters

| Parameter | Example | Meaning |
|---|---|---|
| `city`, `t` | `city=abc123&t=…` | Which uploaded city to open, and its access key. Leave both out for the default city. |
| `view` | `view=26.46531,80.34970,700,0,45` | Start at this view: `lat,lon,distance,heading,tilt`. Only `lat,lon` are required. |
| `embed` | `embed=1` | Embedded layout: no top bar, and a small **Open full view ↗** link in the corner. Turns on the control API below. |

The five `view` values:
- `lat,lon`: the ground point the camera looks at (WGS 84 degrees).
- `distance`: how far the camera is from that point, in metres.
- `heading`: the compass direction the camera faces (0 = north, 90 = east).
- `tilt`: degrees from straight down (0 = top-down, about 88 = at the horizon).

## 3. The iframe

```html
<iframe id="twin"
  src="https://YOUR-TWIN-ADDRESS/?embed=1&view=26.46531,80.34970,900,0,50"
  title="Kanpur digital twin" width="100%" height="600"
  style="border:0;min-width:480px;min-height:360px" allow="fullscreen" loading="lazy"></iframe>
```

**Size.** Give the frame at least **480 × 360 px**. That is the smallest size at which all of the viewer's controls fit without overlapping, and the embed code from the Share panel carries it as `min-width` / `min-height`. The frame can be as large as you like above that. From 720 px wide, a strip along the bottom also shows the mouse controls.

The viewer is a WebGL 3D scene, driven with a mouse or trackpad. It works in any modern desktop browser; phones and touch-only use are not supported.

If the embed shows a blank frame or a "refused to connect" message, the twin's server is limiting which sites may embed it. Ask its administrator to add your site's origin to `EMBED_ALLOWED_ORIGINS` (see HOSTING.md in the project).

## 4. Control API (postMessage)

Your page and the embedded viewer talk through `window.postMessage`. Every message, in both directions, is an object with `source: "digitwin"` and a `type`.

### Getting started

```js
const frame = document.getElementById('twin');
const TWIN_ORIGIN = 'https://YOUR-TWIN-ADDRESS';   // the iframe's origin

window.addEventListener('message', (e) => {
  if (e.origin !== TWIN_ORIGIN || e.data?.source !== 'digitwin') return;
  const msg = e.data;
  if (msg.type === 'ready') send({ type: 'hello', id: 1 });   // the viewer has loaded; say hello to receive events
  if (msg.type === 'click') console.log('clicked', msg);
  if (msg.type === 'viewChanged') console.log('camera now at', msg.view);
  if (msg.type === 'response') console.log('reply to', msg.id, msg.ok ? msg.result : msg.error);
});

function send(command) {
  frame.contentWindow.postMessage({ source: 'digitwin', ...command }, TWIN_ORIGIN);
}
```

The viewer posts `ready` once it has finished loading. Your first message (normally `hello`) connects your page. From then on the viewer sends its events to your page's origin only, and accepts commands only from that origin.

### Commands (your page → viewer)

Add an `id` (any number or string) to any command to get a `response` with the same `id`.

| `type` | Fields | What it does | `result` |
|---|---|---|---|
| `hello` | | Connects your page (starts events). | `{ version, city: { id, name }, view }` |
| `getView` | | Reads the current camera view. | `{ lat, lon, distance, heading, tilt }` |
| `setView` | `view: { lat, lon, distance?, heading?, tilt? }`, `animate?` (default `true`) | Moves the camera. Missing fields keep their current values. | `null` |
| `flyTo` | `lat`, `lon`, `distance?` (default 700 m) | Flies to a point, keeping the current heading and tilt. | `null` |
| `search` | `query` | Finds a place, road or building by name (the same search as the in-app search box), flies there and highlights it. | `{ found: false }` or `{ found: true, name, type, lat, lon }` |
| `setNight` | `night: true \| false` | Switches the scene to night or day. After this, live weather no longer switches it automatically. | `null` |
| `resetNorth` | | Turns the camera to face north. | `null` |

Errors come back as `{ type: "response", id, ok: false, error: "…" }`, for example for an unknown command or a missing field.

### Events (viewer → your page)

| `type` | Fields | When |
|---|---|---|
| `ready` | `version`, `city: { id, name }` | Once, when the viewer has loaded. Sent before `hello`. |
| `click` | `kind`, `lat`, `lon`, plus fields for that kind | The user clicked the scene. |
| `viewChanged` | `view: { lat, lon, distance, heading, tilt }` | The camera moved and has settled (a quarter-second after the last movement). |
| `response` | `id`, `ok`, `result` or `error` | The reply to a command that carried an `id`. |

The `click` event's `kind` is one of:
- **`building`**: `height` (m), `type` (`worship`, `health`, `education`, `industrial`, `commercial`, or `null`), `source`.
- **`road`**: `name`, `length_m`, `area_m2`, `ward`, `zone`.
- **`ward`**: `name`, `wardno`, `zone`, `population`.
- **`zone`**: `zone_id`.
- **`landmark`**: `name`. There are no `lat`/`lon` for this kind.
- **`null`**: the click hit nothing (bare ground).

`lat`/`lon` give the clicked point on the ground. Fields a city's data doesn't have come back as `null`.

### Example: a "go to" box on your page

```js
document.querySelector('#goto').addEventListener('submit', (ev) => {
  ev.preventDefault();
  send({ type: 'search', query: ev.target.q.value, id: 'goto' });
});
```

## Versioning

`ready` and `hello` report `version` (currently `1`). New commands and event fields may be added within a version; nothing existing is removed or renamed without a version change.
