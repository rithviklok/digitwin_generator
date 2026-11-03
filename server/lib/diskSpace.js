// ===================================================================
// diskSpace.js -- disk pre-flight checks. Checked
// TWICE, on purpose, per two different questions:
//   1. At upload time (routes/uploads.js's pre-step), against the raw
//      Content-Length -- reject an obviously-doomed upload before
//      spending bandwidth/time receiving it.
//   2. At bake time (jobRunner.js, right before spawning the child
//      process), against the ACTUAL uploaded file's exact size -- a
//      second, more accurate check, since free space may also have
//      changed since step 1 (other uploads/bakes in between).
// Both use the SAME estimate: raw input size x bakeSizeMultiplier
// (Kanpur's own measured ~7x input->output ratio), because that's the
// only real data point this project has for "how big does a bake get."
// ===================================================================
import checkDiskSpace from 'check-disk-space';
import { config } from '../config.js';

/**
 * @param {string} checkPath - any path on the target disk (storageRoot works; the file needn't exist)
 * @param {number} rawInputBytes
 * @throws {Error} with a plain-language message if projected usage would leave less than minFreeSpaceGb free
 */
export async function assertEnoughDiskSpace(checkPath, rawInputBytes) {
  const { free } = await checkDiskSpace(checkPath);
  const projectedBytes = rawInputBytes * config.bakeSizeMultiplier;
  const minFreeBytes = config.minFreeSpaceGb * 1024 * 1024 * 1024;
  const remainingAfter = free - projectedBytes;

  if (remainingAfter < minFreeBytes) {
    const gb = (n) => (n / (1024 * 1024 * 1024)).toFixed(1);
    const err = new Error(
      `Not enough disk space to safely process this upload: baking a ~${gb(rawInputBytes)}GB input typically needs ~${gb(projectedBytes)}GB ` +
      `(this server's measured ~${config.bakeSizeMultiplier}x ratio), which would leave only ${gb(free - projectedBytes)}GB free ` +
      `(minimum required: ${config.minFreeSpaceGb}GB). Free up disk space and try again.`
    );
    err.status = 507; // Insufficient Storage
    throw err;
  }
}
