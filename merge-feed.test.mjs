// Synthetic host-only fixtures. No network requests and no publication of news.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mergeFeed } from './merge-feed.mjs';
import { articleId, validateFeed } from './validate-feed.mjs';

const generatedAt = '2026-01-20T12:00:00+08:00';
const source = (id = 'fixture-source', name = '合成测试来源') => ({ id, name, category: '学术', adapter: 'briefing', feed_url: '', enabled: 1, note: '仅用于本地合成回归检查，不作为真实新闻发布。', last_checked: null, last_error: null });
function article(index, overrides = {}) {
  const url = `https://www.nasa.gov/news/focus-merge-synthetic-fixture-${index}/`;
  return { id: articleId(url), source_id: 'fixture-source', source_name: '合成测试来源', category: '学术', url, title: 'Synthetic test fixture', title_zh: `合成测试条目${index}`, body: null, body_zh: '这是一段仅用于本地合并工具回归检查的合成中文摘要，不代表真实新闻，不会请求其网址，更不能将它发布给新闻读者。测试用于确认年度文章、来源编号和容量裁剪等规则。', preview_zh: null, scope: 'briefing', language: 'en', translation_status: 'original_zh', translation_error: null, translation_model: null, translated_at: null, published_at: '2026-01-10', image_url: null, saved: 0, read: 0, is_demo: 0, ...overrides };
}
const doc = (articles = [], sources = [source()]) => ({ articles, sources });
const run = (options = {}) => mergeFeed({ base: doc(), generatedAt, edition: '午间', latestIds: [], ...options });
const picture = { image_url: 'https://www.nasa.gov/focus-synthetic-cover.jpg', image_credit: '资料图（非现场）：合成测试归属', image_license: 'Synthetic test only', image_source_url: 'https://www.nasa.gov/focus-synthetic-license/' };

test('a busy column cannot evict all fifty older articles in another column',()=>{
  const busy=Array.from({length:500},(_,i)=>article(10000+i,{category:'AI 新闻',published_at:'2026-01-19'}));
  const academic=Array.from({length:50},(_,i)=>article(20000+i,{category:'学术',published_at:'2025-01-01'}));
  const {feed}=run({base:doc([...busy,...academic])});
  assert.equal(feed.articles.length,500);assert.equal(feed.articles.filter(a=>a.category==='学术').length,50);assert.equal(feed.articles.filter(a=>a.category==='AI 新闻').length,450);
});

test('monthly importance and remote image rights remain attached to a revised story',()=>{
  const original=article(30000,{month_highlight:true,image_url:'https://www.bbc.com/source-synthetic.jpg',image_credit:'BBC source fixture',image_license:null,image_source_url:'https://www.bbc.com/news/source-synthetic',image_usage:'source_remote'});
  const revised=article(30000,{month_highlight:false});
  const {feed}=run({base:doc([original]),additions:[doc([revised])]});
  assert.equal(feed.articles[0].month_highlight,true);assert.equal(feed.articles[0].image_usage,'source_remote');assert.equal(feed.articles[0].image_license,null);
});

test('same exact URL revises once, stable ID retains meaningful query, inputs stay unchanged', () => {
  const url = 'https://developer.apple.com/news/releases/?id=synthetic-test-a';
  const old = article(1, { url, id: articleId(url), year_highlight: true });
  const update = { ...old, title_zh: '更新后的合成中文标题', year_highlight: false };
  const base = doc([old]), additions = [doc([update])];
  const before = structuredClone({ base, additions });
  const { feed } = run({ base, additions, latestIds: [old.id] });
  assert.equal(feed.articles.length, 1);
  assert.equal(feed.articles[0].title_zh, update.title_zh);
  assert.equal(feed.articles[0].year_highlight, true);
  assert.equal(feed.articles[0].id, articleId(url));
  assert.notEqual(articleId(url), articleId(url.replace('test-a', 'test-b')));
  assert.deepEqual({ base, additions }, before);
});

test('same ID with different URL is rejected before overwriting', () => {
  const old = article(1), wrong = { ...article(2), id: old.id };
  assert.throws(() => run({ base: doc([old]), additions: [doc([wrong])] }), /同一文章 ID 对应不同 URL/);
});

test('arbitrary IDs are not silently rewritten', () => {
  assert.throws(() => run({ additions: doc([article(1, { id: 'arbitrary-id' })]) }), /稳定 SHA-256/);
});

