// ===================================================================
// routes/cities.js -- GET /api/cities/:cityId/config, the ONE route a
// non-admin viewer actually calls to render a city (main.js's public
// ?city=<id>&t=<token> branch). This is the real access gate: the
// cityId slug alone is unguessable, but this route still requires the
// matching access_token. The stored config is served with this site's
// weather settings added (lib/siteWeather.js).
//
// Gated on current_job_id being set, NOT on status === 'live' -- those
// are different things once revisions exist. `status` reflects how the
// city's LATEST submission went; `current_job_id` is which job is
// actually being served. A city mid-revision can be status='processing'
// (or, if that revision's build then fails, status='failed') while
// current_job_id still points at an earlier build that must keep
// serving unbroken -- "your city is still available, never an
// unexplained gap" is a requirement, not an edge case to special-case
// away.
// ===================================================================
import express from 'express';
import { withSiteWeather } from '../lib/siteWeather.js';
import { accessTokenMatches } from '../lib/ids.js';

export function citiesRouter(db) {
  const router = express.Router();

  const cityStmt = db.prepare(`SELECT id, status, access_token, current_job_id FROM cities WHERE id = ?`);
  const jobConfigStmt = db.prepare(`SELECT config_json FROM jobs WHERE id = ?`);

  router.get('/:cityId/config', (req, res) => {
    const city = cityStmt.get(req.params.cityId);
    // Same city-not-found vs. wrong-token response either way -- a wrong
    // token must not be able to distinguish "no such city" from "that
    // city exists but isn't yours".
    if (!city || !accessTokenMatches(city.access_token, req.query.t)) return res.status(404).json({ error: 'not found' });

    if (!city.current_job_id) {
      return res.status(409).json({ error: `city has no finished build yet (status: ${city.status})`, status: city.status });
    }

    const job = jobConfigStmt.get(city.current_job_id);
    if (!job?.config_json) {
      // Shouldn't happen -- jobHooks.js writes a job's config_json and
      // points current_job_id at it in one transaction -- but fail loudly
      // rather than serve a viewer a response it can't validate.
      return res.status(500).json({ error: 'internal: live city has no config on its current job' });
    }
    res.json({ config: withSiteWeather(JSON.parse(job.config_json)) });
  });

  return router;
}
