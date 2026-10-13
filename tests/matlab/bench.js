const M=require('../../mlinterp.js');
function t(name,src){let out='';const t0=Date.now();const r=M.run(src,{onStdout:s=>out+=s});console.log(name, (Date.now()-t0)+'ms', JSON.stringify(r.error), out.slice(0,200).replace(/\n/g,' | '));}
t('loop1e6','s=0; for k=1:1e6, s=s+k; end; disp(s)');
t('fib20','function r=fib(n)\nif n<2\n r=n;\nelse\n r=fib(n-1)+fib(n-2);\nend\nend');
t('fib20s','disp(fib(20))\nfunction r=fib(n)\nif n<2\n r=n;\nelse\n r=fib(n-1)+fib(n-2);\nend\nend');
t('grow','x=[]; for k=1:1e5, x(end+1)=k; end; disp(sum(x))');
t('idx','x=zeros(1,1e5); for k=1:1e5, x(k)=k^2; end; disp(x(end))');
t('while','k=0; while k<1e6, k=k+1; end; disp(k)');
t('rec','function r=f(n)\nif n==0, r=0; else r=1+f(n-1); end\nend');
t('rec2','disp(f(250))\nfunction r=f(n)\nif n==0, r=0; else r=1+f(n-1); end\nend');
t('inf','while true, end');
