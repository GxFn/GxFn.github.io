---
author: Gao Xuefeng
pubDatetime: 2026-04-14T10:00:00+08:00
title: iOS 多线程：那些看起来对、跑起来错的代码
slug: ios-multithreading-oc-swift
featured: true
draft: false
tags:
  - iOS
  - Objective-C
  - Swift
  - 多线程
  - 底层原理
description: 不讲 API 怎么调，讲为什么会死锁、为什么数据竞争、为什么自旋锁被废弃、为什么 Actor 不等于串行队列。从 GCD 到 Swift Concurrency，把每个容易写错的地方拆到指令级别。
---

多线程的 API 很简单，`dispatch_async` 写一百遍也不会写错。但面试官不问 API，问的是"这段代码输出什么"、"为什么死锁"、"换成并发队列呢"。这些问题的答案藏在 API 下面一层。

这篇不讲基础用法。讲的是那些看起来对、跑起来错的代码，以及错在哪里。但在拆错误之前，需要先搞清楚 GCD 到底是怎么运转的。不理解底层的角色分工，后面所有的死锁、竞争、barrier 失效都只是死记硬背。

## GCD 的内部机器：谁在做什么

调用 `dispatch_async(queue, block)` 之后发生了什么？直觉是"把任务丢到队列里，系统找个线程来跑"。大方向没错，但"系统"这两个字藏了三层角色。

### 三层架构

```
┌─────────────────────────────────────────────────┐
│  你的代码                                        │
│  dispatch_async(queue, block)                    │
└──────────────────────┬──────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│  libdispatch（用户态，开源）                       │
│  队列管理 / 任务入队 / drain 循环 / 线程池管理      │
└──────────────────────┬───────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│  XNU 内核（workqueue / pthread）                  │
│  线程创建与回收 / 优先级调度 / CPU 核心分配          │
└──────────────────────────────────────────────────┘
```

**libdispatch** 是 GCD 的用户态实现，Apple 开源的（`apple/swift-corelibs-libdispatch`）。队列、任务入队、drain 循环、线程复用全在这里。

**XNU 内核** 负责底层线程的生死。libdispatch 不直接调 `pthread_create`，而是通过 `workq_kernreturn` 系统调用向内核申请或归还工作线程。内核根据当前 CPU 负载决定是给你一个线程、还是让你排队等。

**你的代码** 只接触队列和 block，完全不感知线程。这是 GCD 的核心设计：把线程管理的决策权从开发者手里拿走，交给 libdispatch 和内核。

### 一次 dispatch_async 的完整旅程

```
1. 你调用 dispatch_async(queue, block)
   │
   ↓
2. libdispatch 把 block 包装成 dispatch_continuation_t（任务对象），
   入队到 queue 内部的任务链表（FIFO）
   │
   ↓
3. libdispatch 检查：当前是否已经有线程在 drain 这个队列？
   │
   │  （队列本身只是一个任务链表，它不会"跑"。但 libdispatch 会记录
   │   "有没有线程正在从这个链表里取任务执行"这个状态。
   │   这个状态存在队列的原子标志位 dq_state 里。）
   │
   ├── 已经有线程在 drain → 什么都不做。
   │   那个线程的 drain 循环跑完当前 block 后，
   │   会自动从链表头部取下一个，自然会取到刚入队的新任务。
   │
   └── 没有线程在 drain → 需要找一个线程来启动 drain。
       libdispatch 向内核发起请求。
       │
       ↓
4. 内核的 workqueue 子系统收到请求
   │
   ├── 线程池有空闲线程 → 唤醒一个，分配给 libdispatch
   │
   ├── 线程池没有空闲的，但 CPU 没满载
   │   → 创建新的 pthread，加入线程池，分配给 libdispatch
   │
   └── CPU 已满载（活跃线程数 ≥ CPU 核心数）
       → 排队等待，不创建新线程（防止线程爆炸）
       │
       ↓
5. 工作线程拿到执行权，进入 libdispatch 的 drain 循环
   │
   ↓
6. drain 循环从链表头部取出任务 → 执行 block → 取下一个 → 执行 …
   │
   ├── 串行队列：同一时刻只有一个线程在 drain，取一个执行完才取下一个
   │
   └── 并发队列：libdispatch 让多个线程同时 drain，每个线程各取各的
       │
       ↓
7. 队列为空 → drain 循环结束 → 线程归还给内核线程池
   （不销毁，等下次复用；空闲太久内核才会回收）
```

几个关键决策点：

**谁决定开不开新线程？** 内核。libdispatch 只负责说"我需要一个线程"，内核根据 CPU 负载决定是给还是不给。这就是为什么 GCD 不会无限制创建线程——内核有全局视角。

**谁决定任务的执行顺序？** 队列的类型。串行队列同一时刻只有一个线程在 drain——取一个执行完才取下一个，严格 FIFO。并发队列允许多个线程同时 drain，各取各的，所以 block 之间的完成顺序不确定。

