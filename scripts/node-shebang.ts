// Rewrite a bundled file's shebang to node.
// The source entry (bin/transcode.ts) keeps its bun shebang so dev entries
// (bun link, direct exec, `bun bin/transcode.ts`) run under bun; the
// npm-published artifact (dist/cli.js) must run under plain node, so the
// build rewrites the shebang bun leaves on the bundle.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: bun scripts/node-shebang.ts <file>');
  process.exit(1);
}
const content = readFileSync(file, 'utf8');
if (!content.startsWith('#!')) {
  console.error(`${file}: no shebang found, refusing to patch`);
  process.exit(1);
}
writeFileSync(file, content.replace(/^#![^\n]*\n?/, '#!/usr/bin/env node\n'));
console.log(`${file}: shebang -> #!/usr/bin/env node`);
