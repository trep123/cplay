% 示例 10：常微分方程 ode45
% 阻尼振动方程：x'' + 2*zeta*w*x' + w^2*x = 0
% 改写为一阶方程组：y1 = x, y2 = x'
w = 2*pi;        % 固有角频率
zeta = 0.1;      % 阻尼比
odefun = @(t, y) [y(2); -2*zeta*w*y(2) - w^2*y(1)];
tspan = [0 5];   % 时间区间
y0 = [1; 0];     % 初始位移 1，初始速度 0
[t, y] = ode45(odefun, tspan, y0);
fprintf('求解步数：%d\n', numel(t));
fprintf('t = 5 时位移 = %.4f\n', y(end, 1));
% 与解析包络 exp(-zeta*w*t) 比较
env = exp(-zeta * w * t);
figure;
plot(t, y(:,1), 'b-', 'LineWidth', 1.5);
hold on;
plot(t, env, 'r--', t, -env, 'r--');
hold off;
legend('位移 x(t)', '包络线');
title('阻尼振动（ode45 数值解）');
xlabel('时间 t (s)'); ylabel('位移');
grid on;
% 相平面图：速度对位移
figure;
plot(y(:,1), y(:,2), 'm');
title('相平面轨迹'); xlabel('x'); ylabel('dx/dt');
grid on;