**谁决定 block 在哪个线程跑？** libdispatch。它从内核拿到工作线程后，在该线程上执行 drain 循环。你无法也不应该假设 block 在哪个具体线程上执行（主队列除外——它永远绑定线程 1）。

### 队列不是线程

这是最常见的误解。队列是个**任务链表 + 调度策略**，不拥有任何线程。

```
串行队列 ──→ [block A] → [block B] → [block C]
                ↑
              内核分配的某个工作线程，一个一个取着跑

并发队列 ──→ [block A] → [block B] → [block C] → [block D]
                ↑              ↑
              线程 3          线程 5    ← 多个线程同时取
```

串行队列不是"只有一个线程的队列"。它是"同一时刻只有一个线程在 drain 的队列"。两次 `dispatch_async` 到同一个串行队列，block A 和 block B 实际执行的线程可能不同——A 执行完线程归还了，B 被分配到另一个线程。但 B 一定在 A 之后执行。

并发队列也不等于"有多个线程的队列"。它允许同时被多个线程 drain，但具体有几个线程由内核决定。CPU 忙的时候可能只给你一个线程，这时并发队列的行为跟串行队列一样。

### sync 的本质：一条完全不同的路

`dispatch_sync` 不走 async 那条路。不请求内核，不经过线程池，不创建新线程。把它的旅程也画出来：

```
dispatch_sync(queue, block) 在主线程调用：

1. libdispatch 把 block 包装成任务对象，入队到 queue 的任务链表
   │
   ↓
2. libdispatch 检查 queue 类型，决定怎么执行这个 block：
   │
   ├── 并发队列 → 当前线程直接执行 block，执行完 sync 返回。结束。
   │   （并发队列允许多个线程同时从它的链表取任务，
   │    所以当前线程可以"自己动手"，不用排队。）
   │
   └── 串行队列 → 当前线程不能直接执行。
       │
       │  原因：串行队列的规则是"同一时刻只有一个线程在从链表取任务执行"。
       │  如果已经有线程 T 在 drain 这个队列（正在执行链表里的某个任务），
       │  当前线程不能插队，必须等线程 T 把前面的任务都跑完、轮到这个 block、
       │  执行完这个 block 之后，sync 才能返回。
       │
       ↓
3. 当前线程被阻塞，等待的是：
   "正在 drain 这个串行队列的那个线程把 block 执行完"
   │
   ↓
4. 问题来了——谁在 drain 这个串行队列？
   │
   ├── 如果是**另一个线程** → 没问题。那个线程继续 drain，
   │   轮到这个 block 时执行它，执行完后通知当前线程，sync 返回。
   │
   └── 如果就是**当前线程自己** → 💀
       当前线程在步骤 3 被阻塞了，而 drain 循环跑在这个线程上，
       drain 无法推进 → block 永远不被取出执行 →
       步骤 3 永远等不到完成信号 → 死锁
```

关键区别：**async 在步骤 1 之后就返回了**，调用方继续往下跑，block 交给其他线程执行。**sync 在步骤 1 之后不返回**，它阻塞当前线程，等 block 被执行完才继续。

步骤 4 就是死锁的判定规则：**sync 阻塞的线程，是不是正在 drain 这个串行队列的线程？** 如果是同一个线程——drain 循环跑在这个线程上，线程被阻塞后 drain 无法推进，死锁。如果是不同线程——那个线程继续 drain，轮到这个 block 时执行它，正常返回。并发队列走步骤 2 的并发分支，当前线程直接执行 block，没有"等"的环节，不死锁。

### 为什么 sync 不直接在当前线程执行 block

一个自然的疑问：libdispatch 知道当前线程就是 drain 主队列的线程，为什么不让它直接执行 block，而是傻等到死锁？

因为**串行队列的 FIFO 保证**。假设主队列链表当前状态：

```
主队列链表: [block A] → [block B] → …

RunLoop 正在执行 task X（你的代码），task X 里调用了 dispatch_sync(mainQueue, block Y)

入队后: [block A] → [block B] → [block Y]
```

如果 libdispatch 让主线程绕过链表直接执行 Y，那 Y 就插队到了 A、B 前面——**破坏了 FIFO**。串行队列唯一的承诺就是"先入先出、不重叠执行"，sync 不能为了避免死锁而违反这个承诺。

更深一层：task X 还没执行完（它卡在 `dispatch_sync` 这行），如果此时执行 Y，X 和 Y 会**同时存在于主线程的调用栈上**——X 没结束 Y 就开始了，这在语义上等于"重叠执行"，同样违反串行队列的规则。

实际上 `dispatch_sync` 的阻塞发生在函数体内部（底层是 `_dispatch_sync_wait`，线程直接被挂起）。调用线程连 `dispatch_sync` 这个函数都返回不了，更不可能回到上层 RunLoop 去取 block。用调用栈画出来：

