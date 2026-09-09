import {loadLocalEnvironment} from './lib/load-env.mjs';
import {createTypesenseSearchKey} from './lib/typesense-sync.mjs';

loadLocalEnvironment();

async function main() {
  const result = await createTypesenseSearchKey({
    host: process.env.TYPESENSE_HOST,
    apiKey:
      process.env.TYPESENSE_ADMIN_API_KEY?.trim() ||
      process.env.TYPESENSE_API_KEY?.trim(),
    collection: process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs',
    description:
      process.env.TYPESENSE_SEARCH_KEY_DESCRIPTION ??
      'Qingflow Help Center browser search',
  });

  console.log(result.value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
