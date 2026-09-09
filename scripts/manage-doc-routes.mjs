import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pinyin} from 'pinyin-pro';
import {getContentPaths} from './lib/content-source.mjs';

const cwd = process.cwd();
const {docsRoot, source: contentSource} = getContentPaths(cwd);
const redirectsFile = path.join(cwd, 'data', 'legacy-url-redirects.json');
const sourceRoots = [
  path.join(cwd, 'docusaurus.config.ts'),
  path.join(cwd, 'scripts'),
  path.join(cwd, 'src'),
  path.join(cwd, 'docs'),
];
const chinesePattern = /\p{Script=Han}/u;
const yuqueKeyPattern = /^[a-z0-9]{16}$/;

const sectionRoutes = new Map([
  ['新手指南', 'getting-started'],
  ['更新动态', 'release-notes'],
  ['帮助文档', 'product-guides'],
  ['解决方案', 'solutions'],
  ['搭建技巧', 'building-guides'],
  ['常见问题-faq', 'faq'],
  ['视频中心', 'video-guides'],
  ['联系我们', 'contact'],
]);

const productCategoryRoutes = new Map([
  ['轻流简介', 'qingflow-introduction'],
  ['管理后台', 'admin-console'],
  ['表单引擎', 'form-engine'],
  ['流程引擎', 'workflow-engine'],
  ['门户引擎', 'portal-engine'],
  ['数据引擎', 'data-engine'],
  ['轻析报表', 'analytics'],
  ['轻代码', 'qing-code'],
  ['q-robot', 'q-robot'],
  ['平台版轻流', 'platform-integrations'],
  ['轻流ai-让业务人员用自然语言完成系统搭建和业务自动化', 'qingflow-ai'],
  ['轻翼', 'qingwing'],
  ['工作区初始化配置', 'workspace-setup'],
  ['其它', 'other'],
]);

const exactRoutes = new Map([
  ['kofgzgwxwprozxws', '/getting-started'],
  ['kogbd66w8db8f9zz', '/product-guides/qingflow-introduction'],
  ['hgdfpen0l5q9il82', '/product-guides/qingflow-introduction/what-is-no-code'],
  ['frsy9afb3px0x56w', '/product-guides/qingflow-introduction/qingflow-vs-excel'],
  ['ziuk0n575tqcg2wx', '/product-guides/qingflow-introduction/information-collection-and-analysis'],
  ['hxbncbc4c67dpu3m', '/product-guides/qingflow-introduction/core-features'],
  ['ccvxmkom237sslmf', '/product-guides/qingflow-introduction/collect-and-route-data'],
  ['rxys3i8f01n9mi9n', '/product-guides/workflow-engine'],
  ['uom26vvo2p3ay1ek', '/product-guides/admin-console'],
  ['chu07b3x8bxfzagr', '/product-guides/admin-console/permissions'],
  ['onnrnp9i7nihz5l8', '/product-guides/qing-code/openapi'],
  ['ivzswm6d0z93emh1', '/building-guides/inventory-outbound-validation'],
  ['kt5yeho4t8u1g26n', '/solutions/inventory-management'],
  ['yu2fahhngih0lh5u', '/release-notes'],
  ['keonet9tt77u94sk', '/faq'],
  ['res0imu5wxgfdufz', '/video-guides'],
  ['nszsbaxspbc1gifq', '/contact'],
]);

async function getFiles(target) {
  const targetStat = await stat(target);
  if (targetStat.isFile()) {
    return [target];
  }

  const entries = await readdir(target, {withFileTypes: true});
  const files = await Promise.all(
    entries.map((entry) => getFiles(path.join(target, entry.name))),
  );
  return files.flat();
}

function readSlug(source, filePath) {
  const match = source.match(/^slug:\s*["']([^"']+)["']\s*$/m);
  if (!match) {
    throw new Error(`Missing slug in ${path.relative(cwd, filePath)}`);
  }
  return match[1];
}

function readTitle(source, filePath) {
  const match = source.match(/^title:\s*["']([^"']+)["']\s*$/m);
  if (!match) {
    throw new Error(`Missing title in ${path.relative(cwd, filePath)}`);
  }
  return match[1];
}

function createEnglishSlug(oldSlug, documentId) {
  const exactRoute = exactRoutes.get(documentId);
  if (exactRoute) {
    return exactRoute;
  }

  const parts = oldSlug.split('/').filter(Boolean);
  const section = sectionRoutes.get(parts[0]);
  if (!section) {
    throw new Error(`No English section mapping for ${oldSlug}`);
  }

  if (parts[0] === '帮助文档') {
    const productCategory = productCategoryRoutes.get(parts[1]);
    if (!productCategory) {
      throw new Error(`No English product category mapping for ${oldSlug}`);
    }
    return parts.length === 2
      ? `/${section}/${productCategory}`
      : `/${section}/${productCategory}/${documentId}`;
  }

  return parts.length === 1 ? `/${section}` : `/${section}/${documentId}`;
}

function createTitleSlug(title) {
  const romanized = pinyin(title, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  }).join('-');
  const slug = romanized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
  return slug || 'document';
}

function isYuqueKeySlug(slug) {
  return yuqueKeyPattern.test(slug.split('/').filter(Boolean).at(-1) ?? '');
}