```
主线程调用栈（从底到顶）：

┌─ main()
├─ UIApplicationMain()
├─ CFRunLoopRunSpecific()      ← RunLoop 迭代（drain 主队列）
├─ task X（你的代码）
├─ dispatch_sync(mainQueue, Y)
└─ _dispatch_sync_wait()       ← 线程挂起。谁来执行 Y？
                                  只有主线程回到 RunLoop 才能从链表取到 Y。
                                  但主线程被困在这一层，回不去。
```

而并发队列不保证 FIFO、允许重叠执行，所以 libdispatch 走快速路径：直接在当前线程的调用栈上执行 block，执行完 sync 返回。不入队、不等待、不死锁。

### 线程池的上限

内核的 workqueue 对每个进程有线程上限，通常是 **64 个工作线程**（不含主线程和其他非 GCD 线程）。但更关键的限制是**活跃线程数不超过 CPU 核心数**。超出的线程会被挂起等待。

这就是为什么不应该用 `dispatch_sync` 阻塞大量并发任务——每个被阻塞的线程依然占着名额，但不做事。如果 64 个线程全被阻塞在 sync 等待上，整个 GCD 线程池就瘫痪了，后续所有 dispatch 的 block 都无法执行。这叫**线程饥饿（Thread Starvation）**。

### 全局队列 vs 自建队列

`dispatch_get_global_queue` 返回的是系统预创建的共享并发队列（4 个优先级各一个，加上一个 overcommit 版本共 8 个）。所有用它的代码共享同一个队列。

自建队列（`dispatch_queue_create`）是你独占的。这意味着：

- **barrier 只对自建并发队列有效**——因为 barrier 会暂停其他线程对该队列的 drain，独占执行。如果在全局队列上生效，就会阻止系统里所有使用该全局队列的线程取任务执行，Apple 不允许这种事。
- **自建串行队列是轻量的"锁"**——它保证入队任务 FIFO 且互斥执行，其实就是一个无竞争的互斥锁。libdispatch 内部对串行队列做了大量优化（如 thread-bound 快速路径），性能非常好。

### 目标队列（Target Queue）

每个队列都有一个 target queue。默认情况下，自建队列的 target 是全局队列之一（根据 QoS 选择）。

```
你的串行队列 → target → global queue (default priority)
                                ↓
                          内核 workqueue
```

target queue 决定两件事：
1. **优先级继承**：你的队列的 QoS 从 target queue 继承
2. **最终执行出口**：libdispatch 最终通过 target queue 向内核请求工作线程来执行任务

你可以把多个串行队列的 target 设为同一个串行队列，实现**队列层级**——最终所有任务汇入同一个串行出口，等价于一个全局互斥锁。libdispatch 内部大量使用这种模式。

理解了这些底层角色和决策链路，后面的死锁、竞争、barrier 失效就不再需要死记，可以从原理推导出来。

## 死锁：串行队列的陷阱

用上面的规则直接套代码。主队列：

```objectivec
// 主线程执行 → 死锁
dispatch_sync(dispatch_get_main_queue(), ^{
    NSLog(@"永远不会执行");
});
```

主线程正在 drain 主队列（RunLoop 的每次迭代就是一次 drain），`dispatch_sync` 阻塞的也是主线程——同一个线程，死锁。

推广到自建串行队列：

```objectivec
dispatch_queue_t queue = dispatch_queue_create("serial", DISPATCH_QUEUE_SERIAL);

dispatch_async(queue, ^{
    NSLog(@"1");
    dispatch_sync(queue, ^{  // 💀 死锁
        NSLog(@"2");
    });
    NSLog(@"3");
});
```

输出 `1`，然后卡死。执行外层 block 的工作线程 T 正在 drain 这个串行队列，`dispatch_sync` 阻塞的也是线程 T——同一个线程，死锁。跟是不是主队列没关系，任何串行队列都一样。

换成并发队列就不会：

```objectivec
dispatch_queue_t queue = dispatch_queue_create("concurrent", DISPATCH_QUEUE_CONCURRENT);

dispatch_async(queue, ^{
    NSLog(@"1");
    dispatch_sync(queue, ^{
        NSLog(@"2");  // ✅ 正常执行
    });
    NSLog(@"3");
});
// 输出：1、2、3
```

并发队列走 sync 步骤 2 的并发分支——当前线程直接执行 block，没有"等"的环节，不死锁。

还有一个容易忽略的死锁——`dispatch_once` 递归：

```objectivec
+ (instancetype)shared {
    static MyClass *instance;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[MyClass alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    MyClass *obj = [MyClass shared]; // 💀 递归进入 dispatch_once → 死锁
    return self;
}
```

`dispatch_once` 底层用锁保证只执行一次。第一次调用锁住了，init 里再次调用同一个 token，等锁释放，但锁的持有者在等 init 完成——自锁。

**死锁判断的核心规则**：串行队列 sync 自身 = 必死。`dispatch_once` 递归 = 必死。并发队列 sync 自身 = 不死。sync 不同队列 = 不死。

## 数据竞争：比死锁更危险，因为它不崩溃

