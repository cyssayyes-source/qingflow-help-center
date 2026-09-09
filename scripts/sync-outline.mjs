import path from 'node:path';
import {loadLocalEnvironment} from './lib/load-env.mjs';
import {
  DEFAULT_OUTLINE_COLLECTION,
  DEFAULT_OUTLINE_URL,
  assignDocumentRoutes,
  createBootstrappedRouteMap,
  createOutlineClient,
  disableProxyForOutline,
  fetchOutlineSnapshot,
  generateOutlineOutput,
  readLegacyRoutes,
  readRouteMap,
  writeJson,
} from './lib/outline-sync.mjs';

const cwd = process.cwd();
const command = process.argv[2] ?? 'sync';
const routeMapFile = path.join(cwd, 'data', 'outline-route-map.json');
const conflictReportFile = path.join(cwd, '.tmp', 'outline-route-conflicts.json');

loadLocalEnvironment(cwd);
disableProxyForOutline();

async function main() {
  if (!['sync', 'bootstrap-routes'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const client = createOutlineClient({
    baseUrl: process.env.OUTLINE_URL ?? DEFAULT_OUTLINE_URL,
    token: process.env.OUTLINE_API_TOKEN,
  });
  const snapshot = await fetchOutlineSnapshot(
    client,
    process.env.OUTLINE_COLLECTION ?? DEFAULT_OUTLINE_COLLECTION,
  );
  const [legacyRoutes, routeMap] = await Promise.all([
    readLegacyRoutes({
      docsRoot: path.join(cwd, 'docs', 'migrated'),
      sidebarFile: path.join(cwd, 'sidebars.ts'),
    }),
    readRouteMap(routeMapFile),
  ]);
  if (
    routeMap.collection?.id &&
    routeMap.collection.id !== snapshot.collection.id
  ) {
    throw new Error(
      `Outline route map belongs to collection ${routeMap.collection.id}, not ${snapshot.collection.id}.`,
    );
  }
  if (
    routeMap.collection?.name &&
    routeMap.collection.name !== snapshot.collection.name
  ) {
    throw new Error(
      `Outline route map belongs to collection ${routeMap.collection.name}, not ${snapshot.collection.name}.`,
    );
  }
  if (command === 'sync' && !routeMap.collection?.id) {
    throw new Error(
      'Outline route map has not been bootstrapped. Run npm run content:routes:bootstrap on an allowlisted runner and commit data/outline-route-map.json.',
    );
  }
  const assignment = assignDocumentRoutes(snapshot.documents, legacyRoutes, routeMap);

  if (assignment.conflicts.length > 0) {
    await writeJson(conflictReportFile, {conflicts: assignment.conflicts});
    throw new Error(
      `Outline route assignment has ${assignment.conflicts.length} conflict(s). See .tmp/outline-route-conflicts.json.`,
    );
  }
  if (command === 'bootstrap-routes') {
    await writeJson(routeMapFile, createBootstrappedRouteMap(snapshot, assignment, routeMap));
    console.log(`Stored stable routes for ${assignment.documents.length} Outline documents.`);
    return;
  }

  const report = await generateOutlineOutput({
    cwd,
    snapshot,
    assignedDocuments: assignment.documents,
    baseUrl: client.baseUrl,
  });
  console.log(`Outline sync completed: ${report.documents} documents, remote media only.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
