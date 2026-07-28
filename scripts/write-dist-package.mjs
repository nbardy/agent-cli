import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const distUrl = new URL('../dist/', import.meta.url);
await mkdir(fileURLToPath(distUrl), { recursive: true });
await writeFile(new URL('package.json', distUrl), '{\n  "type": "commonjs"\n}\n', 'utf8');
