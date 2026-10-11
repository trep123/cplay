import json
ex = []
def add(t, code, stdin="", files=None):
    e = {"title": t, "code": code.strip("\n") + "\n", "stdin": stdin}
    if files: e["files"] = {k: v.strip("\n") + "\n" for k, v in files.items()}
    ex.append(e)
add("Hello World", r'''
#include <stdio.h>

int main(void) {
    printf("Hello, World!\n");
    printf("你好，C 语言！\n");
    return 0;
}
''')
add("斐波那契", r'''
#include <stdio.h>

/* 递归版本 */
long long fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(void) {
    printf("递归计算前 20 项：\n");
    for (int i = 0; i < 20; i++) {
        printf("%lld ", fib(i));
    }
    printf("\n\n循环计算第 90 项：\n");
    long long a = 0, b = 1;
    for (int i = 0; i < 90; i++) {
        long long t = a + b;
        a = b;
        b = t;
    }
    printf("fib(90) = %lld\n", a);
    return 0;
}
''')
add("冒泡排序", r'''
#include <stdio.h>

void bubble_sort(int a[], int n) {
    for (int i = 0; i < n - 1; i++) {
        int swapped = 0;
        for (int j = 0; j < n - 1 - i; j++) {
            if (a[j] > a[j + 1]) {
                int t = a[j];
                a[j] = a[j + 1];
                a[j + 1] = t;
                swapped = 1;
            }
        }
        if (!swapped) break;
    }
}

void print_array(const int a[], int n) {
    for (int i = 0; i < n; i++) printf("%d%c", a[i], i == n - 1 ? '\n' : ' ');
}

int main(void) {
    int nums[] = {64, 34, 25, 12, 22, 11, 90, 5};
    int n = sizeof(nums) / sizeof(nums[0]);
    printf("排序前: ");
    print_array(nums, n);
    bubble_sort(nums, n);
    printf("排序后: ");
    print_array(nums, n);
    return 0;
}
''')
add("指针与字符串", r'''
#include <stdio.h>

int my_strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (int)(p - s);
}

void reverse(char *s) {
    char *l = s, *r = s + my_strlen(s) - 1;
    while (l < r) {
        char t = *l;
        *l++ = *r;
        *r-- = t;
    }
}

int main(void) {
    char str[] = "Hello, Pointer!";
    printf("原字符串: %s\n", str);
    printf("长度: %d\n", my_strlen(str));
    reverse(str);
    printf("反转后: %s\n", str);

    int arr[5] = {10, 20, 30, 40, 50};
    int *p = arr;
    printf("通过指针遍历数组: ");
    for (int i = 0; i < 5; i++) printf("%d ", *(p + i));
    printf("\n第三个元素的地址偏移: %ld 字节\n", (long)((char *)&arr[2] - (char *)arr));
    return 0;
}
''')
add("结构体与链表", r'''
#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

Node *push_front(Node *head, int v) {
    Node *n = (Node *)malloc(sizeof(Node));
    n->value = v;
    n->next = head;
    return n;
}

Node *reverse_list(Node *head) {
    Node *prev = NULL;
    while (head) {
        Node *next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}

void print_list(const Node *head) {
    for (const Node *p = head; p != NULL; p = p->next)
        printf("%d -> ", p->value);
    printf("NULL\n");
}

int main(void) {
    Node *list = NULL;
    for (int i = 1; i <= 5; i++) list = push_front(list, i * 10);
    printf("链表:   ");
    print_list(list);
    list = reverse_list(list);
    printf("反转后: ");
    print_list(list);

    int count = 0;
    while (list) {
        Node *t = list;
        list = list->next;
        free(t);
        count++;
    }
    printf("已释放 %d 个节点\n", count);
    return 0;
}
''')
add("qsort 与函数指针", r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char name[16];
    int score;
} Student;

int by_score_desc(const void *a, const void *b) {
    const Student *x = (const Student *)a, *y = (const Student *)b;
    return y->score - x->score;
}

int by_name(const void *a, const void *b) {
    return strcmp(((const Student *)a)->name, ((const Student *)b)->name);
}

void show(const char *title, Student s[], int n) {
    printf("%s\n", title);
    for (int i = 0; i < n; i++) printf("  %-8s %3d\n", s[i].name, s[i].score);
}

int main(void) {
    Student s[] = {{"Alice", 88}, {"Bob", 95}, {"Carol", 72}, {"Dave", 95}, {"Eve", 60}};
    int n = sizeof(s) / sizeof(s[0]);
    int (*cmp)(const void *, const void *) = by_score_desc;
    qsort(s, n, sizeof(Student), cmp);
    show("按分数从高到低:", s, n);
    qsort(s, n, sizeof(Student), by_name);
    show("按名字排序:", s, n);
    return 0;
}
''')
add("读取输入", r'''
#include <stdio.h>