test('source name collision receives a deterministic incoming alias and maps its articles', () => {
  const one = article(1), secondSource = source('fixture-source', '另一个合成来源');
  const two = article(2, { source_name: secondSource.name });
  const three = article(3, { source_name: secondSource.name });
  const input = { base: doc([one]), additions: [doc([two], [secondSource]), doc([three], [secondSource])] };
  const first = run(input).feed, again = run(input).feed;
  assert.deepEqual(first, again);
  assert.deepEqual(run({ base: first, additions: input.additions }).feed, first);
  assert.equal(first.sources.length, 2);
  const alias = first.articles.find(value => value.id === two.id).source_id;
  assert.match(alias, /^fixture-source-[a-f0-9]{12}$/);
  assert.equal(first.articles.find(value => value.id === three.id).source_id, alias);
  assert.equal(first.articles.find(value => value.id === one.id).source_id, 'fixture-source');
  assert.equal(first.sources.find(value => value.id === alias).name, secondSource.name);
  assert.ok(validateFeed(first).ok);
});

test('ambiguous duplicate source IDs inside one input are rejected', () => {
  assert.throws(() => run({ base: doc([article(1)], [source(), source('fixture-source', '异名')]) }), /同一输入中重复/);
});

test('same-name compatible feeds canonicalize to the base ID and preserve newer nonempty metadata', () => {
  const oldSource = { ...source('base-id'), feed_url: 'https://www.nasa.gov/news/', note: '基准说明', last_checked: '2026-01-10T00:00:00Z' };
  const updateSource = { ...source('incoming-id'), feed_url: '', note: '较新说明', last_checked: '2026-01-15T00:00:00Z' };
  const olderSource = { ...source('third-id'), feed_url: oldSource.feed_url, note: '较旧说明', last_checked: '2026-01-01T00:00:00Z' };
  const rows = [article(1, { source_id: 'base-id' }), article(2, { source_id: 'incoming-id' }), article(3, { source_id: 'third-id' })];
  const { feed } = run({ base: doc([rows[0]], [oldSource]), additions: [doc([rows[1]], [updateSource]), doc([rows[2]], [olderSource])] });
  assert.equal(feed.sources.length, 1);
  assert.ok(feed.articles.every(value => value.source_id === 'base-id'));
  assert.equal(feed.sources[0].feed_url, oldSource.feed_url);
  assert.equal(feed.sources[0].note, updateSource.note);
  assert.equal(feed.sources[0].last_checked, updateSource.last_checked);
});

test('different nonempty feed URLs with identical names remain distinct', () => {
  const one = { ...source('first'), feed_url: 'https://www.nasa.gov/news/' };
  const two = { ...source('second'), feed_url: 'https://science.nasa.gov/news/' };
  const { feed } = run({ base: doc([article(1, { source_id: one.id })], [one]), additions: doc([article(2, { source_id: two.id })], [two]) });
  assert.deepEqual(feed.sources.map(value => value.id), ['first', 'second']);
});

test('annual protection precedes recency, feed sorts dates and archive keeps only explicit latest order', () => {
  const annual = article(1, { published_at: '2025-01-01', year_highlight: true });
  const oldest = article(2, { published_at: '2026-01-01' });
  const middle = article(3, { published_at: '2026-01-05' });
  const newest = article(4, { published_at: '2026-01-09' });
  const { feed, archive } = run({ base: doc([oldest, annual, middle, newest]), maxArticles: 3, latestIds: [annual.id, newest.id] });
  assert.deepEqual(feed.articles.map(value => value.id), [newest.id, middle.id, annual.id]);
  assert.deepEqual(archive.articles.map(value => value.id), [annual.id, newest.id]);
  assert.deepEqual(archive.latest_article_ids, [annual.id, newest.id]);
  assert.ok(validateFeed(feed).ok);
  assert.ok(validateFeed(archive, { archive: true }).ok);
  assert.equal(validateFeed(archive).ok, false);
});

test('default 500 cap keeps an old annual entry while discarding oldest ordinary entries', () => {
  const annual = article(0, { published_at: '2025-01-01', year_highlight: true });
  const rows = Array.from({ length: 503 }, (_, index) => article(index + 1, { published_at: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 1000).toISOString() }));
  const feed = run({ base: doc([annual, ...rows]) }).feed;
  assert.equal(feed.articles.length, 500);
  assert.equal(feed.articles.at(-1).id, annual.id);
  assert.ok(!feed.articles.some(value => value.id === rows[0].id));
  assert.equal(feed.articles[0].id, rows.at(-1).id);
});

