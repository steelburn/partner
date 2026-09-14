#!/usr/bin/env node
/**
 * Issue a SIGN-UP INVITE from INSIDE the container (M22).
 *
 *   docker compose exec partner node tools/signup-link.mjs
 *
 * Why a container-side tool and not a button in the UI: minting an invite is the
 * decision "this person may have an account here", and the published surface is
 * the tunnel — anyone who can reach the hostname could ask for one. `POST
 * /v1/signup/code` is therefore loopback-only (the same reasoning as
 * `/v1/pair/payload`): shell access to the container IS the operator's proof of
 * being at the machine.
 *
 * What the invite buys, and what it does not:
 *   - it lets its holder create ONE account, with a name and passphrase THEY
 *     choose — so the operator never sees the credential (that is the whole
 *     point; `tools/user.mjs add` means the operator typed it);
 *   - it is single use, only the most recently minted one is live, it expires
 *     (SIGNUP_TTL_MS, default 24h), and it dies with the process;
 *   - it does NOT decide what the new account may do. Everyone on a core has the
 *     same reach over their OWN partition (PLAN-M20-B §9); no capability is
 *     granted or withheld by this tool.
 *
 * Sign-up must be enabled for this to work: `SIGNUP_MODE=invite` in the
 * deployment's `.env` (AUTH_MODE=login is this image's default). With it off,
 * the tool prints what to set instead of an error trace.
 */
import { partnerEnv, partnerRequest } from './partner-request.mjs';

const env = partnerEnv();
const res = await partnerRequest({ method: 'POST', path: '/v1/signup/code', body: '{}', env });

let body = {};
try {
  body = JSON.parse(res.body);
} catch {
  body = {};
}

if (res.status === 403 && body.error === 'signup_disabled') {
  console.error('');
  console.error('Sign-up is off in this deployment.');
  console.error('');
  console.error('  Enable invites:  add SIGNUP_MODE=invite to docker/server/.env, then');
  console.error('                   docker compose up -d partner');
  console.error('  Or create the account here instead:');
  console.error('                   docker compose exec partner node tools/user.mjs add <name>');
  console.error('');
  process.exit(1);
}

if (res.status === 403 && body.error === 'loopback_required') {
  console.error('');
  console.error('Refused: the core only mints invites to a caller on its own machine.');
  console.error('Run this INSIDE the container:');
  console.error('  docker compose exec partner node tools/signup-link.mjs');
  console.error('');
  process.exit(1);
}

if (res.status < 200 || res.status >= 300) {
  const detail = body.message ?? body.error ?? res.body.slice(0, 200);
  console.error(`Could not mint an invite (${res.status}): ${detail}`);
  process.exit(1);
}

const code = typeof body.code === 'string' ? body.code : '';
if (code === '') {
  console.error('The core did not return an invite code.');
  process.exit(1);
}

// The fragment, not a query parameter: it is never sent to the server, so the
// one-time code stays out of access logs and any proxy in between (the same
// reasoning as the pairing link).
const link = `https://${env.host}/#signup=${code}`;
console.log('');
console.log('Sign-up invite (single use — it creates ONE account):');
console.log('');
console.log(`  ${link}`);
console.log('');
console.log('Send it to the person. They choose their own name and passphrase, which');
console.log('this machine never sees. If the invite expires, run this again.');
console.log('');
