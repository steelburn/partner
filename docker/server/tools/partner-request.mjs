/**
 * Inside-the-container HTTP client for the M21 deploy tools — PLAIN JavaScript.
 *
 * These files run inside a `node:22-slim` image with no build step, so they must
 * be valid JavaScript as written. (Type annotations here would be a syntax
 * error at healthcheck time — which is exactly how the first version of this
 * file failed, and why `tests/deploy-files.test.ts` now `node --check`s every
 * tool.)
 *
 * WHY NOT fetch(): the core listens on HTTPS with a certificate for the PUBLIC
 * hostname while binding 0.0.0.0, so a container-side request must connect to
 * 127.0.0.1 but present the public name twice — as TLS SNI and as the `Host`
 * header — or the certificate check and the host allowlist both fail. Node's
 * fetch cannot set `Host` (a forbidden header) and has no hook for SNI, hence
 * `node:https`.
 *
 * Both details are also what makes this a LOOPBACK request from the core's point
 * of view (the socket peer is 127.0.0.1), which is what the pairing routes
 * require before they will issue a networked-pairing link at all.
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

/**
 * Read + validate the deployment env the compose file supplies.
 * @returns {{ host: string, port: number, certFile: string }}
 */
export function partnerEnv(env = process.env) {
  const host = String(env.PARTNER_HOST ?? env.ALLOWED_HOSTS ?? '')
    .split(',')[0]
    .trim();
  const port = Number.parseInt(env.PORT ?? '4390', 10);
  const certFile = env.TLS_CERT_FILE ?? '/certs/origin.crt';
  if (host === '') {
    throw new Error('PARTNER_HOST is not set — export it (or pass it via compose) and retry');
  }
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`PORT is not a usable port: ${String(env.PORT)}`);
  }
  return { host, port, certFile };
}

/**
 * One request to the local core. Resolves for ANY HTTP status (callers decide
 * what a non-2xx means); rejects only on a transport/TLS failure, which in this
 * deployment is the interesting case (wrong cert, wrong SNI, core not up).
 *
 * @param {{ method: string, path: string, headers?: Record<string, string>, body?: string, env?: { host: string, port: number, certFile: string } }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export function partnerRequest(options) {
  const { host, port, certFile } = options.env ?? partnerEnv();
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        // The certificate is issued for the public hostname.
        servername: host,
        ca: readFileSync(certFile),
        method: options.method,
        path: options.path,
        headers: {
          // Explicit, and WITHOUT a port: the allowlist entry is the bare name.
          host,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * Same, but parses JSON and names a non-2xx response as an error.
 * @param {{ method: string, path: string, headers?: Record<string, string>, body?: string, env?: object }} options
 * @returns {Promise<any>}
 */
export async function partnerJson(options) {
  const res = await partnerRequest(options);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(
      `${options.method} ${options.path} → ${res.status}: ${res.body.slice(0, 200)}`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof parsed === 'object' && parsed !== null
        ? JSON.stringify(parsed)
        : res.body.slice(0, 200);
    throw new Error(`${options.method} ${options.path} → ${res.status}: ${detail}`);
  }
  return parsed;
}