test('protected overflow fails instead of silently evicting annual entries', () => {
  const rows = Array.from({ length: 501 }, (_, index) => article(index, { year_highlight: true }));
  assert.throws(() => run({ base: doc(rows) }), /年度重要(?:文章|及未结束会议) 501 篇超过容量 500/);
});

test('latest is explicit, unique and must survive removals and capacity', () => {
  const old = article(1, { published_at: '2025-01-01' }), recent = article(2);
  assert.throws(() => mergeFeed({ base: doc([old]), generatedAt, edition: '午间' }), /latestIds 必须显式/);
  assert.throws(() => run({ base: doc([old]), latestIds: [old.id, old.id] }), /重复/);
  assert.throws(() => run({ latestIds: [old.id] }), /未保留/);
  assert.throws(() => run({ base: doc([old, recent]), latestIds: [old.id], maxArticles: 1 }), /超出容量/);
  assert.throws(() => run({ base: doc([old]), latestIds: [old.id], removeIds: [old.id] }), /明确移除/);
  assert.deepEqual(run({ base: doc([old]) }).archive.articles, []);
});

test('explicit removal can remove an annual entry and drops unused sources', () => {
  const one = article(1, { year_highlight: true }), anotherSource = source('other', '其他合成来源');
  const two = article(2, { source_id: anotherSource.id, source_name: anotherSource.name });
  const { feed } = run({ base: doc([one, two], [source(), anotherSource, source('unused', '未使用')]), removeIds: [one.id] });
  assert.deepEqual(feed.articles.map(value => value.id), [two.id]);
  assert.deepEqual(feed.sources.map(value => value.id), [anotherSource.id]);
});

test('missing images get all four cover fields; event images survive covers and text-only revisions', () => {
  const event = { ...picture, image_url: 'https://www.nasa.gov/focus-synthetic-event.jpg', image_credit: '合成事件图归属' };
  const one = article(1), two = article(2, event), covers = { 学术: picture };
  const { feed, archive } = run({ base: doc([one, two]), additions: [doc([article(2)])], covers, latestIds: [one.id] });
  for (const [key, value] of Object.entries(picture)) assert.equal(feed.articles.find(value => value.id === one.id)[key], value);
  for (const [key, value] of Object.entries(event)) assert.equal(feed.articles.find(value => value.id === two.id)[key], value);
  archive.articles[0].image_credit = '仅修改返回的档案';
  assert.equal(feed.articles.find(value => value.id === one.id).image_credit, picture.image_credit);
  assert.throws(() => run({ base: doc([one]), covers: { 学术: { image_url: picture.image_url } } }), /栏目配图缺少/);
});

test('equal dates retain first-seen stable order across a revision', () => {
  const one = article(1), two = article(2), three = article(3);
  const { feed } = run({ base: doc([two, one]), additions: [doc([three, { ...two, title_zh: '同日期修订后的中文标题' }])] });
  assert.deepEqual(feed.articles.map(value => value.id), [two.id, one.id, three.id]);
});

test('strict validation blocks unsafe fields, bad metadata and invalid limits', () => {
  assert.throws(() => run({ base: doc([article(1, { private_email: 'synthetic only' })]) }), /未定义字段/);
  assert.throws(() => run({ base: doc([article(1, { body: 'copied original' })]) }), /必须为 null/);
  assert.throws(() => run({ generatedAt: '2026-01-20T12:00:00' }), /含时区/);
  assert.throws(() => run({ edition: '随意' }), /只允许/);
  assert.throws(() => run({ maxArticles: 501 }), /0–500/);
  assert.equal(run({ maxArticles: 0 }).feed.articles.length, 0);
});

