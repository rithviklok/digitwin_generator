// ===================================================================
// siteWeather.js -- the weather settings every city on this server is
// shown with. There is one OpenWeatherMap key for the whole site
// (WEATHER_API_KEY in .env), and it is added to a city's config when the
// city is OPENED, not when it is built: set or change the key and every
// city, the built-in one included, has it at the next page load. Nothing
// is rebuilt, and no key is kept in the code or in a built city.
//
// The key is not a secret from visitors: their browsers call
// OpenWeatherMap with it (src/controllers/WeatherController.js).
// ===================================================================
import { config } from '../config.js';

const ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';
const REFRESH_MS = 15 * 60 * 1000;

/** @returns {{endpoint: string, refreshMs: number, apiKey: string}|null} null when no key is set: cities are then shown without live weather */
export function siteWeather() {
  return config.weatherApiKey ? { endpoint: ENDPOINT, refreshMs: REFRESH_MS, apiKey: config.weatherApiKey } : null;
}

/** A built city's stored config as it is served now: with this site's weather settings, whatever it was built with. */
export function withSiteWeather(cityConfig) {
  const { weather: _asBuilt, ...rest } = cityConfig;
  const weather = siteWeather();
  return weather ? { ...rest, weather } : rest;
}
