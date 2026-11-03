// ===================================================================
// adminAuth.js -- the one gate on every /api/admin/* route ("one
// admin, so a shared secret is enough; no admin login system").
// Accepts the token as an `Authorization: Bearer` header (what the admin
// pages and curl send) or, for older scripts, a `?token=` query param --
// avoid the latter: a URL is written to every reverse-proxy access log.
// Either way it's compared with crypto.timingSafeEqual, never `===`, so a
// partial match can't be timed out of the server.
// ===================================================================
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function tokensMatch(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  // Different lengths would make timingSafeEqual throw, not return false --
  // and comparing length first leaks only the length of the correct token,
  // which is already public (it's in .env.example's example command).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAdminToken(req, res, next) {
  const header = req.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer ?? req.query.token ?? null;
  if (!tokensMatch(provided)) return res.status(401).json({ error: 'missing or invalid admin token' });
  next();
}