test('CLI handles repeated additions, covers, latest and remove JSON files without changing inputs', async () => {
  // The managed Windows runner permits atomic rename inside the workspace, not its virtual TEMP.
  const directory = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.merge-test-'));
  try {
    const one = article(1), two = article(2), three = article(3);
    const files = { 'base.json': doc([one]), 'add-one.json': doc([two]), 'add-two.json': doc([three]), 'covers.json': { 学术: picture }, 'latest.json': [three.id, two.id], 'remove.json': [one.id] };
    for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value));
    const command = fileURLToPath(new URL('./merge-feed.mjs', import.meta.url));
    const args = [command, '--base', join(directory, 'base.json'), '--add', join(directory, 'add-one.json'), '--add', join(directory, 'add-two.json'), '--covers', join(directory, 'covers.json'), '--latest', join(directory, 'latest.json'), '--remove', join(directory, 'remove.json'), '--out', join(directory, 'out.json'), '--archive', join(directory, 'archive.json'), '--generated-at', generatedAt, '--edition', '午间'];
    const execution = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /本地合并通过/);
    const feed = JSON.parse(await readFile(join(directory, 'out.json'), 'utf8'));
    const archive = JSON.parse(await readFile(join(directory, 'archive.json'), 'utf8'));
    assert.equal(feed.articles.length, 2);
    assert.deepEqual(archive.articles.map(value => value.id), [three.id, two.id]);
    assert.ok(validateFeed(feed).ok);
    assert.ok(validateFeed(archive, { archive: true }).ok);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'base.json'), 'utf8')), files['base.json']);
    await writeFile(join(directory, 'latest.json'), '["article-000000000000000000000000"]');
    const before = await readFile(join(directory, 'out.json'), 'utf8');
    const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.equal(await readFile(join(directory, 'out.json'), 'utf8'), before);
  } finally {
    // Only direct files created under this exact mkdtemp directory are removed; no recursive deletion.
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});

test('six columns retain films and combine both AI labels under one floor',()=>{
 const cats=['时政','AI 新闻','游戏','数码','影视','学术'];
 const old=cats.flatMap((category,c)=>Array.from({length:50},(_,i)=>article(40000+c*100+i,{category,published_at:'2025-01-01'})));
 const recent=Array.from({length:500},(_,i)=>article(50000+i,{category:i%2?'AI':'AI 新闻',published_at:'2026-01-19'}));
 const {feed}=run({base:doc(old),additions:[doc(recent)]});
 assert.equal(feed.articles.length,500);
 for(const c of cats.filter(c=>c!=='AI 新闻'))assert.equal(feed.articles.filter(a=>a.category===c).length,50);
 assert.equal(feed.articles.filter(a=>['AI','AI 新闻'].includes(a.category)).length,250);
});

test('upcoming conference survives an old announcement date; expired conference is ordinary',()=>{
 const upcoming=article(60001,{published_at:'2025-01-01',event_start:'2026-02-20',event_end:'2026-02-25'});
 const expired=article(60002,{published_at:'2025-01-02',event_start:'2026-01-01',event_end:'2026-01-05'});
 const recent=article(60003,{published_at:'2026-01-19'});
 const {feed}=run({base:doc([expired,upcoming,recent]),maxArticles:2});
 assert.deepEqual(new Set(feed.articles.map(a=>a.id)),new Set([upcoming.id,recent.id]));
 assert.equal(feed.articles[1].published_at,'2025-01-01');
});

const fig={after_paragraph:1,image_url:'https://www.nasa.gov/figure.png',image_credit:'NASA',image_license:null,image_source_url:'https://www.nasa.gov/news/',image_usage:'source_remote',caption_zh:null};
test('text-only revision preserves inline figures without mutating base',()=>{const original=article(70001,{body_zh:article(1).body_zh+'\n\n第二段研究结果。',inline_images:[fig]});const before=structuredClone(original);const update={...original,title_zh:'修订标题'};delete update.inline_images;const {feed}=run({base:doc([original]),additions:[doc([update])]});assert.deepEqual(feed.articles[0].inline_images,[fig]);assert.deepEqual(original,before);});
test('explicit empty array clears figures while preserving identity and dates',()=>{const original=article(70002,{body_zh:article(1).body_zh+'\n\n第二段研究结果。',inline_images:[fig]});const {feed}=run({base:doc([original]),additions:[doc([{...original,inline_images:[]}])]});assert.deepEqual(feed.articles[0].inline_images,[]);assert.equal(feed.articles[0].id,original.id);assert.equal(feed.articles[0].published_at,original.published_at);});
test('incompatible shortened prose fails rather than silently moving a figure',()=>{const original=article(70003,{body_zh:article(1).body_zh+'\n\n第二段研究结果。',inline_images:[fig]});const update={...original,body_zh:article(1).body_zh};delete update.inline_images;assert.throws(()=>run({base:doc([original]),additions:[doc([update])]}),/实际正文段落之间/);});
