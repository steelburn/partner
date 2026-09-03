// M0 sidecar packaging spike — SEA hello entry (raw ESM, un-bundled).
// Goal: reach `node --experimental-sea-config` successfully with this file,
// to observe whether an ESM entry is accepted at the config stage.
console.log(`sea-entry: hello from ${process.execPath}`);
console.log(`sea-entry: node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`sea-entry: argv0=${process.argv[0]}`);
