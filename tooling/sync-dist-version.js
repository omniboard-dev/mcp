import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const distIndexPath = 'dist/index.js';
const distIndex = fs.readFileSync(distIndexPath, 'utf8');
const expectedVersion = `version: '${packageJson.version}'`;
const nextDistIndex = distIndex.replace(
  "version: 'VERSION'",
  expectedVersion
);

if (nextDistIndex === distIndex) {
  if (distIndex.includes(expectedVersion)) {
    process.exit(0);
  }

  throw new Error(`Could not replace MCP server VERSION in ${distIndexPath}`);
}

fs.writeFileSync(distIndexPath, nextDistIndex);
