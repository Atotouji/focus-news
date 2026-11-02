#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_FIELDS = ['version', 'generated_at', 'edition', 'latest_article_ids', 'articles', 'sources'];
const ARTICLE_FIELDS = ['id', 'source_id', 'source_name', 'category', 'url', 'title', 'title_zh', 'body', 'body_zh', 'preview_zh', 'scope', 'language', 'translation_status', 'translation_error', 'translation_model', 'translated_at', 'published_at', 'image_url', 'saved', 'read', 'is_demo'];
const ARTICLE_OPTIONAL_FIELDS = ['image_credit', 'image_license', 'image_source_url', 'image_usage', 'reference_urls', 'year_highlight', 'month_highlight'];
const SOURCE_FIELDS = ['id', 'name', 'category', 'adapter', 'feed_url', 'enabled', 'note', 'last_checked', 'last_error'];
const CATEGORIES = new Set(['时政', 'AI 新闻', '游戏', '数码', '学术', '未分类']);
const EDITIONS = new Set(['早间', '午间', '晚间']);
const MAX_BYTES = 4 * 1024 * 1024;
const cp = value => [...value].length;

/** Hash the exact, already cleaned original URL; meaningful query parameters remain part of its identity. */
export function articleId(url) {
  return 'article-' + createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 24);
}

function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !calendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return NaN;
  const zone = match[5];
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0))) return NaN;
  return Date.parse(value);
}

function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return true;
  return /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host)
    || /(?:^|\.)example\.(?:com|org|net)$/.test(host);
}

