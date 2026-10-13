% 示例 9：三维曲面
% peaks 是 MATLAB 自带的示例函数，常用于演示三维绘图
[X, Y, Z] = peaks(40);           % 生成 40×40 的网格数据
fprintf('网格大小：%d × %d\n', size(Z, 1), size(Z, 2));
fprintf('Z 的最大值 = %.3f，最小值 = %.3f\n', max(Z(:)), min(Z(:)));
figure;
surf(X, Y, Z);                   % 绘制三维曲面
colorbar;                        % 显示颜色条
title('peaks 函数曲面');
xlabel('X'); ylabel('Y'); zlabel('Z');
view(45, 30);                    % 方位角 45°，仰角 30°
% 自己构造一个曲面：z = sin(r)/r（墨西哥帽）
[x, y] = meshgrid(-8:0.5:8);
r = sqrt(x.^2 + y.^2) + eps;     % 加 eps 避免除以 0
z = sin(r) ./ r;
figure;
surf(x, y, z);
colorbar;
title('sin(r)/r 曲面');
view(3);                         % 默认三维视角