```objectivec
__block int num = 0;
for (int i = 0; i < 5; i++) {
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
        num++;
    });
}
NSLog(@"%d", num);
```

这题的答案是 **0 到 5 之间的任意值**，不确定。有两层原因：

**第一层：时序问题。** `dispatch_async` 不等 block 完成就返回，`NSLog` 执行时大概率一个 block 都没跑完。这层问题用 `dispatch_group` 可以解决。

**第二层：即使等所有 block 完成，结果也可能小于 5。** 这才是危险的。

`num++` 看起来是一行代码，实际是三条 CPU 指令：

```
LOAD  — 读取 num 的值到寄存器
ADD   — 寄存器 +1
STORE — 写回内存
```

两个线程同时执行 `num++`：

```
线程 A              线程 B
──────              ──────
LOAD num → 0
                    LOAD num → 0     ← 也读到 0
ADD → 1
                    ADD → 1
STORE num = 1
                    STORE num = 1    ← 覆盖了 A 的结果
```

两次 `++`，结果是 1 而不是 2。这叫**丢失更新（Lost Update）**。

要得到确定的 5，需要**同时**解决两个问题：

```objectivec
__block int num = 0;
dispatch_group_t group = dispatch_group_create();
for (int i = 0; i < 5; i++) {
    dispatch_group_async(group, dispatch_get_global_queue(0, 0), ^{
        @synchronized (self) {   // 解决原子性
            num++;
        }
    });
}
dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSLog(@"%d", num);  // 解决时序 → 确定是 5
});
```

group 管时序（读一定在所有写之后），锁管原子性（每次 `num++` 不被打断）。**两个解决的是不同层面的问题，少任何一个都不行。**

## `__block` 底层：为什么 block 内外能共享变量

```objectivec
__block int num = 0;
```

编译后 `num` 被包装成结构体：

```c
struct __Block_byref_num {
    void *__isa;
    __Block_byref_num *__forwarding;  // 关键
    int __flags;
    int __size;
    int num;  // 真正的值
};
```

精妙在 `__forwarding` 指针。block 从栈 copy 到堆时，栈上的旧结构体的 `__forwarding` 会指向堆上的新结构体。所有人通过 `__forwarding->num` 读写，保证无论栈还是堆，访问的都是同一份数据。

不加 `__block` 呢？block 创建时直接**值拷贝**当前值到 block 结构体里，且 block 内不能修改（编译报错）。这就是面试总问"去掉 `__block` 会怎样"的原因——两种捕获是完全不同的内存模型。

## 锁的选型：不是越快越好

iOS 的锁按性能排序：

```
os_unfair_lock > dispatch_semaphore > pthread_mutex > NSLock > NSRecursiveLock > @synchronized
```

但选锁不能只看性能。

### OSSpinLock 为什么被废弃

自旋锁等待时不休眠，CPU 空转。如果持有锁的低优先级线程因为 CPU 时间片被高优先级的自旋线程抢走而无法释放锁，高优先级线程会永远自旋——**优先级反转（Priority Inversion）**。

这不是理论问题。iOS 的 QoS（Quality of Service）有多个优先级等级，主线程是 User Interactive，后台线程可能是 Utility。混用时触发优先级反转的概率不低。

`os_unfair_lock` 解决了这个问题：等待时线程休眠，由内核唤醒，不自旋。名字里的 "unfair" 是说不保证 FIFO 获取锁的顺序（后来的线程可能先获锁），换来的是更好的性能。

### @synchronized 的真面目

```objectivec
@synchronized (obj) {
    // 临界区
}
```

底层维护了一张全局哈希表 `SyncData`，以 `obj` 的内存地址为 key 映射到一个递归互斥锁（`recursive_mutex_t`）。所以：

- 它是**递归锁**，同一线程可重入 → 不会自锁
- 不同的 `obj` 映射到不同的锁 → 不互斥
- `obj` 为 `nil` → 查表返回空 → **不加锁** → 线程不安全
- 慢在哈希查找 + `objc_sync_enter` / `objc_sync_exit` 的异常处理开销

第三点是最常见的 bug：`@synchronized(self.delegate)` 如果 delegate 为 nil，临界区就裸奔了。

### 实际怎么选

| 场景 | 选择 | 原因 |
|------|------|------|
| 简单计数器/标志位 | `os_unfair_lock` | 最轻量，无竞争时接近零开销 |
| 读多写少的容器 | GCD concurrent + barrier | 多读并发，写时独占 |
| 需要递归加锁 | `NSRecursiveLock` | 同一线程可重入 |
| 遗留 OC 代码快速加锁 | `@synchronized` | 不追求性能时最安全（自动配对） |
| Swift 6 项目 | `OSAllocatedUnfairLock` / Actor | 编译器级别保证 |

## GCD barrier 的一个坑

```objectivec
dispatch_barrier_async(dispatch_get_global_queue(0, 0), ^{
    NSLog(@"write");
});
```

