import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {syncTypesense} from './lib/typesense-sync.mjs';

async function main() {
  const recordsPath = path.join(process.cwd(), '.tmp', 'search-records.json');
  const records = JSON.parse(await readFile(recordsPath, 'utf8'));
  await syncTypesense({
    host: process.env.TYPESENSE_HOST,
    apiKey: process.env.TYPESENSE_ADMIN_API_KEY,
    collection: process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs',
    records,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
