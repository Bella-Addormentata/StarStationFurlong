// Writes the node's copy of the fold: `npm run build:fold`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUNDLE_PATH, buildFoldBundle } from './foldBundle.mjs';

const { text } = await buildFoldBundle();
mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
writeFileSync(BUNDLE_PATH, text);
console.log(`wrote ${BUNDLE_PATH} (${text.length} bytes)`);