**barrier 对 `global_queue` 无效。** 退化为普通 `dispatch_async`。

原因：`global_queue` 是系统共享的全局并发队列，如果 barrier 能在这里生效，意味着它可以阻塞系统里**所有使用这个队列的代码**。Apple 不允许这种事发生。

barrier 只对你自己创建的 `DISPATCH_QUEUE_CONCURRENT` 有效。面试里写多读单写如果用了 `global_queue` 配 barrier，直接扣分。

## performSelector 与 RunLoop 的隐匿关系

同样是 `performSelector`，有的依赖 RunLoop，有的不依赖：

| 方法 | 底层 | 需要 RunLoop |
|------|------|-------------|
| `performSelector:withObject:` | `objc_msgSend` 直接调用 | 不需要 |
| `performSelector:withObject:afterDelay:` | RunLoop Timer | 需要 |
| `performSelector:onThread:withObject:waitUntilDone:` | RunLoop Source | 需要（目标线程） |

```objectivec
dispatch_async(dispatch_get_global_queue(0, 0), ^{
    [self performSelector:@selector(test) withObject:nil afterDelay:0];
});
```

什么都不输出。`afterDelay:` 往当前线程 RunLoop 注册了一个 Timer，但 GCD 子线程默认没有 RunLoop——Timer 注册了，没人去检查它。线程跑完 block 就回收了。

更危险的场景：

```objectivec
NSThread *thread = [[NSThread alloc] initWithTarget:self
                                           selector:@selector(bgTask) object:nil];
[thread start];
[self performSelector:@selector(test) onThread:thread withObject:nil waitUntilDone:NO];
```

如果 `bgTask` 执行完线程退出了，`performSelector:onThread:` 投递到一个已死亡的线程 → 崩溃。这就是线程保活存在的原因——不是为了炫技，是因为 `performSelector:onThread:` 需要目标线程活着且 RunLoop 在跑。

## RunLoop 与卡顿监控：从原理到生产

RunLoop 最重要的生产应用不是线程保活，而是**卡顿监控**。理解原理需要知道 RunLoop 一次迭代的状态机：

```
kCFRunLoopEntry
  ↓
kCFRunLoopBeforeTimers
  ↓
kCFRunLoopBeforeSources
  ↓
── 处理 Source0（触摸事件、performSelector）──
  ↓
kCFRunLoopBeforeWaiting  ← 即将休眠
  ↓
── mach_msg 休眠等待唤醒 ──
  ↓
kCFRunLoopAfterWaiting   ← 被唤醒
  ↓
── 处理唤醒事件（Timer / Source1 / GCD dispatch_main_queue）──
  ↓
回到开头循环，或 kCFRunLoopExit
```

**卡顿的本质**：主线程 RunLoop 某次迭代从 `BeforeSources` 到 `BeforeWaiting`（或从 `AfterWaiting` 到下一轮）耗时过长。用户感知为界面冻结。

监控原理：在子线程用信号量定时探测主线程 RunLoop 的状态变化。如果超过阈值（通常 50ms）没有变化，说明卡在了某个阶段。

```objectivec
// RunLoop Observer 回调（主线程执行）
CFRunLoopObserverRef observer = CFRunLoopObserverCreateWithHandler(
    NULL, kCFRunLoopAllActivities, YES, 0,
    ^(CFRunLoopObserverRef observer, CFRunLoopActivity activity) {
        self.currentActivity = activity;
        dispatch_semaphore_signal(self.semaphore);  // 每次状态变化发信号
    });
CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);

// 子线程轮询
dispatch_async(dispatch_get_global_queue(0, 0), ^{
    while (YES) {
        long result = dispatch_semaphore_wait(self.semaphore,
            dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC));

        if (result != 0) {
            // 超时！主线程 50ms 内没有状态变化
            if (self.currentActivity == kCFRunLoopBeforeSources ||
                self.currentActivity == kCFRunLoopAfterWaiting) {
                // 正处于"处理事件"阶段 → 卡住了
                [self dumpMainThreadCallStack]; // backtrace 或 PLCrashReporter
            }
        }
    }
});
```

为什么用子线程探测而不是在 Observer 回调里计时？**因为主线程检测不了自己是不是卡了。** 主线程卡住时 Observer 回调也不会触发，必须从外部观察。

为什么阈值是 50ms 而不是 16.67ms（一帧）？偶尔掉一帧用户无感，50ms 约等于连掉 3 帧，开始可感知。生产中通常 50~100ms。

线上完整链路：检测卡顿 → `backtrace()` 抓主线程栈帧 → 上报后台 → dSYM 符号化 → 按调用栈聚合 → 影响用户数排序 → 修复 Top N。

### NSTimer 的 Mode 问题

```objectivec
NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1
                                                  target:self
                                                selector:@selector(fire)
                                                userInfo:nil
                                                 repeats:YES];
```

