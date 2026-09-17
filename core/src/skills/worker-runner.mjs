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
 *   partner.llm.complete({prompt, maxTokens?})   (M27 S5)
 *                                        -> {type:'llm.complete'} request,
 *                                           resolved/rejected by the
 *                                           {type:'llm.result'} reply
 *
 * `llm.complete` is MODEL REACH, and it is declared + bounded rather than
 * ambient: the core refuses it unless the manifest declares `permissions.llm`
 * AND the acting session's client class may ask for `skill.llm` AND a provider
 * is configured, and it fails the whole invocation when the skill's own token
 * ceiling is passed. This side therefore carries the request and the answer
 * only — it decides nothing, exactly like `tools.exec`. Both verbs share ONE
 * nonce + in-flight discipline (including the concurrency cap), so the worker
 * gains no new failure mode from the second one.
 *
 * Protocol (parent -> worker): {type:'invoke', argsText}
 *            (worker -> parent): {type:'ready'}
 *                                {type:'log', line}
 *                                {type:'tools.exec', toolId, params, nonce}
 *                                {type:'llm.complete', prompt, maxTokens?, nonce}
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
/**
 * Most core requests (tools.exec + llm.complete) this worker keeps in flight at
 * once. ONE cap for both verbs: the core is a single parent process, and the
 * point of the cap is that a skill cannot flood it.
 */
const MAX_IN_FLIGHT_REQUESTS = 8;
const MAX_ERROR_CODE = 200;
/**
 * How much of a failure's own message travels as a log line. Generous enough for
 * a real stack-free explanation, bounded so a skill cannot turn one throw into
 * an unbounded log.
 */
const MAX_ERROR_MESSAGE = 500;

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

/**
 * A human-readable reason for a failed run.
 *
 * The CODE names the CLASS of failure (`skill_error`); this names the CAUSE, and
 * it is the difference between "your skill failed" and "your skill failed
 * because ...". It travels as an ordinary log line, so the parent redacts it
 * exactly like every other line a worker sends, and the owner reads it beside
 * the code in the Test run panel.
 *
 * A stack is deliberately NOT sent: it names paths inside the scratch bundle the
 * owner cannot act on, and the message is the part they fix.
 */
function describeError(err) {
  let text;
  if (err instanceof Error) {
    text = err.message === '' ? err.name : `${err.name}: ${err.message}`;
  } else if (typeof err === 'string') {
    text = err;
  } else {
    try {
      text = JSON.stringify(err) ?? String(err);
    } catch {
      text = String(err);
    }
  }
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

/** The one error shape both broker verbs reject with: message = code. */
function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
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
        return Promise.reject(codedError('tool_denied'));
      }
      if (inFlight >= MAX_IN_FLIGHT_REQUESTS) {
        return Promise.reject(codedError('tool_denied'));
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
  llm: {
    /**
     * ONE model completion, brokered by the core (M27 S5). Resolves
     * { text, usage } where usage is { promptTokens, completionTokens,
     * totalTokens } and rejects with an Error carrying `.code` when the core
     * refuses the call:
     *
     *   llm_not_declared  the manifest does not declare permissions.llm
     *   capability_denied the session's client class may not reach a model
     *   no_provider       nothing usable is configured, or the key is missing
     *   budget_exceeded   the invocation's token ceiling was passed
     *   caps_exceeded     the prompt or the reply passed its byte cap, or too
     *                     many core requests are already in flight
     *   bad_params        the request is not { prompt: <non-empty string> }
     *   upstream          the provider stream failed
     *
     * A refusal is thrown, not returned, so a skill chooses between failing
     * and working around it ("summarise with the model, else return the text
     * unchanged") — the same shape `tools.exec` uses.
     */
    complete(request) {
      const req = request !== null && typeof request === 'object' ? request : {};
      if (typeof req.prompt !== 'string' || req.prompt === '') {
        return Promise.reject(codedError('bad_params'));
      }
      if (inFlight >= MAX_IN_FLIGHT_REQUESTS) {
        return Promise.reject(codedError('caps_exceeded'));
      }
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      inFlight += 1;
      return new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (!msg || msg.type !== 'llm.result' || msg.nonce !== nonce) return;
          process.removeListener('message', onMessage);
          if (msg.ok === true) {
            resolve({
              text: typeof msg.text === 'string' ? msg.text : '',
              usage: msg.usage ?? null,
            });
          } else {
            const code = typeof msg.error === 'string' && msg.error !== '' ? msg.error : 'upstream';
            reject(codedError(code));
          }
        };
        process.on('message', onMessage);
        send({
          type: 'llm.complete',
          nonce,
          prompt: req.prompt,
          // Passed through verbatim: the CORE validates it (a bad value is a
          // named refusal the author can act on, never a silent default).
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        });
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
    // The same rule as a throw: name the cause, not just the code.
    send({
      type: 'log',
      line: 'skill error (skill_error): the value run() returned is not JSON-serializable',
    });
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
  const code = errorCodeOf(err);
  // D5: a coded failure the owner cannot read is the opaque `crashed` this
  // harness exists to remove, so the reason ships WITH the code (and is redacted
  // by the parent like any other log line).
  send({ type: 'log', line: `skill error (${code}): ${describeError(err)}` });
  sendErrResult(code);
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