async function readRedirects() {
  try {
    return JSON.parse(await readFile(redirectsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function rewriteRouteReferences(routeChanges) {
  const sourceFiles = (
    await Promise.all(sourceRoots.map((target) => getFiles(target)))
  )
    .flat()
    .filter((filePath) => /\.(?:js|mjs|ts|tsx|md|mdx)$/.test(filePath));
  const replacements = routeChanges
    .map(({from, to}) => ({from: `/docs${from}`, to: `/docs${to}`}))
    .sort((a, b) => b.from.length - a.from.length);

  let changedFiles = 0;
  for (const filePath of sourceFiles) {
    let source = await readFile(filePath, 'utf8');
    const original = source;
    for (const replacement of replacements) {
      source = source.replaceAll(replacement.from, replacement.to);
    }
    if (source !== original) {
      await writeFile(filePath, source);
      changedFiles += 1;
    }
  }
  return changedFiles;
}

async function checkRoutes() {
  const markdownFiles = (await getFiles(docsRoot)).filter((filePath) =>
    filePath.endsWith('.mdx'),
  );
  const seenSlugs = new Map();
  const errors = [];

  for (const filePath of markdownFiles) {
    const slug = readSlug(await readFile(filePath, 'utf8'), filePath);
    if (chinesePattern.test(slug)) {
      errors.push(`Chinese characters remain in ${path.relative(cwd, filePath)}: ${slug}`);
    }
    if (!/^\/[a-z0-9][a-z0-9/-]*$/.test(slug)) {
      errors.push(`Invalid ASCII slug in ${path.relative(cwd, filePath)}: ${slug}`);
    }
    const duplicate = seenSlugs.get(slug);
    if (duplicate) {
      errors.push(
        `Duplicate slug ${slug}: ${duplicate} and ${path.relative(cwd, filePath)}`,
      );
    }
    seenSlugs.set(slug, path.relative(cwd, filePath));
  }

  const sourceFiles = (
    await Promise.all(sourceRoots.map((target) => getFiles(target)))
  )
    .flat()
    .filter((filePath) => /\.(?:js|mjs|ts|tsx)$/.test(filePath));
  for (const filePath of sourceFiles) {
    const source = await readFile(filePath, 'utf8');
    const chineseRoutes = source.match(/\/docs\/[^\s"'`)]+\p{Script=Han}[^\s"'`)]*/gu);
    for (const route of chineseRoutes ?? []) {
      errors.push(`Chinese internal route in ${path.relative(cwd, filePath)}: ${route}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  console.log(`Validated ${markdownFiles.length} ASCII-only, unique document routes`);
}

async function migrateRoutes() {
  if (contentSource !== 'legacy') {
    throw new Error('Route migration is only supported for DOCS_CONTENT_SOURCE=legacy.');
  }
  const markdownFiles = (await getFiles(docsRoot))
    .filter((filePath) => filePath.endsWith('.mdx'))
    .sort();
  const routeChanges = [];
  const reservedSlugs = new Set();
  const pendingKeyMigrations = [];

  for (const filePath of markdownFiles) {
    const source = await readFile(filePath, 'utf8');
    const oldSlug = readSlug(source, filePath);
    const documentId = path.basename(filePath, '.mdx');
    if (chinesePattern.test(oldSlug)) {
      const newSlug = createEnglishSlug(oldSlug, documentId);
      const output = source.replace(
        /^slug:\s*["'][^"']+["']\s*$/m,
        `slug: "${newSlug}"`,
      );
      await writeFile(filePath, output);
      routeChanges.push({from: oldSlug, to: newSlug});
      reservedSlugs.add(newSlug);
      continue;
    }

    if (isYuqueKeySlug(oldSlug)) {
      pendingKeyMigrations.push({
        filePath,
        oldSlug,
        source,
        title: readTitle(source, filePath),
      });
    } else {
      reservedSlugs.add(oldSlug);
    }
  }

  const duplicateCounts = new Map();
  for (const migration of pendingKeyMigrations.sort((a, b) =>
    a.oldSlug.localeCompare(b.oldSlug),
  )) {
    const parts = migration.oldSlug.split('/').filter(Boolean);
    const routePrefix = `/${parts.slice(0, -1).join('/')}`;
    const titleSlug = createTitleSlug(migration.title);
    const baseSlug = `${routePrefix}/${titleSlug}`;
    let newSlug = baseSlug;
    let suffix = duplicateCounts.get(baseSlug) ?? 1;
    while (reservedSlugs.has(newSlug)) {
      suffix += 1;
      newSlug = `${baseSlug}-${suffix}`;
    }
    duplicateCounts.set(baseSlug, suffix);
    reservedSlugs.add(newSlug);

    const output = migration.source.replace(
      /^slug:\s*["'][^"']+["']\s*$/m,
      `slug: "${newSlug}"`,
    );
    await writeFile(migration.filePath, output);
    routeChanges.push({from: migration.oldSlug, to: newSlug});
  }

  const redirectMap = new Map(
    (await readRedirects()).map(({from, to}) => [from, to]),
  );
  for (const redirect of routeChanges) {
    redirectMap.set(redirect.from, redirect.to);
    for (const [from, to] of redirectMap) {
      if (to === redirect.from) {
        redirectMap.set(from, redirect.to);
      }
    }
  }
  const redirects = Array.from(redirectMap, ([from, to]) => ({from, to})).sort(
    (a, b) => a.from.localeCompare(b.from, 'zh-CN'),
  );
  await mkdir(path.dirname(redirectsFile), {recursive: true});
  await writeFile(redirectsFile, `${JSON.stringify(redirects, null, 2)}\n`);

  const changedSourceFiles = await rewriteRouteReferences(routeChanges);
  await checkRoutes();
  console.log(
    `Migrated ${routeChanges.length} document routes, updated ${changedSourceFiles} source files, and recorded ${redirects.length} redirects`,
  );
}

const command = process.argv[2] ?? 'check';
if (command === 'migrate') {
  await migrateRoutes();
} else if (command === 'check') {
  await checkRoutes();
} else {
  throw new Error(`Unknown command: ${command}`);
}
