% 示例 3：逻辑索引与查找
% 演示逻辑掩码、find、any/all 的用法
scores = [78 92 55 88 61 47 95 70]
% 逻辑掩码：比较运算得到 logical 数组
pass = scores >= 60
% 用逻辑掩码直接取出及格的分数
passedScores = scores(pass)
% find 返回满足条件的元素下标
failIdx = find(scores < 60)
% 找出第一个 90 分以上的位置
firstTop = find(scores > 90, 1)
% 组合条件：& 表示“与”，| 表示“或”
mid = scores(scores >= 70 & scores < 90)
% any：是否存在；all：是否全部满足
hasFail = any(scores < 60)
allPositive = all(scores > 0)
% 逻辑索引赋值：把不及格的分数统一改为 60
fixed = scores;
fixed(fixed < 60) = 60
% 统计个数：对逻辑数组求和
nPass = sum(pass);
fprintf('及格人数：%d / %d\n', nPass, numel(scores));
% 矩阵中查找：返回行、列下标
M = magic(4);
[r, c] = find(M > 13);
disp([r c]);
