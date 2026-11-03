// ===================================================================
// WeatherController — OpenWeatherMap fetch driving automatic day/night
// (from real sunrise/sunset) and weather mood (fog/light/rain). The API
// endpoint, key and refresh interval are CityConfig.weather, which the
// server adds when a city is opened (server/lib/siteWeather.js). With no
// key there, the scene keeps the day palette and its own Day / Night button.
// ===================================================================
export function owmIdToMood(id) {
  if (id === 800) return 'sun';
  // 803 (broken clouds, 51-84% cover) still lets the sun through in gaps
  // often enough to cast real shadows, unlike 804 (85-100%, genuinely
  // diffuse light) -- bucketed with 801/802 instead of 804 for that reason.
  if (id === 801 || id === 802 || id === 803) return 'cloudy';
  if (id === 804) return 'overcast';
  if (id >= 700 && id < 800) return 'overcast'; // mist/fog/haze -- closest visual analog
  return 'rain'; // thunderstorm/drizzle/rain/snow -- one bucket
}
/** @param {string} iconCode - OpenWeatherMap's own code, e.g. "10d" -- encoded anyway: it arrives over the network */
function owmIconUrl(iconCode) {
  return `https://openweathermap.org/img/wn/${encodeURIComponent(iconCode)}@2x.png`;
}

export class WeatherController {
  constructor({ cityConfig, paletteController, weatherEl }) {
    this.cityConfig = cityConfig;
    this.paletteController = paletteController;
    this.weatherEl = weatherEl;
    this.manualOverride = false; // true while day/night was chosen by hand (the toolbar's Day / Night button, the embed API's setNight), so the periodic refresh won't undo it
    this._actualNight = null;    // whether it really is night at the city right now; null until a weather fetch has said
  }

  start() {
    this._fetch();
    setInterval(() => this._fetch(), this.cityConfig.weather?.refreshMs ?? 15 * 60 * 1000);
  }

  /**
   * The toolbar's Day / Night button: shows the other one. That is an
   * override only while it differs from the real time of day -- switching
   * back to what it really is hands day/night back to sunrise and sunset.
   */
  toggleManualPalette() {
    const night = this.paletteController.paletteName !== 'night';
    this.paletteController.applyPalette(night ? 'night' : 'day');
    this.manualOverride = this._actualNight === null || night !== this._actualNight;
  }

  async _fetch() {
    const { endpoint, apiKey } = this.cityConfig.weather ?? {};
    if (!this.weatherEl) return;
    if (!apiKey) { this.weatherEl.textContent = '· Weather: API key not configured'; return; }

    const { lon, lat } = this.cityConfig.origin;
    const url = `${endpoint}?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // OWM's free tier returns 429 once too many requests land in a
        // short window, and 401 for a few hours after a brand-new key is
        // created -- both look identical to a dropped connection unless
        // the status makes it into the message shown on screen.
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
      }
      const data = await res.json();

      const nowMs = Date.now();
      const sunriseMs = (data.sys?.sunrise ?? 0) * 1000, sunsetMs = (data.sys?.sunset ?? 0) * 1000;
      if (sunriseMs && sunsetMs) {
        this._actualNight = nowMs < sunriseMs || nowMs >= sunsetMs;
        if (!this.manualOverride) this.paletteController.applyPalette(this._actualNight ? 'night' : 'day');
      }
      const conditionId = data.weather?.[0]?.id;
      if (conditionId != null) this.paletteController.applyWeatherMood(owmIdToMood(conditionId));

      const temp = Math.round(data.main?.temp ?? NaN);
      const icon = data.weather?.[0]?.icon;
      const desc = String(data.weather?.[0]?.description ?? '');
      // Built from DOM nodes, not an HTML string: the description is text from
      // a third-party API, and text is what it must stay.
      const img = icon ? Object.assign(document.createElement('img'), { src: owmIconUrl(String(icon)), alt: desc }) : null;
      this.weatherEl.replaceChildren('· ', ...(img ? [img] : []), `${Number.isFinite(temp) ? `${temp}°C` : '—'}${desc ? ` ${desc}` : ''}`);
      this.weatherEl.title = '';
    } catch (err) {
      console.warn('[WeatherController] fetch failed:', err);
      // A short reason inline (network vs. a specific HTTP status, e.g. 429
      // rate-limited or 401 not-yet-active) instead of a bare "unavailable"
      // that looks identical whether the network dropped for a second or
      // the API key got rate-limited for the rest of the day -- the full
      // error still goes to the console via the warn above for anyone who
      // needs the raw text.
      const reason = err instanceof TypeError ? 'network' : (err.message?.match(/^HTTP (\d+)/)?.[0] ?? 'error');
      this.weatherEl.textContent = `· Weather unavailable (${reason})`;
      this.weatherEl.title = String(err.message ?? err);
    }
  }
}
