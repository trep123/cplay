function [m, s] = stats(x)
% STATS 计算向量的均值和（总体）标准差
%   [m, s] = stats(x) 返回均值 m 和标准差 s
n = numel(x);
m = sum(x) / n;                 % 均值
if nargout > 1
    s = sqrt(sum((x - m).^2) / n);  % 仅在需要时计算标准差
end
end
