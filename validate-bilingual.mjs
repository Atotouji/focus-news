#!/usr/bin/env node
import fs from 'node:fs';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
export function briefingParagraphs(body){
 const lines=(body??'').replaceAll('\r\n','\n').split('\n');
 const citation=/^(?:(?:原始|原文|主要|参考|核验|资料|图片|新闻|论文|官方)?来源|来源原文|原文链接|新闻原页|论文DOI|论文 DOI|DOI|参考链接|核验链接|图片出处|原始报道|论文原页|官方公告|开放全文)[：:].*(?:https?:\/\/|doi\.org\/)/i;
 while(lines.length&&(!lines.at(-1).trim()||citation.test(lines.at(-1).trim())||/^https?:\/\/\S+$/.test(lines.at(-1).trim())))lines.pop();
 return lines.join('\n').trim().split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
}
export const briefingHash=a=>createHash('sha256').update(briefingParagraphs(a.body_zh).join('\n\n'),'utf8').digest('hex');
export function validateBilingual(feed,bundle){
 const errors=[],fail=s=>errors.push(s),articles=new Map((feed.articles??[]).map(a=>[a.id,a]));
 if(!bundle||bundle.version!==1||!Number.isFinite(Date.parse(bundle.generated_at)))return {ok:false,errors:['Invalid bilingual version/time']};
 if(Object.keys(bundle).some(k=>!['version','generated_at','translations'].includes(k)))fail('Unexpected root field');
 if(!Array.isArray(bundle.translations)||bundle.translations.length>500)return {ok:false,errors:['Invalid translation array']};
 const ids=new Set();
 for(const row of bundle.translations){
  if(!row||typeof row!=='object'){fail('Invalid row');continue;}
  if(Object.keys(row).some(k=>!['article_id','source_sha256','paragraphs','method','engine'].includes(k)))fail('Unexpected translation field');
  if(ids.has(row.article_id))fail('Duplicate '+row.article_id);ids.add(row.article_id);const article=articles.get(row.article_id);
  if(!article){fail('Unknown article '+row.article_id);continue;}
  if(row.source_sha256!==briefingHash(article))fail('Stale Chinese hash '+row.article_id);
  if(!['machine_translation','editorial_translation'].includes(row.method)||typeof row.engine!=='string'||!row.engine.trim()||row.engine.length>300)fail('Missing translation provenance '+row.article_id);
  if(!Array.isArray(row.paragraphs)||row.paragraphs.length!==briefingParagraphs(article.body_zh).length||row.paragraphs.length>100){fail('Paragraph count mismatch '+row.article_id);continue;}
  for(const p of row.paragraphs)if(typeof p!=='string'||p.trim().length<1||p.length>20000||/[\r\n\u4e00-\u9fff]/u.test(p))fail('Invalid English paragraph '+row.article_id);
 }
 for(const id of articles.keys())if(!ids.has(id))fail('Missing translation '+id);
 if(Buffer.byteLength(JSON.stringify(bundle),'utf8')>4*1024*1024)fail('Bilingual data exceeds 4 MB');
 return {ok:!errors.length,errors,articles:articles.size,paragraphs:bundle.translations.reduce((n,r)=>n+(r.paragraphs?.length??0),0)};
}
function selfTest(){
 const a={id:'article-'+'a'.repeat(24),body_zh:'中文 **重点**。\n\n第二段。'},feed={articles:[a]},row={article_id:a.id,source_sha256:briefingHash(a),paragraphs:['First.','Second.'],method:'machine_translation',engine:'synthetic'},good={version:1,generated_at:'2026-11-03T00:00:00Z',translations:[row]};let checks=0;
 const check=(v,expected,label)=>{checks++;if(validateBilingual(feed,v).ok!==expected)throw Error(label);};check(good,true,'valid');
 for(const [field,value] of [['source_sha256','bad'],['paragraphs',['one']],['paragraphs',['中文','Second.']],['method','source_full_text'],['engine','']]){const v=structuredClone(good);v.translations[0][field]=value;check(v,false,field);}
 const duplicate=structuredClone(good);duplicate.translations.push(row);check(duplicate,false,'duplicate');check({...good,translations:[]},false,'missing');const unknown=structuredClone(good);unknown.translations[0].article_id='unknown';check(unknown,false,'unknown');
 console.log('Bilingual self-tests passed: '+checks);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv[2]==='--self-test')selfTest();else{const load=p=>{const bytes=fs.readFileSync(p);if(bytes.length>4*1024*1024||bytes[0]===0xef)throw Error('Invalid encoding or size');return JSON.parse(bytes.toString('utf8'));};const result=validateBilingual(load(process.argv[2]),load(process.argv[3]));if(!result.ok)throw Error(result.errors.join('\n'));console.log(`Bilingual validation passed: ${result.articles} articles / ${result.paragraphs} paired paragraphs`);}}catch(e){console.error(e.message);process.exitCode=1;}
}
