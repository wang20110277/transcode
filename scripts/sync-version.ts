// npm version lifecycle hook: keep src/version.ts in sync with package.json
// (runs after the bump, before npm version commits and tags).
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const content = `// Auto-generated from package.json by scripts/sync-version.ts (npm version hook)\nexport const VERSION = '${pkg.version}';\n`;
writeFileSync('src/version.ts', content);
console.log(`src/version.ts -> ${pkg.version}`);
