const C=require('../cinterp.js');
for (const [n,code] of [['loop1e7','#include <stdio.h>\nint main(){long s=0; for(int i=0;i<10000000;i++) s+=i%7; printf("%ld\\n",s); return 0;}'],['fib30','#include <stdio.h>\nint fib(int n){return n<2?n:fib(n-1)+fib(n-2);} int main(){printf("%d\\n",fib(30));return 0;}'],['out100k','#include <stdio.h>\nint main(){for(int i=0;i<100000;i++) printf("%d\\n",i); return 0;}']]){
 let o=0,chunks=0; const t=Date.now(); const r=C.run(code,'',{onStdout:s=>{o+=s.length;chunks++}}); console.log(n, Date.now()-t,'ms', o, chunks, JSON.stringify(r.error)); }