int main(void) {
    int a, b;
    printf("请输入两个整数（在“输入”面板中填写）：\n");
    if (scanf("%d %d", &a, &b) != 2) {
        printf("输入格式错误\n");
        return 1;
    }
    printf("%d + %d = %d\n", a, b, a + b);
    printf("%d * %d = %d\n", a, b, a * b);
    return 0;
}
''', "3 5")
add("九九乘法表", r'''
#include <stdio.h>

int main(void) {
    for (int i = 1; i <= 9; i++) {
        for (int j = 1; j <= i; j++) {
            printf("%dx%d=%-4d", j, i, i * j);
        }
        printf("\n");
    }
    return 0;
}
''')
add("素数筛", r'''
#include <stdio.h>
#include <stdbool.h>

#define N 100

int main(void) {
    bool is_prime[N + 1];
    for (int i = 0; i <= N; i++) is_prime[i] = true;
    is_prime[0] = is_prime[1] = false;
    for (int i = 2; i * i <= N; i++) {
        if (is_prime[i]) {
            for (int j = i * i; j <= N; j += i) is_prime[j] = false;
        }
    }
    int count = 0;
    printf("%d 以内的素数：\n", N);
    for (int i = 2; i <= N; i++) {
        if (is_prime[i]) {
            printf("%4d", i);
            if (++count % 10 == 0) printf("\n");
        }
    }
    printf("\n共 %d 个\n", count);
    return 0;
}
''')
add("数学函数", r'''
#include <stdio.h>
#include <math.h>

