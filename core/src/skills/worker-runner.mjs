/**
 * Partner skill worker harness (M8, PLAN-M8.md).
 *
 * Plain Node ESM — imports NO project packages (no @partner/*, no tsx): it
 * is forked by the core runner via `child_process.fork` with `execArgv: []`
 * so the skill entry may import only node builtins. The entry gets a small
 * `partner` global as its ONLY interface to the core:
 *
 *   partner.log(text)                    -> {type:'log'}   (parent redacts)
 *   partner.tools.exec(toolId, params)   -> {type:'tools.exec'} request,
 *                                           resolved/rejected by the
 *                                           {type:'tools.result'} reply
 *
 * Protocol (parent -> worker): {type:'invoke', argsText}
 *            (worker -> parent): {type:'ready'}
 *                                {type:'log', line}
 *                                {type:'tools.exec', toolId, params, nonce}
 *                                {type:'result', ok:true, text}   |   {type:'result', ok:false, error}
 *
 * The result payload rides as a JSON TEXT so BOTH ends enforce the 1 MiB cap
 * on the serialized size. The worker exits(0) after one result; the parent
 * owns the budget timer + kill (this file never reads the clock).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const skillDir = process.env.PARTNER_SKILL_DIR ?? '';
const entry = process.env.PARTNER_SKILL_ENTRY ?? '';
const maxResultBytes = Number(process.env.PARTNER_SKILL_MAX_RESULT_BYTES ?? 1024 * 1024);
const MAX_CONCURRENT_TOOLS = 8;
const MAX_ERROR_CODE = 200;

function send(message) {
  if (typeof process.send !== 'function') return;
  try {
    process.send(message);
  } catch {
    // Channel closed (parent gone) — nothing left to do.
  }
}

function errorCodeOf(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code !== '') {
    return err.code.slice(0, MAX_ERROR_CODE);
  }
  return 'skill_error';
}

// Crash-to-log: an uncaught error in skill code becomes a redacted log line
// on the core console + exit(1) (the parent maps that to 'crashed').
process.on('uncaughtException', (err) => {
  try {
    send({ type: 'log', line: `skill uncaught: ${err instanceof Error ? err.message : String(err)}` });
  } catch {
    // Ignore — channel is gone.
  }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  try {
    send({ type: 'log', line: `skill unhandled rejection: ${err instanceof Error ? err.message : String(err)}` });
  } catch {
    // Ignore.
  }
  process.exit(1);
});

let inFlight = 0;

/** The `partner` global — the skill's only window into the core. */
const partner = {
  log(line) {
    send({ type: 'log', line: String(line ?? '') });
  },
  tools: {
    exec(toolId, params) {
      if (typeof toolId !== 'string' || toolId === '') {
        const err = new Error('tool_denied');
        err.code = 'tool_denied';
        return Promise.reject(err);
      }
      if (inFlight >= MAX_CONCURRENT_TOOLS) {
        const err = new Error('tool_denied');
        err.code = 'tool_denied';
        return Promise.reject(err);
      }
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      inFlight += 1;
      return new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (!msg || msg.type !== 'tools.result' || msg.nonce !== nonce) return;
          process.removeListener('message', onMessage);
          if (msg.ok === true) {
            resolve(msg.result);
          } else {
            const code = typeof msg.error === 'string' && msg.error !== '' ? msg.error : 'tool_denied';
            const err = new Error(code);
            err.code = code;
            reject(err);
          }
        };
        process.on('message', onMessage);
        send({ type: 'tools.exec', toolId, params, nonce });
      }).finally(() => {
        inFlight -= 1;
      });
    },
  },
};

// eslint-disable-next-line no-undef -- the skill's runtime global
globalThis.partner = partner;

if (skillDir === '' || entry === '') {
  send({ type: 'log', line: 'worker misconfigured: PARTNER_SKILL_DIR/PARTNER_SKILL_ENTRY missing' });
  process.exit(1);
}

// Load the skill entry BEFORE the handshake: an import-time failure (syntax
// error, missing file, top-level throw) crashes the worker with no result,
// which the parent classifies as 'crashed'.
let mod;
try {
  mod = await import(pathToFileURL(join(skillDir, entry)).href);
} catch (err) {
  send({
    type: 'log',
    line: `skill load failed: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(1);
}

const candidate = mod && typeof mod === 'object' ? mod.default ?? mod : mod;
const runFn =
  typeof candidate === 'function'
    ? candidate
    : candidate && typeof candidate.run === 'function'
      ? candidate.run
      : null;

if (runFn === null) {
  send({ type: 'log', line: 'skill entry must export a run(args) function (default export or named)' });
  process.exit(1);
}

let settled = false;

function sendOkResult(text) {
  send({ type: 'result', ok: true, text });
}

function sendErrResult(code) {
  send({ type: 'result', ok: false, error: code });
}

function finalizeOk(value) {
  if (settled) return;
  settled = true;
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch {
    sendErrResult('skill_error');
    return;
  }
  if (text === undefined) text = 'null';
  if (Buffer.byteLength(text, 'utf8') > maxResultBytes) {
    sendErrResult('caps_exceeded');
    return;
  }
  sendOkResult(text);
}

function finalizeError(err) {
  if (settled) return;
  settled = true;
  sendErrResult(errorCodeOf(err));
}

process.on('message', (msg) => {
  if (!msg || msg.type !== 'invoke' || settled) return;
  let args;
  try {
    args = typeof msg.argsText === 'string' && msg.argsText !== '' ? JSON.parse(msg.argsText) : {};
  } catch {
    finalizeError(Object.assign(new Error('caps_exceeded'), { code: 'caps_exceeded' }));
    return;
  }
  Promise.resolve()
    .then(() => runFn(args))
    .then((result) => finalizeOk(result), (err) => finalizeError(err));
});

// Handshake: the parent waits for 'ready' before sending 'invoke', so no
// message can be lost between spawn and listener registration.
send({ type: 'ready' });
