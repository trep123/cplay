const C=require('../cinterp.js'); const ex=require('../src/examples.json');
for(const e of ex){ let out=''; const t=Date.now(); const r=C.run(e.code,e.stdin,{onStdout:s=>out+=s,onStderr:s=>out+='[stderr]'+s,files:e.files}); console.log('=== '+e.title+' ('+(Date.now()-t)+'ms)'); console.log(out); console.log(JSON.stringify(r)); }
