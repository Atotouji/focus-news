#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {validateBilingual} from './validate-bilingual.mjs';
const allowed=new Set(['feed','base','add','out']),args={};
try{
 for(let i=2;i<process.argv.length;i+=2){let key=process.argv[i].replace(/^--/,'');if(!allowed.has(key)||!process.argv[i+1]||args[key])throw Error('Usage: --feed candidate-feed.json --base bilingual-en.json --add english-additions.json --out candidate-bilingual.json');args[key]=process.argv[i+1];}
 for(const k of allowed)if(!args[k])throw Error('Missing --'+k);
 const load=p=>{const b=fs.readFileSync(p);if(b.length>4*1024*1024||b[0]===0xef)throw Error('Invalid UTF8 JSON');return JSON.parse(b.toString('utf8'));};
 const feed=load(args.feed),base=load(args.base),add=load(args.add),rows=new Map();for(const r of [...base.translations,...add.translations])rows.set(r.article_id,r);
 const result={version:1,generated_at:new Date().toISOString(),translations:feed.articles.map(a=>rows.get(a.id)).filter(Boolean)};const checked=validateBilingual(feed,result);if(!checked.ok)throw Error(checked.errors.join('\n'));
 const output=JSON.stringify(result,null,2)+'\n';if(Buffer.byteLength(output)>4*1024*1024)throw Error('Output too large');fs.mkdirSync(path.dirname(args.out),{recursive:true});const temp=args.out+'.tmp-'+randomUUID();fs.writeFileSync(temp,output,{encoding:'utf8',flag:'wx'});fs.renameSync(temp,args.out);console.log('Bilingual merge passed: '+result.translations.length+' translations. Not published.');
}catch(e){console.error(e.message);process.exitCode=1;}