int main(void) {
    double x = 2.0;
    printf("sqrt(%.1f)   = %.4f\n", x, sqrt(x));
    printf("pow(2, 10)   = %.0f\n", pow(2, 10));
    printf("sin(PI/6)    = %.4f\n", sin(M_PI / 6));
    printf("cos(PI/3)    = %.4f\n", cos(M_PI / 3));
    printf("log(e)       = %.4f\n", log(M_E));
    printf("floor(-2.5)  = %.1f\n", floor(-2.5));
    printf("ceil(-2.5)   = %.1f\n", ceil(-2.5));
    printf("fabs(-3.75)  = %.2f\n", fabs(-3.75));
    printf("圆周率约为   %.10f\n", 4 * atan(1.0));
    return 0;
}
''')
add("goto 统一清理", r"""
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 经典写法：出错时用 goto 跳到统一的清理代码，按相反顺序释放资源 */
int process(int n, int fail_at) {
    int ret = -1;
    int *nums = NULL;
    char *buf = NULL;

    nums = malloc(n * sizeof(int));
    if (nums == NULL || fail_at == 1) {
        printf("  第 1 步失败\n");
        goto cleanup_nums;
    }
    for (int i = 0; i < n; i++) nums[i] = i * i;

    buf = malloc(64);
    if (buf == NULL || fail_at == 2) {
        printf("  第 2 步失败\n");
        goto cleanup_buf;
    }
    int sum = 0;
    for (int i = 0; i < n; i++) sum += nums[i];
    sprintf(buf, "平方和 = %d", sum);
    printf("  成功：%s\n", buf);
    ret = 0;

cleanup_buf:
    free(buf);
cleanup_nums:
    free(nums);
    printf("  已释放资源，返回 %d\n", ret);
    return ret;
}

int main(void) {
    for (int f = 0; f <= 2; f++) {
        printf("fail_at = %d:\n", f);
        process(5, f);
    }

    /* goto 也能一次跳出多层循环 */
    int i, j;
    for (i = 1; i <= 9; i++)
        for (j = 1; j <= 9; j++)
            if (i * j == 42) goto found;
    printf("没有找到\n");
    return 0;
found:
    printf("找到 %d x %d = 42\n", i, j);
    return 0;
}
""")
add("位域结构体", r"""
#include <stdio.h>

/* 用位域把多个小字段压缩进一个 16 位整数 */
struct Date {
    unsigned short day   : 5;   /* 1..31 */
    unsigned short month : 4;   /* 1..12 */
    unsigned short year  : 7;   /* 2000 年起的偏移 0..127 */
};

struct Flags {
    unsigned char readable   : 1;
    unsigned char writable   : 1;
    unsigned char executable : 1;
    signed   char level      : 3;  /* 有符号：-4..3 */
};

int main(void) {
    struct Date d = { .day = 12, .month = 10, .year = 26 };
    printf("日期：%u-%02u-%02u\n", 2000 + d.year, d.month, d.day);
    printf("sizeof(struct Date)  = %zu 字节\n", sizeof(struct Date));

    unsigned short raw = *(unsigned short *)&d;
    printf("内存中的位模式：0x%04x\n", raw);

    struct Flags f = {1, 0, 1, -2};
    printf("rwx = %d%d%d, level = %d\n", f.readable, f.writable, f.executable, f.level);
    f.level = 3;
    f.level++;          /* 3 位有符号数溢出：3 + 1 -> -4 */
    printf("level 加一后 = %d\n", f.level);
    d.day = 40;         /* 只保留低 5 位：40 -> 8 */
    printf("day 写入 40 后 = %u\n", d.day);
    printf("sizeof(struct Flags) = %zu 字节\n", sizeof(struct Flags));
    return 0;
}
""")
add("变长数组矩阵", r"""
#include <stdio.h>

/* C99 变长数组（VLA）：数组大小在运行时决定，也可以作为函数参数 */
void fill(int r, int c, int m[r][c]) {
    for (int i = 0; i < r; i++)
        for (int j = 0; j < c; j++)
            m[i][j] = (i + 1) * (j + 1);
}

void multiply(int n, int k, int m, int a[n][k], int b[k][m], int out[n][m]) {
    for (int i = 0; i < n; i++)
        for (int j = 0; j < m; j++) {
            out[i][j] = 0;
            for (int t = 0; t < k; t++) out[i][j] += a[i][t] * b[t][j];
        }
}

void print(int r, int c, int m[r][c]) {
    for (int i = 0; i < r; i++) {
        for (int j = 0; j < c; j++) printf("%5d", m[i][j]);
        printf("\n");
    }
}

int main(void) {
    int n, k, m;
    scanf("%d %d %d", &n, &k, &m);
    int a[n][k], b[k][m], c[n][m];
    fill(n, k, a);
    fill(k, m, b);
    multiply(n, k, m, a, b, c);
    printf("A (%d x %d):\n", n, k); print(n, k, a);
    printf("B (%d x %d):\n", k, m); print(k, m, b);
    printf("A x B:\n");             print(n, m, c);
    printf("sizeof(c) = %zu 字节, 每行 %zu 字节\n", sizeof(c), sizeof(c[0]));
    return 0;
}
""", "2 3 4\n")
add("多文件：头文件与模块", r"""
#include <stdio.h>
#include "stack.h"

/* 多文件示例：点上方的 stack.h / stack.c 标签查看另外两个文件 */
int main(void) {
    Stack s;
    stack_init(&s);
    for (int i = 1; i <= 5; i++) stack_push(&s, i * i);
    printf("栈里有 %d 个元素，栈顶是 %d\n", stack_size(&s), stack_peek(&s));
    while (!stack_empty(&s)) printf("%d ", stack_pop(&s));
    printf("\n累计 push 次数：%d\n", push_count);
    return 0;
}
""", files={"stack.h": r"""
#ifndef STACK_H
#define STACK_H

#include <stdbool.h>

#define STACK_CAP 16

typedef struct {
    int data[STACK_CAP];
    int top;
} Stack;

extern int push_count;   /* 定义在 stack.c 中 */

void stack_init(Stack *s);
void stack_push(Stack *s, int v);
int  stack_pop(Stack *s);
int  stack_peek(const Stack *s);
int  stack_size(const Stack *s);
bool stack_empty(const Stack *s);

#endif
""", "stack.c": r"""
#include <stdio.h>
#include <stdlib.h>
#include "stack.h"

int push_count = 0;

/* static 函数只在本文件内可见 */
static void check(bool ok, const char *msg) {
    if (!ok) {
        fprintf(stderr, "栈错误：%s\n", msg);
        exit(1);
    }
}

void stack_init(Stack *s) { s->top = 0; }

void stack_push(Stack *s, int v) {
    check(s->top < STACK_CAP, "栈已满");
    s->data[s->top++] = v;
    push_count++;
}

int stack_pop(Stack *s) {
    check(s->top > 0, "栈为空");
    return s->data[--s->top];
}

int stack_peek(const Stack *s) { check(s->top > 0, "栈为空"); return s->data[s->top - 1]; }
int stack_size(const Stack *s) { return s->top; }
bool stack_empty(const Stack *s) { return s->top == 0; }
"""})
json.dump(ex, open("examples.json", "w"), ensure_ascii=False, indent=1)
print(len(ex))
