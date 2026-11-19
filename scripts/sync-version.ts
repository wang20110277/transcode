// npm version lifecycle hook: keep src/version.ts in sync with package.json
// (runs after the bump, before npm version commits and tags).
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const content = `// Auto-generated from package.json by scripts/sync-version.ts (npm version hook)\nexport const VERSION = '${pkg.version}';\n`;
writeFileSync('src/version.ts', content);
// npm's bump commit only stages package.json/bun.lock — stage the synced
// file too or it lags a release behind in git.
execSync('git add src/version.ts');
console.log(`src/version.ts -> ${pkg.version}`);