滑动 `UIScrollView` 时 timer 停了。因为 `scheduledTimerWithTimeInterval` 默认添加到 `NSDefaultRunLoopMode`，滑动时 RunLoop 切换到 `UITrackingRunLoopMode`，Default Mode 的 Timer 不被检查。

修复：加到 `NSRunLoopCommonModes`（包含 Default + Tracking）。或者用 GCD Timer——它基于内核 dispatch_source，完全不依赖 RunLoop，不受 Mode 切换影响，精度也更高。

## Swift Concurrency 的深水区

`async/await` 和 `TaskGroup` 的基础用法这里不重复了，讲几个容易误解的地方。

### 两个世界：阻塞线程 vs 挂起任务

GCD 和 Swift Concurrency 最根本的区别不在语法，在**谁被暂停**。

**GCD 暂停的是线程。** `dispatch_sync` 等待时，调用线程被内核挂起（`_dispatch_sync_wait` → 线程休眠），占着线程池名额但不干活。64 个线程全被阻塞 → 线程饥饿 → 整个 GCD 瘫痪。

**Swift Concurrency 暂停的是任务。** `await` 时，当前任务的执行状态（局部变量、执行到哪一行）被打包成一个 continuation 对象保存到堆上，线程被释放去执行其他就绪的任务。没有任何线程被阻塞。

```
GCD:
线程3 执行 block A → 需要等数据 → dispatch_sync 阻塞 → 线程3 休眠（占坑不干活）
                                                        等数据回来 → 线程3 被唤醒 → 继续

Swift Concurrency:
线程3 执行 task A → 遇到 await → task A 的状态保存到堆上 → 线程3 被释放
线程3 去执行 task C（或任何就绪的任务）
…
数据回来 → task A 变为"就绪"→ 某个空闲线程（可能是线程3，也可能是线程5）恢复 task A
```

这就是为什么 Swift Concurrency 的线程池可以只用 CPU 核心数个线程（cooperative thread pool），而 GCD 需要 64 个——GCD 的线程会被阻塞调用"浪费"掉，Swift Concurrency 的线程永远在干活。

### GCD 的 block 绑定线程，Swift 的 task 不绑定

**GCD：一个 block 从头到尾在同一个线程上执行。** block 开始时在线程3，结束时一定还在线程3。线程不会中途被抢走。但同一个串行队列的不同 block 可能跑在不同线程上——A 执行完线程归还了，B 被分配到另一个线程。

```
GCD 串行队列:
  线程3: [====block A====]                   [block C]
  线程5:                   [====block B====]

  A、B、C 严格 FIFO，但承载它们的线程可能不同。
  每个 block 内部不会换线程。
```

**Swift Concurrency：一个 task 在 `await` 前后可以在不同线程上执行。** 编译器把 async 函数在每个 `await` 处切割成多段（称为 partial function），每段是一个独立的可调度单元。挂起时保存状态，恢复时由线程池里任意一个空闲线程接手。

```
Swift Concurrency:
  线程1: [task A 前半]          [task C]      [task A 后半]
  线程2:              [task B 前半]   [task B 后半]
                ↑                ↑
              await            await

  task A 的前半段在线程1，后半段也可能在线程1（碰巧空闲），
  也可能在线程2（线程1忙着干别的）。
```

这导致一个实际后果：**GCD 里可以用 thread-local storage，Swift Concurrency 里不行。** `pthread_getspecific` / `Thread.current` 在 await 前后可能返回不同值。如果你在 await 之前存了东西到 thread-local，await 之后可能在另一个线程上，读不到了。

### 挂起的实现：编译器切函数

Swift 编译器对 async 函数的处理不是运行时魔法，是编译期变换。一个 async 函数被切割成多段同步函数：

```swift
// 你写的:
func process() async {
    let a = prepareData()        // 同步代码
    let b = await fetchFromNet() // 挂起点 ①
    let c = transform(a, b)      // 同步代码
    await saveToDB(c)            // 挂起点 ②
    cleanup()                    // 同步代码
}

// 编译器拆成:
// chunk 0: prepareData() → 到挂起点 ① → 保存 a 到 async frame → 让出线程
// chunk 1: 从 async frame 恢复 a，拿到 b → transform → 到挂起点 ② → 保存 c → 让出线程
// chunk 2: 从 async frame 恢复 → cleanup → 函数结束
```

每个 chunk 是一个普通函数，接收 **async frame**（堆上分配的状态对象）作为参数。async frame 里存着所有跨 await 存活的局部变量。这就是 continuation——"接下来该执行哪个 chunk，以及执行它需要的上下文"。

对比 GCD：block 就是一个闭包，捕获变量后一次性执行完毕。没有"切割"、没有"挂起点"、没有"恢复"。block 的生命周期完全在一次函数调用里。

### 为什么这些差异重要

差异不是学术讨论，它直接影响你写代码时的思维模型：

