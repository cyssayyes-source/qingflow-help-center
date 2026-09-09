# Qingflow Help Center

This repository implements a self-hosted help center based on:

- `Outline` as the production content source
- `GitHub` for application code, stable route metadata, and the legacy snapshot
- `Docusaurus` for the documentation site and information architecture
- `Typesense` for self-hosted search

The product direction references the good parts of Mintlify, but keeps the full delivery stack under our control.

## What is included in Phase 1

- Branded Docusaurus site shell
- Help center content structure and sample docs
- Version-ready docs-as-code workflow
- Search page prepared for Typesense
- Search record generation script
- GitHub Actions CI workflow

## Local development

```bash
npm install
npm start
```

`npm start` requires `OUTLINE_API_TOKEN`, synchronizes the configured Outline
collection, and then starts Docusaurus with the generated content. To work
against the retained legacy snapshot without contacting Outline, run:

```bash
npm run start:legacy
```

## Build

```bash
npm run build
```

This will:

- synchronize the `售后知识库` collection from Outline
- build the Docusaurus site into `build/`
- generate `.tmp/search-records.json` for Typesense indexing

Use `npm run build:legacy` for an offline build from `docs/migrated`.

## Outline content sync

The production source URL is `https://outline.dev.oalite.com`. Configure a
read-only `OUTLINE_API_TOKEN` in the environment and run:

```bash
npm run content:sync
```

The sync uses `POST /api/collections.list`, reads the Outline document tree and
Markdown content, and writes disposable output to `docs/generated/` and
`sidebars.generated.ts`. These generated files are intentionally ignored by
Git. Images, videos, and attachments are not downloaded; their references are
kept as absolute Outline URLs. The sync process explicitly disables inherited
HTTP, HTTPS, and SOCKS proxy environment settings and connects to Outline
directly.

Existing public routes are bound to Outline document IDs in
`data/outline-route-map.json`. From an environment that can access Outline, run
the following once and commit the resulting route map:

```bash
npm run content:routes:bootstrap
```

Normal Outline syncs fail closed until this initial route map has been committed.
Ambiguous legacy matches fail and are reported in
`.tmp/outline-route-conflicts.json`. Resolve those entries explicitly in the
route map before publishing. Never put an API token in this repository or in a
command committed to shell history.

Container builds also require the token as a BuildKit secret so that it is not
stored in an image layer:

```bash
docker build --secret id=outline_api_token,env=OUTLINE_API_TOKEN .
```

## GitHub Pages deployment

Every update to `main` is synchronized, validated, built, and deployed by
`.github/workflows/docs-ci.yml`. Production builds run on a self-hosted runner
whose outbound IP must be allowed by Outline. Pull requests use the retained
legacy snapshot and do not receive the Outline secret. The published site is
available at:

`https://nonepointer666.github.io/qingflow-help-center/`

The workflow automatically switches Docusaurus to the repository base path during
the Pages build. Local development and custom-domain builds continue to use `/`.

In the GitHub repository, set **Settings > Pages > Build and deployment > Source**
to **GitHub Actions** once. You can also run the workflow manually from the Actions
page through `workflow_dispatch`.

## Search setup

Copy `.env.example` into your runtime environment and provide:

- `TYPESENSE_HOST`
- `TYPESENSE_COLLECTION`
- `TYPESENSE_SEARCH_API_KEY` and `TYPESENSE_ADMIN_API_KEY`

The project loads ignored `.env` and `.env.local` files for local commands;
shell and CI variables take precedence. The admin key is used only by
`npm run search:push`; the browser receives only the search-only key. Create a
search key from the admin key with:

```bash
npm run search:key:create
```

The command creates a key scoped to `documents:search` for the configured
collection and prints the generated key once. Store it as
`TYPESENSE_SEARCH_API_KEY` in your local environment or secret store.

Then you can push search data:

```bash
npm run search:push
```

## Key directories

```text
docs/                  Markdown and MDX content
src/pages/             Branded landing page and search page
scripts/               Outline sync, search record generation, and Typesense sync
typesense/schema/      Collection schema reference
.github/workflows/     CI pipeline
```

## Next suggested milestones

1. Connect a real Typesense instance and search-only API key
2. Add synonym rules and ranking strategy
3. Add scheduled Outline synchronization and content freshness monitoring
4. Add OpenAPI-driven API reference pages
5. Add AI answer generation with source citations
