% 示例 12：交互输入 input
% input(提示) 读取数值表达式；input(提示, 's') 按原样读取字符串
name = input('请输入你的名字：', 's');
a = input('请输入第一个数：');
b = input('请输入第二个数：');
fprintf('\n你好，%s！\n', name);
% 基本四则运算
fprintf('%g + %g = %g\n', a, b, a + b);
fprintf('%g - %g = %g\n', a, b, a - b);
fprintf('%g × %g = %g\n', a, b, a * b);
% 除法前先检查除数是否为 0
if b ~= 0
    fprintf('%g ÷ %g = %.4f\n', a, b, a / b);
else
    disp('除数为 0，无法计算除法。');
end
% 比较大小
if a > b
    fprintf('较大的数是 %g\n', a);
elseif a < b
    fprintf('较大的数是 %g\n', b);
else
    disp('两个数相等。');
end
% 求最大公约数（仅当输入为正整数时）
if all([a b] == round([a b])) && a > 0 && b > 0
    fprintf('最大公约数 gcd = %d\n', gcd(a, b));
end