| 场景 | GCD 的做法 | Swift Concurrency 的做法 |
|------|-----------|------------------------|
| 等异步结果 | `dispatch_sync` 阻塞线程 | `await` 挂起任务，线程去干别的 |
| 线程安全 | 锁 / 串行队列保护 | Actor 隔离 + Sendable 约束 |
| await 前后的状态 | 不存在 await，block 内状态不变 | await 前后状态可能被其他任务修改（Actor 重入） |
| Thread.current | block 内始终同一个线程 | await 前后可能不同线程 |
| 线程数量 | 最多 64 个，容易饥饿 | = CPU 核心数，不会饥饿 |
| 死锁风险 | 串行队列 sync 自身 = 死锁 | 不存在（没有阻塞线程的操作） |
| 重入风险 | 不存在（串行队列严格 FIFO） | Actor 方法 await 处可重入 |

GCD 用线程阻塞换来了确定性（block 内状态不变、不重入），代价是可能死锁和线程饥饿。Swift Concurrency 用任务挂起换来了不死锁和不饥饿，代价是 await 前后状态可能变化和需要 Sendable 约束。

**没有免费的午餐。** 串行 + 同步等待 + 不阻塞线程 + 不重入，这四个性质不可能同时满足。GCD 选了前两个，Swift Concurrency 选了中间两个。理解这个取舍，后面的 Actor 重入、Sendable 约束就都是自然推论。

### Actor ≠ 串行队列

很多文章说 Actor 就是"编译器帮你管理的串行队列"。这个说法不准确，差异在**可重入性（Reentrancy）**。

GCD 串行队列严格 FIFO：任务 A 不执行完，任务 B 不会开始。

Actor 不是这样。当 actor 方法内部遇到 `await` 挂起时，actor 会**释放隔离域的独占权**——其他等待进入该 actor 的任务得以开始执行。这意味着一个 actor 方法的前半段和后半段之间，状态可能被其他任务修改。

```swift
actor BankAccount {
    var balance: Int = 1000

    func withdraw(_ amount: Int) async -> Bool {
        guard balance >= amount else { return false }  // ① 检查余额

        // await 挂起 → 其他任务可能在这里修改 balance
        await logTransaction(amount)

        balance -= amount  // ② 扣款 → 但此时 balance 可能已经不满足条件了
        return true
    }
}
```

如果两个任务分别调用 `withdraw(800)`：

```
任务 A: ① 检查 balance=1000 >= 800 ✅ → await 挂起
任务 B: ① 检查 balance=1000 >= 800 ✅ → await 挂起
任务 A: ② balance -= 800 → balance=200
任务 B: ② balance -= 800 → balance=-600  ← 超额扣款
```

编译器不会警告这个问题。Actor 保证的是同一时刻只有一个任务在执行它的同步代码，**但 await 前后不是原子的**。

正确写法是不要在 actor 方法中间 await，或者在 await 之后重新检查状态：

```swift
func withdraw(_ amount: Int) async -> Bool {
    await logTransaction(amount)

    // await 之后重新检查
    guard balance >= amount else { return false }
    balance -= amount
    return true
}
```

### Sendable 的三种姿势

Swift 6 严格模式下，跨并发域传递的数据必须 `Sendable`。实际工程中有三种情况：

```swift
// 1. 值类型 — 天然 Sendable（因为传递的是拷贝）
struct UserDTO: Sendable {
    let id: Int
    let name: String
}

// 2. 不可变引用类型 — 没有可变状态就没有竞争
final class Config: Sendable {
    let apiKey: String  // 全是 let
    init(apiKey: String) { self.apiKey = apiKey }
}

// 3. 自己保证线程安全的引用类型 — @unchecked 告诉编译器"我担保"
class LegacyCache: @unchecked Sendable {
    private var dict: [String: Any] = [:]
    private let lock = NSLock()

    func get(_ key: String) -> Any? {
        lock.lock(); defer { lock.unlock() }
        return dict[key]
    }
}
```

`@unchecked Sendable` 是桥接旧代码的必要手段，但它把线程安全的责任从编译器转回了开发者。用一个就多一个隐患，能用 Actor 替代就不要用它。

### Task 的取消是协作式的

```swift
let task = Task {
    for i in 0..<1000 {
        try Task.checkCancellation()  // 没这行，cancel() 不起作用
        await process(item: i)
    }
}

task.cancel()  // 只是设了一个标记
```

`task.cancel()` 不会强制中断任务，只是把 `Task.isCancelled` 设为 `true`。如果任务内部不检查，它会一直跑完。这和 `NSOperation.cancel()` 的设计完全一样——取消永远是协作式的，从来不是强制的。

## `dispatch_group` 底层

`dispatch_group` 内部是一个长整型的原子计数器：

```
dispatch_group_enter(group)  → 原子 +1
dispatch_group_leave(group)  → 原子 -1
归零 → 触发 notify 回调
```

`dispatch_group_async(group, queue, block)` 是语法糖：

```objectivec
dispatch_group_enter(group);
dispatch_async(queue, ^{
    block();
    dispatch_group_leave(group);
});
```

