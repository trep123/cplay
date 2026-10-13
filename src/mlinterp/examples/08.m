% 示例 8：子图画廊
% 用 subplot(2,2,k) 在一个窗口中排列 4 种常见图表
rng(42);                         % 固定随机种子，保证结果可重复
figure;
% 1. 柱状图
subplot(2, 2, 1);
sales = [23 45 31 52 38];
bar(sales);
title('柱状图：月销量');
xlabel('月份'); ylabel('销量');
% 2. 饼图
subplot(2, 2, 2);
share = [40 25 20 15];
pie(share);
title('饼图：市场份额');
% 3. 直方图：标准正态分布随机数
subplot(2, 2, 3);
r = randn(1000, 1);
histogram(r, 20);
title('直方图：randn');
% 4. 散点图
subplot(2, 2, 4);
xs = rand(1, 50);
ys = 2 * xs + 0.3 * randn(1, 50);
scatter(xs, ys, 'filled');
title('散点图'); xlabel('x'); ylabel('y');
% 打印随机样本的统计量
fprintf('randn 样本均值 = %.3f，标准差 = %.3f\n', mean(r), std(r));
