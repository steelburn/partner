// M0 sidecar packaging spike — trivial entry used for the esbuild bundle test
// (baseline) and as the SEA `main` bundle (SEA requires a single-file bundle).
// Purposely imports one Node builtin and does a tiny bit of work so the bundle
// is not a degenerate empty shell, but nothing that needs a native module.
import { createHash } from 'node:crypto';

const digest = createHash('sha256').update('partner-sidecar-spike').digest('hex');
console.log(`bundle-entry: hello from a single bundled file`);
console.log(`bundle-entry: node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`bundle-entry: sha256(seed)=${digest.slice(0, 16)}`);
console.log(`bundle-entry: execPath=${process.execPath}`);
