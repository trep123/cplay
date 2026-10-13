% 示例 7：正弦余弦绘图
% 演示 plot 的线型规格（LineSpec）、图例、标题、坐标轴标签和网格
x = linspace(0, 2*pi, 100);   % 0 到 2π 之间取 100 个点
y1 = sin(x);
y2 = cos(x);
y3 = sin(x) .* cos(x);
figure;
% 'r-' 红色实线，'b--' 蓝色虚线
plot(x, y1, 'r-', 'LineWidth', 2);
hold on;                       % 保持当前图形，继续叠加
plot(x, y2, 'b--', 'LineWidth', 2);
% 'g:' 绿色点线；每隔 10 个点画一个圆圈标记
plot(x, y3, 'g:');
plot(x(1:10:end), y1(1:10:end), 'ko');
hold off;
legend('sin(x)', 'cos(x)', 'sin(x)cos(x)', '采样点');
title('正弦与余弦函数');
xlabel('x（弧度）');
ylabel('函数值');
grid on;                       % 打开网格
axis([0 2*pi -1.2 1.2]);       % 设置坐标范围
% 输出几个关键点的数值
fprintf('sin(pi/2) = %.4f, cos(pi) = %.4f\n', sin(pi/2), cos(pi));
