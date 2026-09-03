// shell/spike/bundle-entry.mjs
var import_node_crypto = require("node:crypto");
var digest = (0, import_node_crypto.createHash)("sha256").update("partner-sidecar-spike").digest("hex");
console.log(`bundle-entry: hello from a single bundled file`);
console.log(`bundle-entry: node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`bundle-entry: sha256(seed)=${digest.slice(0, 16)}`);
console.log(`bundle-entry: execPath=${process.execPath}`);