function publicUrl(value, allowEmpty = false) {
  if (allowEmpty && value === '') return true;
  if (typeof value !== 'string' || value !== value.trim() || /[\s\\]/u.test(value) || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || privateHost(url.hostname) || (url.port && url.port !== '443')) return false;
    for (const key of url.searchParams.keys()) {
      if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|.*(?:token|password|secret|credential).*|auth(?:orization)?|api[_-]?key|key|session(?:id)?|signature|sig|x-amz-.+|x-goog-.+)$/i.test(key)) return false;
    }
    return true;
  } catch { return false; }
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Offline structural checks. Source authenticity, factual accuracy and text rights require editorial review. */
export function validateFeed(feed, { now = Date.now(), archive = false } = {}) {
  const errors = [];
  const fail = (path, text) => errors.push(`${path}: ${text}`);
  function object(value, fields, path, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(path, '应为 JSON 对象'); return false; }
    for (const key of fields) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, '缺少字段；可空字段也须显式写 null');
    for (const key of Object.keys(value)) if (!fields.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, '未定义字段；不要加入凭据、账号或私人资料');
    return true;
  }
  function text(value, path, min = 1, max = 2000, nullable = false) {
    if (nullable && value === null) return true;
    if (typeof value !== 'string' || cp(value.trim()) < min || cp(value) > max) { fail(path, `应为 ${min}–${max} 个字符的文本${nullable ? '或 null' : ''}`); return false; }
    return true;
  }
  function equals(value, wanted, path) { if (value !== wanted) fail(path, `必须为 ${JSON.stringify(wanted)}`); }
  function date(value, path, { dateOnly = false, max = now, nullable = false } = {}) {
    if (nullable && value === null) return NaN;
    if(dateOnly&&typeof value==='string'&&/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value)){
      if(value>new Date(max+14*60*60*1000).toISOString().slice(0,7))fail(path,'来源月份不能晚于当前批次');
      return Date.parse(value+'-01'); // Sorting key only: the displayed and stored value stays month-precision.
    }
    if (dateOnly && typeof value === 'string' && calendarDate(value)) {
      // Date-only sorting uses a comparison key, never a fabricated publication time.
      if (value > new Date(max + 14 * 60 * 60 * 1000).toISOString().slice(0, 10)) fail(path, '来源日期不能晚于当前批次');
      return Date.parse(value);
    }
    const result = timestamp(value);
    if (!Number.isFinite(result)) fail(path, dateOnly ? '应为已核年月 YYYY-MM、真实 YYYY-MM-DD 或含时区 ISO 时间；不要补造未知日或时分秒' : '应为含时区的 ISO 时间，例如 YYYY-MM-DDTHH:mm:ss+08:00');
    else if (result > max) fail(path, '不能使用未来时间');
    return result;
  }

  // Check obvious accidental disclosures without echoing detected values into logs.
  const stack = [[feed, '$', 0]];
  while (stack.length) {
    const [value, path, depth] = stack.pop();
    if (depth > 8) { fail(path, '嵌套层级过深'); continue; }
    if (typeof value === 'string') {
      if (!wellFormed(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, '含损坏的 Unicode 或控制字符');
      const outsideUrls=value.replace(/https?:\/\/[^\s<>"']+/gu,'');
      if (/(?:\b[A-Za-z]:[\\/]|\/(?:Users|home)\/)/.test(outsideUrls)) fail(path, '包含本机私人路径');
      if (/(?:\bgh[pousr]_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----)/.test(value)) fail(path, '疑似包含密钥或访问凭据');
    } else if (value && typeof value === 'object') {
      for (const [key, next] of Object.entries(value)) stack.push([next, `${path}.${key}`, depth + 1]);
    }
  }
  if (!object(feed, ROOT_FIELDS, '$')) return { ok: false, errors };
  equals(feed.version, 1, '$.version');
  const generated = date(feed.generated_at, '$.generated_at');
  if (!EDITIONS.has(feed.edition)) fail('$.edition', '只允许早间、午间、晚间');
  if (!Array.isArray(feed.articles) || feed.articles.length > 500) fail('$.articles', '应为最多 500 篇文章的数组');
  if (!Array.isArray(feed.sources) || feed.sources.length > 500) fail('$.sources', '应为最多 500 个来源的数组');
  if (!Array.isArray(feed.latest_article_ids) || feed.latest_article_ids.length > 500) fail('$.latest_article_ids', '必须显式提供本期 ID 数组，无消息可用 []');
  const sources = new Map();
  for (const [index, source] of (Array.isArray(feed.sources) ? feed.sources : []).entries()) {
    const path = `$.sources[${index}]`;
    if (!object(source, SOURCE_FIELDS, path)) continue;
    if (text(source.id, `${path}.id`, 1, 128) && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(source.id)) fail(`${path}.id`, '使用稳定的 ASCII 来源编号');
    if (sources.has(source.id)) fail(`${path}.id`, '来源编号重复');
    sources.set(source.id, source);
    text(source.name, `${path}.name`, 1, 200);
    if (!CATEGORIES.has(source.category)) fail(`${path}.category`, '栏目不受支持');
    equals(source.adapter, 'briefing', `${path}.adapter`);
    equals(source.enabled, 1, `${path}.enabled`);
    if (!publicUrl(source.feed_url, true)) fail(`${path}.feed_url`, '须为空字符串或不含凭据的公开 HTTPS 来源地址');
    text(source.note, `${path}.note`, 1, 2000);
    date(source.last_checked, `${path}.last_checked`, { nullable: true, max: Number.isFinite(generated) ? generated : now });
    equals(source.last_error, null, `${path}.last_error`);
  }
  const ids = new Set(), urls = new Set();
  let previousTime = Infinity;
  for (const [index, article] of (Array.isArray(feed.articles) ? feed.articles : []).entries()) {
    const path = `$.articles[${index}]`;
    if (!object(article, ARTICLE_FIELDS, path, ARTICLE_OPTIONAL_FIELDS)) continue;
    if (!publicUrl(article.url)) fail(`${path}.url`, '须为公开原始来源 HTTPS 地址；禁止示例/本机地址、片段和跟踪/凭据参数');
    if (typeof article.url === 'string' && article.id !== articleId(article.url)) fail(`${path}.id`, '须为 article- 加原始 URL UTF-8 SHA-256 前 24 位小写十六进制');
    if (ids.has(article.id)) fail(`${path}.id`, '文章编号重复');
    if (urls.has(article.url)) fail(`${path}.url`, '原始来源 URL 重复');
    ids.add(article.id); urls.add(article.url);
    const source = sources.get(article.source_id);
    if (!source) fail(`${path}.source_id`, '对应来源不存在；保留历史文章时也须保留其来源');
    else if (article.source_name !== source.name) fail(`${path}.source_name`, '必须与来源名称一致');
    if (!CATEGORIES.has(article.category)) fail(`${path}.category`, '栏目不受支持');
    text(article.title, `${path}.title`, 1, 500);
    if (text(article.title_zh, `${path}.title_zh`, 1, 250) && !/\p{Script=Han}/u.test(article.title_zh)) fail(`${path}.title_zh`, '应提供中文标题');
    if (text(article.body_zh, `${path}.body_zh`, 40, 12000)) {
      if (cp(article.body_zh.replace(/\s/gu, '')) < 40 || !/\p{Script=Han}/u.test(article.body_zh)) fail(`${path}.body_zh`, '应为至少 40 个非空白字符的中文原创摘要');
    }
    text(article.preview_zh, `${path}.preview_zh`, 0, 360, true);
    equals(article.scope, 'briefing', `${path}.scope`);
    equals(article.body, null, `${path}.body`);
    equals(article.translation_status, 'original_zh', `${path}.translation_status`);
    equals(article.translation_error, null, `${path}.translation_error`);
    equals(article.translated_at, null, `${path}.translated_at`);
    text(article.translation_model, `${path}.translation_model`, 1, 200, true);
    if (article.image_url !== null) {
      if (!publicUrl(article.image_url)) fail(`${path}.image_url`, '配图必须是公开 HTTPS 图片地址');
      text(article.image_credit, `${path}.image_credit`, 1, 500);
      text(article.image_license, `${path}.image_license`, 1, 500, article.image_usage==='source_remote');
      if (!publicUrl(article.image_source_url)) fail(`${path}.image_source_url`, '有配图时必须提供可核验归属的来源页面');
    } else {
      for (const field of ['image_credit','image_license','image_source_url']) if (Object.hasOwn(article,field) && article[field] !== null) fail(`${path}.${field}`, '无图片时归属字段应为 null 或省略');
    }
    if (Object.hasOwn(article,'year_highlight') && typeof article.year_highlight !== 'boolean') fail(`${path}.year_highlight`, '年度重要标记应为布尔值');
    if (Object.hasOwn(article,'month_highlight') && typeof article.month_highlight !== 'boolean') fail(`${path}.month_highlight`, '月度重要标记应为布尔值');
    if (Object.hasOwn(article,'image_usage') && article.image_usage!==null && !['source_remote','licensed_asset'].includes(article.image_usage)) fail(`${path}.image_usage`, '图片用途须为source_remote或licensed_asset');
    if (Object.hasOwn(article,'reference_urls')) {
      if (!Array.isArray(article.reference_urls) || article.reference_urls.length > 20) fail(`${path}.reference_urls`, '相关报道和公开论文全文链接最多20个');
      else { const references=new Set();for(const link of article.reference_urls){if(!publicUrl(link)||references.has(link))fail(`${path}.reference_urls`, '应为不重复的公开 HTTPS 来源链接');references.add(link);} }
    }
    for (const key of ['saved', 'read', 'is_demo']) equals(article[key], 0, `${path}.${key}`);
    if (typeof article.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(article.language)) fail(`${path}.language`, '应为原始来源的语言代码，例如 en 或 zh');
    const published = date(article.published_at, `${path}.published_at`, { dateOnly: true, max: Number.isFinite(generated) ? generated : now });
    if (!archive && Number.isFinite(published) && published > previousTime) fail(`${path}.published_at`, 'feed.json 应按来源发表日期降序；单期档案可使用 --archive');
    if (Number.isFinite(published)) previousTime = published;
  }
  const latest = new Set();
  for (const [index, id] of (Array.isArray(feed.latest_article_ids) ? feed.latest_article_ids : []).entries()) {
    if (typeof id !== 'string' || !ids.has(id)) fail(`$.latest_article_ids[${index}]`, '必须引用当前 articles 中的文章编号');
    if (latest.has(id)) fail(`$.latest_article_ids[${index}]`, '本期编号重复');
    latest.add(id);
  }
  if (Array.isArray(feed.articles) && feed.articles.length === 0 && latest.size > 0) fail('$.latest_article_ids', '没有文章时本期列表必须为空');
  try { if (Buffer.byteLength(JSON.stringify(feed), 'utf8') > MAX_BYTES) fail('$', 'JSON 超过客户端 4 MB 上限'); }
  catch { fail('$', '数据无法序列化为 JSON'); }
  return { ok: errors.length === 0, errors, articles: ids.size, sources: sources.size, latest: latest.size };
}

/** JSON.parse alone silently accepts duplicate properties, which can hide discarded sensitive values. */
export function parseFeedJson(text) {
  const value = JSON.parse(text);
  let position = 0;
  const space = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  function string() {
    const start = position++;
    while (position < text.length) {
      const next = text[position++];
      if (next === '\\') position++;
      else if (next === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error('JSON 字符串未结束');
  }
  function scan(depth) {
    if (depth > 8) throw new Error('JSON 嵌套层级过深');
    space();
    const next = text[position];
    if (next === '{') {
      position++; space();
      const keys = new Set();
      if (text[position] === '}') { position++; return; }
      for (;;) {
        space(); const key = string();
        if (keys.has(key)) throw new Error('JSON 含重复字段，不能可靠复核被覆盖的内容');
        keys.add(key); space(); position++; scan(depth + 1); space();
        if (text[position++] === '}') return;
      }
    }
    if (next === '[') {
      position++; space();
      if (text[position] === ']') { position++; return; }
      for (;;) { scan(depth + 1); space(); if (text[position++] === ']') return; }
    }
    if (next === '"') { string(); return; }
    while (position < text.length && !/[\s,\]}]/.test(text[position])) position++;
  }
  scan(0);
  return value;
}

async function loadJson(path) {
  if ((await stat(path)).size > MAX_BYTES) throw new Error('JSON 文件超过 4 MB');
  const bytes = await readFile(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('请使用不带 BOM 的 UTF-8 JSON');
  return parseFeedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function selfTest() {
  const now = Date.parse('2026-11-02T05:30:00Z');
  const url = 'https://www.nasa.gov/news/validation-fixture-1';
  const source = { id: 'nasa', name: 'NASA', category: '数码', adapter: 'briefing', feed_url: 'https://www.nasa.gov/', enabled: 1, note: '仅用于校验器合成测试，不发布为新闻。', last_checked: null, last_error: null };
  const article = { id: articleId(url), source_id: 'nasa', source_name: 'NASA', category: '数码', url, title: 'Synthetic validation fixture', title_zh: '合成校验样本', body: null, body_zh: '这是一条仅用于校验器回归检查的合成播报稿，不代表真实新闻，不会由本脚本发布到新闻库。公开播报必须核查真实原始来源。', preview_zh: null, scope: 'briefing', language: 'en', translation_status: 'original_zh', translation_error: null, translation_model: null, translated_at: null, published_at: '2026-11-02', image_url: null, saved: 0, read: 0, is_demo: 0 };
  const fixture = { version: 1, generated_at: '2026-11-02T13:29:00+08:00', edition: '午间', latest_article_ids: [article.id], articles: [article], sources: [source] };
  let checks = 0;
  const test = (label, change, expected = false) => {
    const value = structuredClone(fixture); change(value);
    const result = validateFeed(value, { now }); checks++;
    if (result.ok !== expected) throw new Error(`自检失败：${label}`);
  };
  test('valid fixture', () => {}, true);
  test('games category', value => { value.articles[0].category = '游戏'; value.sources[0].category = '游戏'; }, true);
  test('retired sports category', value => { value.articles[0].category = '体育'; value.sources[0].category = '体育'; });
  test('empty latest permitted', value => { value.latest_article_ids = []; }, true);
  test('wrong version', value => { value.version = 2; });
  test('missing root field', value => { delete value.latest_article_ids; });
  test('missing nullable field', value => { delete value.articles[0].body; });
  test('unknown root field', value => { value.credentials = {}; });
  test('full original text', value => { value.articles[0].body = 'copied original'; });
  test('wrong scope', value => { value.articles[0].scope = 'full_text'; });
  test('short summary', value => { value.articles[0].body_zh = '太短'; });
  test('detailed original report', value => { value.articles[0].body_zh = '文'.repeat(6000); }, true);
  test('oversized summary', value => { value.articles[0].body_zh = '文'.repeat(12001); });
  test('missing Chinese title', value => { value.articles[0].title_zh = null; });
  test('wrong status', value => { value.articles[0].translation_status = 'translated'; });
  for (const key of ['is_demo', 'saved', 'read']) test(`nonzero ${key}`, value => { value.articles[0][key] = 1; });
  test('unlicensed image disallowed', value => { value.articles[0].image_url = 'https://www.nasa.gov/image.jpg'; });
  test('credited licensed image', value => { Object.assign(value.articles[0],{image_url:'https://www.nasa.gov/image.jpg',image_credit:'NASA',image_license:'Public Domain',image_source_url:'https://www.nasa.gov/nasa-brand-center/images-and-media/'}); },true);
  test('image license required', value => { Object.assign(value.articles[0],{image_url:'https://www.nasa.gov/image.jpg',image_credit:'NASA',image_source_url:'https://www.nasa.gov/nasa-brand-center/images-and-media/'}); });
  test('image source required', value => { Object.assign(value.articles[0],{image_url:'https://www.nasa.gov/image.jpg',image_credit:'NASA',image_license:'Public Domain'}); });
  test('annual milestone', value => { value.articles[0].year_highlight=true; },true);
  test('annual flag type', value => { value.articles[0].year_highlight='yes'; });
  test('monthly important flag', value => { value.articles[0].month_highlight=true; },true);
  test('monthly flag type', value => { value.articles[0].month_highlight=1; });
  test('month precision retains unknown day', value => { value.articles[0].published_at='2026-02'; },true);
  test('invalid month precision', value => { value.articles[0].published_at='2026-13'; });
  test('source image is a link without relicensing', value => { Object.assign(value.articles[0],{image_url:'https://ichef.bbci.co.uk/news/1024/source.jpg',image_credit:'BBC 原报道署名见原文',image_license:null,image_source_url:'https://www.bbc.com/news/articles/source-image',image_usage:'source_remote'}); },true);
  test('licensed image still needs license', value => { Object.assign(value.articles[0],{image_url:'https://www.nasa.gov/source.jpg',image_credit:'NASA',image_license:null,image_source_url:'https://www.nasa.gov/source/',image_usage:'licensed_asset'}); });
  test('public home URL is not a private path', value => { value.articles[0].reference_urls=['https://www.businesswire.com/news/home/20260105738564/en/CES-2026-Intel']; },true);
  test('local UNIX home path remains private', value => { value.articles[0].body_zh+=' /home/private/research'; });
  test('related readable sources', value => { value.articles[0].reference_urls=['https://www.nasa.gov/news/']; },true);
  test('related source must be public', value => { value.articles[0].reference_urls=['file:///private']; });
  test('missing source', value => { value.sources = []; });
  test('wrong source name', value => { value.articles[0].source_name = 'Other'; });
  test('duplicate article', value => { value.articles.push(structuredClone(value.articles[0])); });
  test('duplicate source', value => { value.sources.push(structuredClone(value.sources[0])); });
  test('unknown latest ID', value => { value.latest_article_ids = ['missing']; });
  test('duplicate latest ID', value => { value.latest_article_ids.push(article.id); });
  test('future generation', value => { value.generated_at = '2026-11-03T13:29:00+08:00'; });
  test('timezone required', value => { value.generated_at = '2026-11-02T13:29:00'; });
  test('invalid calendar date', value => { value.articles[0].published_at = '2026-02-30'; });
  test('invented edition', value => { value.edition = '首期'; });
  test('unstable ID', value => { value.articles[0].id = 'random-id'; value.latest_article_ids = ['random-id']; });
  test('example URL', value => { value.articles[0].url = 'https://example.com/news'; });
  test('private URL', value => { value.articles[0].url = 'https://192.168.1.1/news'; });
  test('token in URL', value => { value.articles[0].url = url + '?access_token=not-a-real-token'; });
  test('local path', value => { value.articles[0].body_zh += ' C:/Users/private/file'; });
  test('secret marker', value => { value.articles[0].body_zh += ' ghp_' + 'x'.repeat(36); });
  test('bad Unicode', value => { value.articles[0].body_zh += '\ud800'; });
  test('extra article key', value => { value.articles[0].private_email = 'not for publishing'; });
  test('source disabled', value => { value.sources[0].enabled = 0; });
  test('article limit', value => { value.articles = Array.from({ length: 501 }, () => structuredClone(article)); });
  test('meaningful query retained', value => { value.articles[0].url += '?id=10302026a'; value.articles[0].id = articleId(value.articles[0].url); value.latest_article_ids = [value.articles[0].id]; }, true);
  test('tracking query rejected', value => { value.articles[0].url += '?utm_source=test'; value.articles[0].id = articleId(value.articles[0].url); value.latest_article_ids = [value.articles[0].id]; });
  for (const text of ['{"version":1,"version":1}', '{"version":1,"\\u0076ersion":1}', '{"a":{"id":1,"id":2}}']) {
    let rejected = false; try { parseFeedJson(text); } catch { rejected = true; }
    checks++; if (!rejected) throw new Error('自检失败：重复 JSON 字段未被拒绝');
  }
  checks++;
  if (parseFeedJson('{"text":"escaped \\\" \\\\ { } [ ]", "array":[{"id":1},{"id":2}]}').array.length !== 2) throw new Error('自检失败：JSON 字符串边界');
  return checks;
}

async function main(args) {
  if (args[0] === '--self-test') { console.log(`校验器合成回归通过：${selfTest()} 项（不生成或发布新闻）`); return; }
  if (args[0] === '--article-id' && args.length === 2) { console.log(articleId(args[1])); return; }
  if (!args.length || args.includes('--help')) {
    console.log('用法：node validate-feed.mjs feed.json [--archive]\n      node validate-feed.mjs --self-test\n      node validate-feed.mjs --article-id "https://原始来源地址"');
    return;
  }
  if (args.length > 2 || (args[1] && args[1] !== '--archive')) throw new Error('未知参数；使用 --help 查看用法');
  const feed = await loadJson(resolve(args[0]));
  const result = validateFeed(feed, { archive: args.includes('--archive') });
  if (!result.ok) { console.error(`校验失败（${result.errors.length} 项）：\n` + result.errors.map(error => '- ' + error).join('\n')); process.exitCode = 1; }
  else console.log(`校验通过：${result.articles} 篇保留文章，${result.sources} 个来源，本期 ${result.latest} 条；${feed.edition} ${feed.generated_at}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error('校验失败：' + error.message); process.exitCode = 1; });
}
