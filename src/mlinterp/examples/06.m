% 示例 6：函数文件与匿名函数
% stats 定义在单独的函数文件 stats.m 中，返回均值和标准差两个输出
data = [2 4 4 4 5 5 7 9];
[m, s] = stats(data);
fprintf('均值 = %.4f，标准差 = %.4f\n', m, s);
% 只接收第一个输出
onlyMean = stats([10 20 30])
% 匿名函数：@(参数) 表达式
sq = @(x) x.^2;
f = @(x, y) sqrt(x.^2 + y.^2);
sq(5)
f(3, 4)
% 匿名函数可以捕获当前工作区的变量
k = 3;
scale = @(x) k * x;
scale(7)
% arrayfun：对数组每个元素调用函数
fact = arrayfun(@(n) prod(1:n), 1:6)
% 函数句柄作为参数传递
g = @(t) exp(-t) .* cos(2*pi*t);
area = integral(g, 0, 2);
fprintf('积分结果 = %.6f\n', area);
% 用 fzero 求方程 cos(x) = x 的根
root = fzero(@(x) cos(x) - x, 0.5)
