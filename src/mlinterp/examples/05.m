% 示例 5：元胞数组与结构体
% 元胞数组可以存放不同类型的数据；结构体用字段组织数据
c = {42, 'MATLAB', [1 2 3]; true, int8(7), @sin}
class(c{1,2})          % 用花括号取出内容
% cellfun：对每个元胞应用函数
lens = cellfun(@numel, c)
names = {'苹果', '香蕉', '樱桃'};
% UniformOutput 为 false 时返回元胞数组
tagged = cellfun(@(s) ['水果:' s], names, 'UniformOutput', false)
% 结构体数组：每个元素有相同的字段
students(1).name = '张三'; students(1).score = 88;
students(2).name = '李四'; students(2).score = 95;
students(3).name = '王五'; students(3).score = 72;
students
% fieldnames：列出所有字段名
f = fieldnames(students)
% 提取所有分数组成向量
allScores = [students.score]
[~, best] = max(allScores);
fprintf('最高分：%s（%d 分）\n', students(best).name, allScores(best));
% 用 struct 函数一次创建，并动态访问字段
p = struct('x', 1, 'y', 2);
fld = 'y';
p.(fld) = 10;
disp(p);
isfield(p, 'z')