`enter/leave` 必须严格配对。多 enter 少 leave → notify 永远不触发（静默 bug，比崩溃更难查）。少 enter 多 leave → 计数器变负 → 触发断言崩溃。

生产中异步回调里漏写 `leave` 是最常见的 bug。代码走了 early return 的分支，跳过了 `leave`：

```objectivec
dispatch_group_enter(group);
[API request:^(id result, NSError *error) {
    if (error) {
        return;  // 💀 忘了 leave → group 永远不归零
    }
    // 处理 result
    dispatch_group_leave(group);
}];
```

## 线程安全容器：完整实现

面试高频手写题。用 GCD concurrent queue + barrier 实现多读单写：

```swift
final class ThreadSafeDictionary<Key: Hashable & Sendable, Value: Sendable>: @unchecked Sendable {
    private var storage: [Key: Value] = [:]
    private let queue = DispatchQueue(label: "com.safe.dict", attributes: .concurrent)

    func get(_ key: Key) -> Value? {
        queue.sync { storage[key] }          // 读：并发执行
    }

    func set(_ key: Key, _ value: Value?) {
        queue.async(flags: .barrier) {       // 写：等所有读完成，独占执行
            self.storage[key] = value
        }
    }

    var count: Int {
        queue.sync { storage.count }
    }

    subscript(key: Key) -> Value? {
        get { get(key) }
        set { set(key, newValue) }
    }
}
```

面试追问：

- 读用 `sync` 是因为需要返回值，必须同步等结果。
- 写用 `async(flags: .barrier)` 是因为 barrier 让 libdispatch 等所有正在 drain 该队列的读线程完成后，再由一个线程独占执行写操作。async 避免阻塞调用方。
- 写能用 `sync` 吗？能，但会阻塞调用线程。如果从当前 queue 调 sync 还会死锁。
- 为什么不用 `NSLock`？NSLock 是互斥锁，不区分读写，读也串行。barrier 方案读可以并发，吞吐量高得多。

对应 OC 版本：

```objectivec
- (id)objectForKey:(NSString *)key {
    __block id result;
    dispatch_sync(_queue, ^{
        result = self.storage[key];
    });
    return result;
}

- (void)setObject:(id)obj forKey:(NSString *)key {
    dispatch_barrier_async(_queue, ^{
        self.storage[key] = obj;
    });
}
```

## 打印顺序题的分析框架

遇到 GCD 打印顺序题，按三步拆：

**第一步：sync 还是 async？** → 决定外部代码是否等待。sync 阻塞，async 不阻塞。

**第二步：串行还是并发队列？** → 决定 block 之间是否并发。串行 FIFO，并发同时。

**第三步：变量捕获方式？** → 决定 block 操作的是谁。无修饰符值拷贝，`__block` 引用共享。

用这个框架解一道：

```objectivec
dispatch_queue_t queue = dispatch_queue_create("serial", DISPATCH_QUEUE_SERIAL);
NSLog(@"1");
dispatch_async(queue, ^{
    NSLog(@"2");
    dispatch_async(queue, ^{
        NSLog(@"3");
    });
    NSLog(@"4");
});
NSLog(@"5");
```

分析：外层 async 不等 → `1` 和 `5` 先输出。串行队列 → 同一时刻只有一个线程在 drain，严格 FIFO。内层 async 把 block 入队到链表尾部，排在外层 block 之后。drain 循环必须先把外层 block 执行完（输出 `2`、`4`），才能取到内层 block（输出 `3`）。

答案：**1、5、2、4、3**。`1` 和 `5` 一定先输出（同步代码），后面三个一定是 `2、4、3`（串行队列 FIFO）。

## 知识图谱

```
iOS 多线程
├── 调度机制
│   ├── GCD：queue × sync/async → 行为矩阵
│   │   ├── 串行 + sync 自身 = 死锁
│   │   ├── barrier 只对自建并发队列生效
│   │   ├── group 的 enter/leave 配对
│   │   └── dispatch_once 不可递归
│   └── NSOperation：依赖图、取消、KVO
├── 同步机制
│   ├── 自旋锁 → 废弃（优先级反转）
│   ├── os_unfair_lock（最轻量）
│   ├── @synchronized（递归锁 + obj==nil 陷阱）
│   ├── GCD barrier（读写分离）
│   └── Actor（编译器保证，但有 reentrancy 问题）
├── RunLoop
│   ├── performSelector:afterDelay: 依赖 RunLoop
│   ├── NSTimer Mode 切换问题 → GCD Timer 替代
│   └── 卡顿监控：子线程探测 RunLoop 状态变化间隔
├── 数据竞争
│   ├── 读-改-写 三步指令 → 丢失更新
│   ├── group 解决时序，锁解决原子性
│   └── __block 引用共享 vs 值拷贝
└── Swift Concurrency
    ├── Actor ≠ 串行队列（reentrancy）
    ├── Sendable：值类型 / final let / @unchecked
    └── Task 取消是协作式的
```
