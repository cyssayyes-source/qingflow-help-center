import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadLocalEnvironment} from './lib/load-env.mjs';
import {syncTypesense} from './lib/typesense-sync.mjs';

loadLocalEnvironment();

async function main() {
  const recordsPath = path.join(process.cwd(), '.tmp', 'search-records.json');
  const records = JSON.parse(await readFile(recordsPath, 'utf8'));
  const synonymGroups = JSON.parse(
    await readFile(path.join(process.cwd(), 'data', 'search-synonyms.json'), 'utf8'),
  );
  await syncTypesense({
    host: process.env.TYPESENSE_HOST,
    apiKey:
      process.env.TYPESENSE_ADMIN_API_KEY?.trim() ||
      process.env.TYPESENSE_API_KEY?.trim(),
    collection: process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs',
    records,
    synonymGroups,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
