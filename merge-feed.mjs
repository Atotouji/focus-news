#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { articleId, parseFeedJson, validateFeed } from './validate-feed.mjs';

const IMAGE_FIELDS = ['image_url', 'image_credit', 'image_license', 'image_source_url', 'image_usage'];
const ROOT_FIELDS = new Set(['version', 'generated_at', 'edition', 'latest_article_ids', 'articles', 'sources']);
const MAX_BYTES = 4 * 1024 * 1024;
const clone = value => structuredClone(value);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 应为 JSON 对象`);
}

function idList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须显式提供 ID 数组；没有本期文章时使用 []`);
  const seen = new Set();
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !/^article-[a-f0-9]{24}$/.test(id)) throw new Error(`${label}[${index}] 不是稳定的文章 ID`);
    if (seen.has(id)) throw new Error(`${label}[${index}] 重复`);
    seen.add(id);
  }
  return seen;
}

function assertValid(feed, archive, label) {
  const result = validateFeed(feed, { archive });
  if (!result.ok) throw new Error(`${label}未通过严格校验（${result.errors.length} 项）：\n` + result.errors.map(error => '- ' + error).join('\n'));
}

function sourceMetadata(existing, incoming) {
  if (!existing) return incoming;
  const existingTime = Date.parse(existing.last_checked), incomingTime = Date.parse(incoming.last_checked);
  const incomingOlder = Number.isFinite(existingTime) && Number.isFinite(incomingTime) && incomingTime < existingTime;
  const older = incomingOlder ? incoming : existing, newer = incomingOlder ? existing : incoming;
  const result = { ...older };
  for (const [field, value] of Object.entries(newer)) {
    if (value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')) result[field] = value;
  }
  // Identity belongs to the first compatible source, even when the incoming metadata is newer.
  result.id = existing.id;
  return result;
}

/**
 * Merge already researched Chinese briefings. Does not fetch, publish or invent content.
 * Incoming documents may be complete feeds or {articles, sources}; later documents revise earlier ones.
 * IDs hash the exact stored URL, including meaningful query parameters. Inputs are never mutated.
 * Explicit removals override annual protection; otherwise year_highlight cannot be cleared by a revision.
 * Returns a date-sorted feed and a separate archive containing only latestIds, in that explicit order.
 */
export function mergeFeed({ base, additions = [], covers = {}, generatedAt, edition, latestIds, removeIds = [], maxArticles = 500 } = {}) {
  if (!Number.isInteger(maxArticles) || maxArticles < 0 || maxArticles > 500) throw new Error('maxArticles 必须为 0–500 的整数');
  requireObject(covers, 'covers');
  const latest = idList(latestIds, 'latestIds');
  const removed = idList(removeIds, 'removeIds');
  const incoming = Array.isArray(additions) ? additions : [additions];
  const documents = [base, ...incoming];
  const sources = new Map(), byId = new Map(), byUrl = new Map();
  let ordinal = 0;

  for (const [docIndex, document] of documents.entries()) {
    const label = docIndex === 0 ? 'base' : `additions[${docIndex - 1}]`;
    requireObject(document, label);
    for (const field of Object.keys(document)) if (!ROOT_FIELDS.has(field)) throw new Error(`${label}.${field} 是未定义的根字段`);
    if (Object.hasOwn(document, 'version') && document.version !== 1) throw new Error(`${label}.version 必须为 1`);
    if (!Array.isArray(document.articles) || !Array.isArray(document.sources)) throw new Error(`${label} 必须包含 articles 与 sources 数组`);
    const localSourceIds = new Map();
    for (const [index, rawSource] of document.sources.entries()) {
      requireObject(rawSource, `${label}.sources[${index}]`);
      const source = clone(rawSource);
      if (typeof source.id !== 'string' || typeof source.name !== 'string') throw new Error(`${label}.sources[${index}] 缺少来源 ID 或名称`);
      if (localSourceIds.has(source.id)) throw new Error(`${label}.sources[${index}] 来源 ID 在同一输入中重复，无法确定文章归属`);
      const originalId = source.id;
      const existing = sources.get(originalId);
      const canonical = existing?.name === source.name ? existing : [...sources.values()].find(candidate => candidate.name === source.name && (candidate.feed_url === source.feed_url || candidate.feed_url === '' || source.feed_url === ''));
      if (canonical) source.id = canonical.id;
      else if (existing && existing.name !== source.name) {
        const suffix = createHash('sha256').update(originalId + '\0' + source.name, 'utf8').digest('hex').slice(0, 12);
        source.id = originalId.slice(0, 115) + '-' + suffix;
        const aliased = sources.get(source.id);
        if (aliased && aliased.name !== source.name) throw new Error(`${label}.sources[${index}] 稳定来源别名仍有冲突；请明确分配来源 ID`);
      }
      localSourceIds.set(originalId, source.id);
      sources.set(source.id, sourceMetadata(sources.get(source.id), source));
    }
    for (const [index, rawArticle] of document.articles.entries()) {
      requireObject(rawArticle, `${label}.articles[${index}]`);
      const article = clone(rawArticle);
      if (typeof article.id !== 'string' || typeof article.url !== 'string') throw new Error(`${label}.articles[${index}] 缺少文章 ID 或原始 URL`);
      const previous = byId.get(article.id);
      if (previous && previous.article.url !== article.url) throw new Error(`${label}.articles[${index}] 同一文章 ID 对应不同 URL，拒绝覆盖`);
      if (article.id !== articleId(article.url)) throw new Error(`${label}.articles[${index}] ID 必须是原始 URL 的稳定 SHA-256 编号`);
      const sameUrl = byUrl.get(article.url);
      if (sameUrl && sameUrl !== article.id) throw new Error(`${label}.articles[${index}] 同一 URL 存在不同 ID`);
      if (localSourceIds.has(article.source_id)) article.source_id = localSourceIds.get(article.source_id);
      if (previous?.article.year_highlight === true) article.year_highlight = true;
      if (previous?.article.month_highlight === true) article.month_highlight = true;
      if(previous&&!Object.hasOwn(article,'inline_images')&&Object.hasOwn(previous.article,'inline_images'))article.inline_images=clone(previous.article.inline_images);
      // A text-only revision must not replace an existing event photograph with a generic cover.
      if (article.image_url === null && previous?.article.image_url) {
        for (const field of IMAGE_FIELDS) article[field] = field==='image_usage'?(previous.article[field]??'licensed_asset'):previous.article[field];
      }
      byId.set(article.id, { article, ordinal: previous?.ordinal ?? ordinal++ });
      byUrl.set(article.url, article.id);
    }
  }

  const candidates = [...byId.values()].filter(entry => !removed.has(entry.article.id));
  const order = (left, right) => Date.parse(right.article.published_at) - Date.parse(left.article.published_at) || left.ordinal - right.ordinal;
  const generatedDay=Number.isFinite(Date.parse(generatedAt))?new Date(Date.parse(generatedAt)+8*3600000).toISOString().slice(0,10):'';
  const protectedArticles = candidates.filter(({article}) => article.year_highlight === true||(article.category==='学术'&&article.event_start&&article.event_end&&generatedDay&&article.event_end>=generatedDay));
  if (protectedArticles.length > maxArticles) throw new Error(`年度重要及未结束会议 ${protectedArticles.length} 篇超过容量 ${maxArticles}；请明确移除或提高合法容量，不能静默丢弃`);
  const protectedIds=new Set(protectedArticles.map(entry=>entry.article.id));
  const ordinary = candidates.filter(entry => !protectedIds.has(entry.article.id)).sort(order);
  const selection=new Map(protectedArticles.map(entry=>[entry.article.id,entry]));
  // Keep useful breadth in each column as daily updates accumulate.
  const columnFloor=Math.min(50,Math.floor(maxArticles/6));
  const column=entry=>entry.article.category==='AI 新闻'?'AI':entry.article.category;
  for(const category of ['时政','AI','游戏','数码','影视','学术']){
    let count=[...selection.values()].filter(entry=>column(entry)===category).length;
    for(const entry of ordinary)if(count<columnFloor&&column(entry)===category&&!selection.has(entry.article.id)){selection.set(entry.article.id,entry);count++;}
  }
  if(selection.size>maxArticles)throw new Error('年度保护与栏目保留超过容量，不能静默丢弃；请明确调整保留策略');
  for(const entry of ordinary)if(selection.size<maxArticles&&!selection.has(entry.article.id))selection.set(entry.article.id,entry);
  const retained=[...selection.values()].sort(order);
  const retainedIds = new Set(retained.map(entry => entry.article.id));
  for (const id of latest) if (!retainedIds.has(id)) throw new Error('latestIds 包含未保留的文章（不存在、被明确移除或超出容量）；请调整本期选择后重试');

  const articles = retained.map(({ article }) => {
    if (article.image_url === null && Object.hasOwn(covers, article.category)) {
      const cover = covers[article.category];
      requireObject(cover, 'covers 的栏目配图');
      for (const field of IMAGE_FIELDS) {
        if (!Object.hasOwn(cover, field) && field!=='image_usage') throw new Error(`covers 的栏目配图缺少 ${field}`);
        article[field] = field==='image_usage'?(cover[field]??'licensed_asset'):clone(cover[field]);
      }
    }
    return article;
  });
  function usedSources(rows) {
    const ids = new Set(rows.map(article => article.source_id));
    return [...ids].filter(id => sources.has(id)).map(id => clone(sources.get(id)));
  }
  const feed = { version: 1, generated_at: generatedAt, edition, latest_article_ids: [...latest], articles, sources: usedSources(articles) };
  assertValid(feed, false, '聚合 feed ');
  const articleMap = new Map(articles.map(article => [article.id, article]));
  const archiveArticles = [...latest].map(id => clone(articleMap.get(id)));
  const archive = { version: 1, generated_at: generatedAt, edition, latest_article_ids: [...latest], articles: archiveArticles, sources: usedSources(archiveArticles) };
  assertValid(archive, true, '单期 archive ');
  return { feed, archive };
}

async function loadJson(path) {
  if ((await stat(path)).size > MAX_BYTES) throw new Error('输入 JSON 超过 4 MB');
  const bytes = await readFile(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('输入 JSON 必须使用不带 BOM 的 UTF-8');
  return parseFeedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function serializeJson(value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('输出 JSON 格式化后超过客户端 4 MB 上限');
  return serialized;
}

async function writeJson(path, serialized) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + randomUUID();
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('用法：node merge-feed.mjs --base feed.json [--add additions.json ...] [--covers covers.json] --latest latest-ids.json [--remove remove-ids.json] --out feed.json [--archive archives/批次.json] --generated-at ISO含时区 --edition 早间|午间|晚间\n只在本地合并与严格校验，不联网、不发布。--latest 必须为明确选择的 JSON ID 数组。');
    return;
  }
  const options = { add: [] };
  const allowed = new Set(['base', 'add', 'covers', 'latest', 'remove', 'out', 'archive', 'generated-at', 'edition']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('未知参数或缺少参数值；使用 --help 查看用法');
    if (key === 'add') options.add.push(args[index + 1]);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`--${key} 不能重复`);
      options[key] = args[index + 1];
    }
  }
  for (const key of ['base', 'latest', 'out', 'generated-at', 'edition']) if (!options[key]) throw new Error(`缺少 --${key}`);
  if (options.archive && resolve(options.archive).toLowerCase() === resolve(options.out).toLowerCase()) throw new Error('--out 与 --archive 必须是不同文件');
  const loaded = await Promise.all([loadJson(options.base), ...options.add.map(loadJson), options.covers ? loadJson(options.covers) : {}, loadJson(options.latest), options.remove ? loadJson(options.remove) : []]);
  const { feed, archive } = mergeFeed({ base: loaded[0], additions: loaded.slice(1, 1 + options.add.length), covers: loaded[1 + options.add.length], latestIds: loaded[2 + options.add.length], removeIds: loaded[3 + options.add.length], generatedAt: options['generated-at'], edition: options.edition });
  // Check the actual formatted byte counts, as well as both schemas, before changing either file.
  const serializedFeed = serializeJson(feed), serializedArchive = serializeJson(archive);
  if (options.archive) await writeJson(resolve(options.archive), serializedArchive);
  await writeJson(resolve(options.out), serializedFeed);
  console.log(`本地合并通过：${feed.articles.length} 篇、${feed.sources.length} 个来源；年度重要 ${feed.articles.filter(article => article.year_highlight === true).length} 篇；本期 ${archive.articles.length} 篇；${feed.edition} ${feed.generated_at}${options.archive ? '；已生成仅含本期的档案' : ''}。未发布。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error('合并失败：' + error.message); process.exitCode = 1; });
}
