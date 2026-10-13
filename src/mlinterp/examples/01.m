% 示例 1：基础与显示
% 演示变量赋值、不加分号时的自动显示、format long 以及 fprintf 格式化输出
clear;
a = 7            % 不加分号：自动显示变量的值
b = 2.5;         % 加分号：不显示
c = a * b        % 乘法结果会被显示
name = '圆周率';
v = [1 2 3 4]    % 行向量
% 默认 format short：保留 4 位小数
p = pi
% 切换为 format long：显示更多有效数字
format long
p = pi
format short     % 恢复默认格式
% fprintf：按格式字符串输出
fprintf('a = %d, b = %.2f\n', a, b);
fprintf('%s 约等于 %.6f\n', name, pi);
fprintf('科学计数法：%e\n', 12345.678);
% fprintf 会循环使用格式，逐个输出向量元素
fprintf('元素：%d\n', v);
% disp 只显示值，不显示变量名
disp('计算完成！');
disp(c);
cls = class(c)   % 查看变量的数据类型
