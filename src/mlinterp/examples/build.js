const fs=require('fs'),p=require('path');const d=__dirname;
const T=['基础与显示','矩阵运算与线性方程组','逻辑索引与查找','字符串处理','元胞数组与结构体','函数文件与匿名函数','正弦余弦绘图','子图画廊','三维曲面','常微分方程 ode45','多项式曲线拟合','交互输入 input'];
const ids=['basics','linalg','logical-index','strings','cells-structs','functions','sin-cos-plot','subplot-gallery','surface-3d','ode45','polyfit','input'];
const out=T.map((t,i)=>{const n=String(i+1).padStart(2,'0');const files={'main.m':fs.readFileSync(p.join(d,n+'.m'),'utf8')};
 if(i===5)files['stats.m']=fs.readFileSync(p.join(d,'stats.m'),'utf8');
 const e={id:ids[i],title:`${i+1}. ${t}`,files};if(i===11)e.stdin='小明\n48\n18';return e;});
fs.writeFileSync(p.join(d,'..','examples.json'),JSON.stringify(out,null,2));
