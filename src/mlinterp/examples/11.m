% 示例 11：多项式曲线拟合
% 用 polyfit 对带噪声的数据进行最小二乘多项式拟合，用 polyval 求值
rng(1);
x = 0:0.5:10;
yTrue = 0.5*x.^2 - 3*x + 2;              % 真实的二次函数
y = yTrue + 2*randn(size(x));            % 加入噪声的观测数据
% 分别用 1 次和 2 次多项式拟合
p1 = polyfit(x, y, 1);
p2 = polyfit(x, y, 2);
fprintf('一次拟合：y = %.3f x %+.3f\n', p1);
fprintf('二次拟合：y = %.3f x^2 %+.3f x %+.3f\n', p2);
% 计算拟合误差（均方根误差 RMSE）
rmse1 = sqrt(mean((polyval(p1, x) - y).^2));
rmse2 = sqrt(mean((polyval(p2, x) - y).^2));
fprintf('RMSE：一次 = %.3f，二次 = %.3f\n', rmse1, rmse2);
% 在更密的点上画出拟合曲线
xf = linspace(0, 10, 200);
figure;
plot(x, y, 'ko', 'MarkerFaceColor', 'y');   % 数据点
hold on;
plot(xf, polyval(p1, xf), 'b--', 'LineWidth', 1.5);
plot(xf, polyval(p2, xf), 'r-', 'LineWidth', 2);
hold off;
legend('观测数据', '一次拟合', '二次拟合', 'Location', 'northwest');
title('多项式曲线拟合');
xlabel('x'); ylabel('y');
grid on;
% 用二次模型预测 x = 12 处的值
pred = polyval(p2, 12)
