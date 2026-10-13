% 示例 4：字符串处理
% 演示 sprintf、strsplit、regexprep、upper、num2str 等函数
s = 'hello matlab world';
% upper / lower：大小写转换
u = upper(s)
% strsplit：按分隔符拆分为元胞数组
words = strsplit(s, ' ')
n = numel(words);
fprintf('共有 %d 个单词\n', n);
% 逐个处理：首字母大写
for k = 1:n
    w = words{k};
    words{k} = [upper(w(1)) w(2:end)];
end
title_s = strjoin(words, ' ')
% sprintf：格式化生成字符串（不直接输出）
msg = sprintf('第 %d 项的长度为 %d', 2, length(words{2}))
% num2str：数字转字符串，便于拼接
x = 3.14159;
info = ['x 的值是 ' num2str(x) '，保留两位：' num2str(x, '%.2f')]
% regexprep：正则表达式替换（把数字替换为 #）
code = 'ID2024-A17-B3';
masked = regexprep(code, '\d', '#')
% 替换多个空格为单个空格
clean = regexprep('a   b    c', '\s+', ' ')
% strrep 与 strfind
r = strrep(s, 'world', '世界')
pos = strfind(s, 'o')
