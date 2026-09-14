/**
 * M22 — the SIGN-UP lane on the client side.
 *
 * Three falsifiable things, each of which would break the hosted shape silently:
 *
 *  1. the invite LINK's validation (a present-but-broken code must be named, not
 *     "cleaned up" into a form that cannot submit) — pure, like `pair-link`;
 *  2. the sign-up REQUEST's shape and error mapping (a spent invite is not a
 *     wrong password; a 400 is a rule refusal and carries the rule's sentence) —
 *     exercised with an injected transport;
 *  3. the FORM itself, render-tested with SSR (no DOM needed, the same way the
 *     login gate and the M20.A grouped-answer cards are covered): both passphrase
 *     fields exist, submit is disabled until the shared rules pass, and the rule
 *     sentences come from `@partner/shared/accounts` rather than being written
 *     into the markup the core does not agree with.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { ApiRequestError, signUp } from '../src/lib/api.js';
import { SignUpGate } from '../src/SignUpGate.js';
import { LoginGate } from '../src/LoginGate.js';
import {
  initialSignupFields,
  isSignupCode,
  readSignupHash,
  signupLinkFor,
  stripSignupHash,
} from '../src/lib/signup-link.js';
import { MIN_PASSPHRASE_LENGTH } from '@partner/shared';

const CODE = randomBytes(32).toString('base64url');

type Call = { input: string; init?: RequestInit };

function fetchReturning(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('the invite link is validated, never repaired', () => {
  it('accepts exactly what the core mints (32 random bytes, base64url)', () => {
    expect(isSignupCode(CODE)).toBe(true);
    expect(readSignupHash(`#signup=${CODE}`)).toEqual({ ok: true, code: CODE });
    // A query form is accepted too: the same value may be pasted either way.
    expect(readSignupHash(`?signup=${CODE}`)).toEqual({ ok: true, code: CODE });
  });

  it('separates "no invite here" from "this invite is broken"', () => {
    // No fragment at all: the gate must stay on the sign-in form.
    expect(readSignupHash('')).toEqual({ ok: false, reason: 'not_a_link' });
    expect(readSignupHash('#pair=whatever')).toEqual({ ok: false, reason: 'not_a_link' });
    expect(readSignupHash('#signup=')).toEqual({ ok: false, reason: 'not_a_link' });
    // A PRESENT value that cannot work is named, so the form can say why.
    for (const bad of [
      'short',
      '='.repeat(43),
      `${CODE}=`,
      `${CODE.slice(0, 42)}+`,
      `${CODE} `,
      'é'.repeat(43),
    ]) {
      expect(readSignupHash(`#signup=${bad}`), bad).toEqual({ ok: false, reason: 'invalid_code' });
    }
  });

  it('builds and strips the link without leaking the code anywhere else', () => {
    const link = signupLinkFor(CODE, 'partner.example.com');
    expect(link).toBe(`https://partner.example.com/#signup=${CODE}`);
    // Stripping leaves a usable URL and no trace of the one-time code.
    const stripped = stripSignupHash(link);
    expect(stripped).toBe('https://partner.example.com/');
    expect(stripped).not.toContain(CODE);
  });

  it('seeds the form from the link for BOTH ways a link arrives', () => {
    // The bug this pins (found in the container walk, not here): the
    // "pasted into an open tab" path filled the code field and the
    // "opened a fresh tab" path did not, so the form could show the
    // "filled in from the link you opened" hint above an EMPTY code field — a
    // form that could never submit. One helper now answers for both, and the
    // invariant is that a GOOD link always yields a non-empty code.
    const good = initialSignupFields(`#signup=${CODE}`);
    expect(good).toEqual({ code: CODE, invited: true });

    for (const fragment of ['', '#pair=x', `#signup=${CODE.slice(0, 40)}`]) {
      expect(initialSignupFields(fragment), fragment).toEqual({ code: '', invited: false });
    }

    // Agrees with the validator by construction — asserted so a refactor cannot
    // make the two disagree silently.
    const parsed = readSignupHash(`#signup=${CODE}`);
    expect(parsed.ok && initialSignupFields(`#signup=${CODE}`).code === parsed.code).toBe(true);
  });
});

describe('signUp', () => {
  it('POSTs the invite, the name and the passphrase — and returns the new id', async () => {
    const { fetchImpl, calls } = fetchReturning(201, { ok: true, id: 'ama' });
    const result = await signUp(
      { code: CODE, username: 'Ama', password: 'a long enough passphrase' },
      { fetchImpl },
    );
    expect(calls[0]?.input).toBe('/v1/auth/signup');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: CODE,
      username: 'Ama',
      password: 'a long enough passphrase',
    });
    expect(result).toEqual({ id: 'ama' });
    // The code travels in the BODY, never in a URL it could be logged from.
    expect(String(calls[0]?.input)).not.toContain(CODE);
  });

  it('surfaces the core’s own sentence for a spent invite, and the status for a rule refusal', async () => {
    await expect(
      signUp(
        { code: CODE, username: 'Ama', password: 'a long enough passphrase' },
        {
          fetchImpl: fetchReturning(401, {
            error: 'invite_failed',
            reason: 'not_found',
            message: 'That invite has already been used or has expired.',
          }).fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/single use|expired/) });

    await expect(
      signUp(
        { code: CODE, username: 'Ama', password: 'short' },
        {
          fetchImpl: fetchReturning(400, {
            error: 'invalid_input',
            reason: 'invalid_passphrase',
            message: 'Use at least 10 characters.',
          }).fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ status: 400, message: 'Use at least 10 characters.' });
  });
});

describe('the sign-up form', () => {
  const base = {
    username: 'Ama',
    password: 'a long enough passphrase',
    confirm: 'a long enough passphrase',
    code: CODE,
    busy: false,
    error: null,
    host: 'partner.example.com',
    invited: true,
    onUsername: () => {},
    onPassword: () => {},
    onConfirm: () => {},
    onCode: () => {},
    onSubmit: () => {},
    onSignIn: () => {},
  };

  it('renders every field the account needs, with the invite filled in', () => {
    const html = renderToStaticMarkup(h(SignUpGate, base));
    for (const id of ['signup-code', 'signup-username', 'signup-password', 'signup-confirm']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // Two passphrase fields: a typo must not lock the person out of an account
    // whose credential nobody else can reset for them.
    expect(html).toContain('type="password"');
    expect(html).toContain(CODE);
    expect(html).toContain('Create account');
    expect(html).not.toContain('disabled=""');
  });

  it('disables submit while the shared rules fail, and quotes those rules', () => {
    const short = renderToStaticMarkup(
      h(SignUpGate, { ...base, password: 'short', confirm: 'short' }),
    );
    expect(short).toContain('disabled=""');
    expect(short).toContain(`at least ${MIN_PASSPHRASE_LENGTH} characters`);

    const mismatch = renderToStaticMarkup(
      h(SignUpGate, { ...base, confirm: 'a long enough passphrasE' }),
    );
    expect(mismatch).toContain('disabled=""');
    expect(mismatch).toContain('These two do not match yet.');

    const badName = renderToStaticMarkup(h(SignUpGate, { ...base, username: 'con' }));
    expect(badName).toContain('disabled=""');
    expect(badName).toContain('reserves');
  });

  it('disables submit while a request is in flight, and shows the failure', () => {
    const html = renderToStaticMarkup(
      h(SignUpGate, { ...base, busy: true, error: 'That invite has already been used.' }),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('Creating your account…');
    expect(html).toContain('role="alert"');
    expect(html).toContain('That invite has already been used.');
  });

  it('asks for the code when there is no invite link, and says what a code is', () => {
    const html = renderToStaticMarkup(
      h(SignUpGate, { ...base, code: '', invited: false }),
    );
    expect(html).toContain('Paste the code from the invite link');
    // No code ⇒ nothing to submit.
    expect(html).toContain('disabled=""');
  });
});

describe('the sign-in form offers sign-up only where it exists', () => {
  const base = {
    username: '',
    password: '',
    busy: false,
    error: null,
    noAccountYet: false,
    host: 'partner.example.com',
    onUsername: () => {},
    onPassword: () => {},
    onSubmit: () => {},
    onSessionOnly: () => {},
    onSignUp: () => {},
  };

  it('offers nothing extra when the core has sign-up off (the deployment default)', () => {
    const html = renderToStaticMarkup(h(LoginGate, base));
    expect(html).not.toContain('Create an account');
    expect(html).not.toContain('I have an invite');
  });

  it('offers the invite path when the core accepts invites', () => {
    const html = renderToStaticMarkup(h(LoginGate, { ...base, signupAvailable: true }));
    expect(html).toContain('Create an account');
    // The session-only escape hatch stays: sign-up does not replace it.
    expect(html).toContain('session-only chat');
  });

  it('turns "no account yet" into the invite path instead of a dead sign-in form', () => {
    const html = renderToStaticMarkup(
      h(LoginGate, { ...base, noAccountYet: true, signupAvailable: true }),
    );
    expect(html).toContain('I have an invite');
    // No sign-in form, because a sign-in attempt could only answer 409.
    expect(html).not.toContain('id="login-password"');
    expect(html).toContain('tools/signup-link.mjs');

    // …and with sign-up off it stays the operator-command message it always was.
    const off = renderToStaticMarkup(h(LoginGate, { ...base, noAccountYet: true }));
    expect(off).toContain('tools/user.mjs add');
    expect(off).not.toContain('I have an invite');
  });
});
