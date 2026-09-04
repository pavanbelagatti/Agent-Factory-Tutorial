/**
 * Pushes every blueprint and workflow in this folder to Port.
 *
 *   npm run apply
 *
 * Safe to run repeatedly. Blueprints are PATCHed (a deep merge, so it won't
 * clobber fields you've since added in the UI). Workflows are PUT, which
 * replaces the definition and cuts a new version.
 *
 * Files are applied in filename order, which is why the blueprints are
 * numbered: the aggregation in 04 depends on the relation created in 03.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { portFetch } from '../src/port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readJsonDir(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      body: JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')),
    }))
  );
}

async function applyBlueprint({ file, body }) {
  // Strip our own annotations before sending.
  delete body._comment;

  try {
    await portFetch('/blueprints', { method: 'POST', body: JSON.stringify(body) });
    console.log(`  created  blueprint  ${body.identifier}  (${file})`);
  } catch (err) {
    if (err.status !== 409) throw err;
    await portFetch(`/blueprints/${body.identifier}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    console.log(`  updated  blueprint  ${body.identifier}  (${file})`);
  }
}

async function applyWorkflow({ file, body }) {
  try {
    await portFetch('/workflows', { method: 'POST', body: JSON.stringify(body) });
    console.log(`  created  workflow   ${body.identifier}  (${file})`);
  } catch (err) {
    if (err.status !== 409) throw err;
    // No If-Match header: we intentionally overwrite whatever is live with
    // what's in this repo. The repo is the source of truth.
    await portFetch(`/workflows/${body.identifier}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    console.log(`  updated  workflow   ${body.identifier}  (${file})`);
  }
}

async function main() {
  console.log('\nApplying Port configuration…\n');

  for (const bp of await readJsonDir(path.join(__dirname, 'blueprints'))) {
    await applyBlueprint(bp);
  }

  for (const wf of await readJsonDir(path.join(__dirname, 'workflows'))) {
    await applyWorkflow(wf);
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
