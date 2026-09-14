/**
 * M21 deployment artifacts — the checks that catch what a Docker build would
 * otherwise reveal far too late.
 *
 * These files are NOT TypeScript and are not imported by the app, so nothing
 * else in the suite touches them. The first version of the container healthcheck
 * shipped with type annotations inside a `.mjs` file: the image built fine, the
 * core booted fine, and the container then sat permanently `unhealthy` because
 * Node cannot parse `foo<T>(…)` — a failure mode only `node --check` finds
 * cheaply. That is the first test here.
 *
 * The rest pin the TOPOLOGY, because it is security-relevant and invisible in a
 * diff review of two YAML files: the tunnel must NOT share the core's network
 * namespace (every internet request would become "loopback", letting an
 * anonymous caller mint a pairing secret) and the core must NOT publish a port.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DIR = fileURLToPath(new URL('../docker/server/', import.meta.url));
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');

describe('container tools are valid JavaScript', () => {
  const tools = readdirSync(join(DIR, 'tools')).filter((f) => f.endsWith('.mjs'));

  it('finds the tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  it.each(tools)('node --check %s', (file) => {
    // Throws (nonzero exit, message on stderr) on any syntax error.
    expect(() =>
      execFileSync(process.execPath, ['--check', join(DIR, 'tools', file)], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('expects the tools to be plain JavaScript (JSDoc types allowed)', () => {
    // Real gate: `node --check` above, which fails on annotations in code. Types
    // inside /** */ comments are welcome — they document the tool for readers.
    for (const file of tools) {
      const code = readFileSync(join(DIR, 'tools', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, file).not.toMatch(/^\s*(export )?interface \w+/m);
      expect(code, file).not.toMatch(/<\{?\s*\w+\??:/);
    }
  });
});

describe('compose topology (security-relevant, invisible in a YAML diff)', () => {
  const compose = read('docker-compose.yml');
  const envExample = read('.env.example');

  it('never puts the tunnel in the core network namespace', () => {
    // `network_mode: service:partner` would make every tunnel request arrive from
    // 127.0.0.1, so POST /v1/pair/payload (loopback-only) would hand an anonymous
    // internet visitor a pairing secret — and the 6-digit code would become
    // internet-reachable. Kept as separate services for exactly this reason.
    expect(compose).not.toMatch(/^\s*network_mode:/m);
  });

  it('publishes no host port for the core', () => {
    // A published port would bypass the tunnel, and (because published traffic
    // arrives from the bridge gateway) would make every request non-loopback too,
    // so pairing through the tunnel could never work.
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/^\s*-\s*"?\d+:\d+"?\s*$/m);
  });

  it('requires the public hostname and the tunnel token, with the host as the whole allowlist', () => {
    expect(compose).toMatch(/PARTNER_HOST: \$\{PARTNER_HOST:\?/);
    expect(compose).toMatch(/ALLOWED_HOSTS: \$\{PARTNER_HOST:\?/);
    expect(compose).toMatch(/TUNNEL_TOKEN: \$\{TUNNEL_TOKEN:\?/);
    // The token goes through the ENVIRONMENT, not `--token`, so it stays out of
    // the process arguments (checked on the effective config: comments dropped).
    const effective = compose
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(effective).not.toMatch(/--token/);
    expect(effective).toMatch(/command: tunnel --no-autoupdate run/);
  });

  it('waits for the core to be healthy before starting the tunnel', () => {
    expect(compose).toMatch(/condition: service_healthy/);
  });

  it('mounts the data volume and the certificate material read-only-or-separate', () => {
    expect(compose).toMatch(/partner-data:\/data/);
    expect(compose).toMatch(/\.\/secrets:\/certs:ro/);
  });

  it('forwards SIGNUP_MODE off-by-default, and documents the invite tool', () => {
    // The sign-up flag must reach the CORE by name (a flag only in .env.example
    // would leave `SIGNUP_MODE=invite` silently doing nothing) and must default
    // to off, so a deployment that never asked for it cannot create accounts
    // from the internet.
    expect(compose).toMatch(/SIGNUP_MODE: \$\{SIGNUP_MODE:-off\}/);
    expect(envExample).toMatch(/^SIGNUP_MODE=off$/m);
    // …and the loopback-only mint tool is the documented way to issue an invite.
    expect(envExample).toContain('tools/signup-link.mjs');
    expect(existsSync(join(DIR, 'tools', 'signup-link.mjs'))).toBe(true);
  });
});

describe('Dockerfile <-> stage script agreement', () => {
  const dockerfile = read('Dockerfile');
  const stageSh = read('stage.sh');
  const stagePs1 = read('stage.ps1');

  it('every staged artifact the Dockerfile COPYs is produced by both stage scripts', () => {
    const needed = ['core-bundle.cjs', 'web', 'skills-catalog', 'tools'];
    for (const artifact of needed) {
      if (artifact === 'tools') continue; // committed, not staged
      expect(dockerfile, artifact).toContain(artifact);
      expect(stageSh, artifact).toContain(artifact);
      expect(stagePs1, artifact).toContain(artifact);
    }
  });

  it('healthchecks the real tool with node (no curl in the image)', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*tools\/healthcheck\.mjs/);
    expect(existsSync(join(DIR, 'tools', 'healthcheck.mjs'))).toBe(true);
    expect(dockerfile).not.toMatch(/curl /);
  });

  it('runs LIVE (demo off), with the file keychain and the S6 remote matrix', () => {
    expect(dockerfile).toMatch(/DEMO_MODE=0/);
    expect(dockerfile).toMatch(/KEYCHAIN_KIND=file/);
    expect(dockerfile).toContain('KEYCHAIN_FILE=/data/keychain.json');
    expect(dockerfile).toMatch(/REMOTE_ACCESS=1/);
    expect(dockerfile).toMatch(/TLS_CERT_FILE=\/certs\/origin\.crt/);
    expect(dockerfile).toMatch(/TLS_KEY_FILE=\/certs\/origin\.key/);
  });

  it('runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('keeps secrets and staged artifacts out of git', () => {
    const ignore = read('.gitignore');
    for (const pattern of ['secrets/', '.env', 'core-bundle.cjs', 'web/', 'skills-catalog/']) {
      expect(ignore, pattern).toContain(pattern);
    }
  });
});
