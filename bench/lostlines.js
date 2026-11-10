// lines that base, A and B all have (nobody deleted them) but Tandemi's merge lost: node lostlines.js <engine dir> <scored.json>
// for "different" results: lines that are in base, A and B (nobody touched them) but missing from Tandemi's result
const fs=require('fs'),path=require('path'); const MERGE=require(path.join(process.argv[2],'merge.js'));
const rows=JSON.parse(fs.readFileSync(process.argv[3])); const want=new Set(rows.filter(r=>r.outcome==='different').map(r=>r.repo+r.merge+r.file));
const cases=[]; for(const f of fs.readdirSync('cases')) for(const l of fs.readFileSync('cases/'+f,'utf8').split('\n')) if(l){const c=JSON.parse(l); if(want.has(c.repo+c.merge.slice(0,10)+c.file)) cases.push(c);}
const cnt=(t)=>{const m=new Map(); for(const l of t.split('\n').map(x=>x.trim()).filter(Boolean)) m.set(l,(m.get(l)||0)+1); return m;};
(async()=>{ await MERGE.prepare(cases.map(c=>c.file)); let bad=0, lost=0; const ex=[];
 for(const c of cases){ const n=x=>x.replace(/\r\n/g,'\n'); const o=n(c.base_),a=n(c.a),b=n(c.b); const r=MERGE.merge(c.file,o,a,b); const t=MERGE.fill(r.template,r.conflicts);
  const O=cnt(o),A=cnt(a),B=cnt(b),T=cnt(t); let miss=[];
  for(const [l,k] of O){ const keep=Math.min(k,A.get(l)||0,B.get(l)||0); if((T.get(l)||0)<keep) miss.push(l); }
  // lines both sides added the same way
  for(const [l,k] of A){ if((O.get(l)||0)===0 && (B.get(l)||0)>0 && (T.get(l)||0)===0) miss.push('(both added) '+l); }
  if(miss.length){bad++; lost+=miss.length; if(ex.length<25) ex.push(c.repo+' '+c.file+'\n   '+miss.slice(0,4).join('\n   '));}
 }
 console.log('files losing lines everyone kept:',bad,'lines:',lost,'of',cases.length); console.log(ex.join('\n'));
})();
