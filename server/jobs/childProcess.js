// ===================================================================
// childProcess.js -- the one way a build step runs a Node script out of
// process (the building-tile bake, the OpenStreetMap download), so the
// server's event loop never blocks on CPU-heavy work and keeps answering
// status polls while a build runs. Captures stdout+stderr as the job log,
// hands each output line to the caller as it arrives (live progress),
// enforces a timeout, and can be cancelled (the uploader deleting a city
// mid-build).
// ===================================================================
import { spawn } from 'node:child_process';

const MAX_LOG_CHARS = 200_000; // defensive cap -- these scripts only print progress lines, but never trust a child process not to misbehave
const SIGKILL_GRACE_MS = 10_000; // time to let SIGTERM flush open file writes before escalating -- long enough for normal I/O, short enough not to hang the single-slot job queue on a stuck process

/**
 * @param {string} scriptPath
 * @param {string[]} args - already sanitized by the caller
 * @param {{timeoutMs: number, onLine?: (line: string) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, exitCode: number|null, logText: string, timedOut: boolean, cancelled: boolean}>}
 */
export function runNodeScript(scriptPath, args, { timeoutMs, onLine, signal }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    let timedOut = false;
    let cancelled = false;
    const appendLog = (chunk) => {
      if (log.length < MAX_LOG_CHARS) log += chunk.toString();
    };
    // Both streams are logged, and both are read line by line: progress
    // arrives on stdout, a script's own explanation of a failure on stderr.
    for (const stream of [child.stdout, child.stderr]) {
      let partial = ''; // text after the last newline, waiting for the rest of its line
      stream.on('data', (chunk) => {
        appendLog(chunk);
        if (!onLine) return;
        const lines = (partial + chunk.toString()).split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) { try { onLine(line); } catch { /* a progress glitch must never kill the build */ } }
      });
    }

    // Two-step escalation: SIGTERM first so a normally-behaving Node
    // process gets a chance to flush its open file writes and exit
    // cleanly, then SIGKILL after a grace period for a process that's
    // stuck (e.g. blocked in a synchronous loop that never checks for
    // the signal). Both timers are cleared in `close` below so neither
    // can fire after the child has already exited on its own.
    let killTimer = null;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (exitCode) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({ ok: exitCode === 0 && !timedOut && !cancelled, exitCode, logText: log, timedOut, cancelled });
    });
  });
}
