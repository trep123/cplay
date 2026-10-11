import json
ex = []
def add(t, code, stdin=""): ex.append({"title": t, "code": code.strip("\n") + "\n", "stdin": stdin})
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
json.dump(ex, open("examples.json", "w"), ensure_ascii=False, indent=1)
print(len(ex))
