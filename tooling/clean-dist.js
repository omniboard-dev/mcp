import fs from 'node:fs/promises';

const distUrl = new URL('../dist/', import.meta.url);

await fs.rm(distUrl, { recursive: true, force: true });
