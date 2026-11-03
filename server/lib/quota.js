// ===================================================================
// quota.js -- the per-uploader quota: how many of one uploader's cities
// may be building or waiting to build at once. Keyed by
// cities.uploader_key: "ip:<address>" of the uploading browser (uploads
// ask for no email or account -- see routes/uploads.js). It's not an
// identity: everyone behind one NAT shares a key, and anyone can change
// networks. This exists to stop accidental pile-up
// (someone re-submitting after a mistake, a broken client
// retry-looping), not to defend against a determined attacker -- the
// backstop for real abuse is putting the upload endpoint behind a
// reverse-proxy auth layer, which is the self-hoster's call, not
// something this app builds.
//
// Only applies to a brand-new upload (POST /uploads) -- reviving/
// revising an EXISTING city doesn't grow anyone's city count, so
// routes/uploads.js never calls this for /:cityId/revise.
// ===================================================================
import { config } from '../config.js';

/** @throws {Error} with a plain-language message if the uploader already has too many builds in progress */
export function assertWithinQuota(db, uploaderKey) {
  const { concurrent } = db.prepare(
    `SELECT COUNT(*) AS concurrent FROM cities WHERE uploader_key = ? AND status = 'processing'`
  ).get(uploaderKey);
  if (concurrent >= config.maxConcurrentUploadsPerUploader) {
    const err = new Error(`You already have ${concurrent} build(s) in progress (the limit is ${config.maxConcurrentUploadsPerUploader}). Wait for one to finish before starting another.`);
    err.status = 429;
    throw err;
  }
}
