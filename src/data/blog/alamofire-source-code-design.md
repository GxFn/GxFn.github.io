---
author: Gao Xuefeng
pubDatetime: 2026-04-13T12:00:00+08:00
title: Alamofire 源码里的设计课
slug: alamofire-source-code-design
featured: true
draft: false
tags:
  - Swift
  - Alamofire
  - 源码
  - 架构
description: 读 Alamofire 源码时记下的东西。一个网络库，36 个文件，把线程安全、状态机、拦截器、序列化流水线做到了教科书级别。
---

读 Alamofire 源码的起因是项目里的网络层写得不好。Singleton、Cookie 注入写了三处、重试逻辑散落在各个 ViewModel 里。想重构，但不知道该往哪个方向走。与其自己想，不如看看 44k star 的库怎么做的。

以下是读完之后记下来的东西。不是 API 使用教程，是设计层面的收获。

## 先理解它在包装什么

Alamofire 包装的是 `URLSession`。不理解原生 API 的痛点，就不理解 Alamofire 每一层抽象在解决什么。

URLSession 的三层架构：Configuration（配置行为）→ Session（管理连接池）→ Task（执行请求）。三种使用方式：Completion Handler、async/await、Delegate。

原生写法长这样：

```swift
var request = URLRequest(url: URL(string: "https://api.example.com/user")!)
request.httpMethod = "POST"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
request.httpBody = try? JSONEncoder().encode(params)

URLSession.shared.dataTask(with: request) { data, response, error in
    guard error == nil,
          let response = response as? HTTPURLResponse,
          (200...299).contains(response.statusCode),
          let data else { return }
    DispatchQueue.main.async {
        let user = try? JSONDecoder().decode(User.self, from: data)
    }
}.resume()
```

Alamofire 写法：

```swift
AF.request("https://api.example.com/user", method: .post,
           parameters: params, encoder: JSONParameterEncoder.default)
    .validate()
    .responseDecodable(of: User.self) { response in }
```

行数差异不是重点。重点是原生 API 的九个结构性问题：每次手写 URLRequest 样板代码、错误处理分散在三个地方（网络/HTTP/解码）、回调在后台队列忘切主线程就 crash、没有内建重试、没有统一的 Header 注入点、Task 默认 suspended 忘记 resume 就发不出去、一个 URLSession 只有一个 delegate 多请求要自己路由。

Alamofire 的每一层抽象都精确对应一个痛点，不多不少。

## 36 个文件的全景

```
Source/
├── Core/        (18 个文件) 核心引擎
│   ├── Session.swift           请求工厂与调度中心
│   ├── Request.swift           所有请求的基类，状态机 + 可变状态
│   ├── DataRequest.swift       内存数据请求
│   ├── DownloadRequest.swift   文件下载
│   ├── UploadRequest.swift     上传（继承 DataRequest）
│   ├── SessionDelegate.swift   URLSession 回调桥接
│   ├── Protected.swift         线程安全泛型容器
│   ├── RequestTaskMap.swift    Request ↔ Task 双向映射
│   ├── AFError.swift           统一错误类型
│   └── ...
├── Features/    (18 个文件) 可插拔功能
│   ├── EventMonitor.swift      事件观察协议
│   ├── RequestInterceptor.swift 请求拦截器
│   ├── ResponseSerialization.swift 响应序列化
│   ├── RetryPolicy.swift       重试策略
│   ├── Concurrency.swift       async/await 适配
│   └── ...
└── Extensions/  (6 个文件) 标准库扩展
```

Core 和 Features 的分界很清楚：Core 是引擎，Features 是可插拔的行为。这个分层本身就值得学。

## Protected — 线程安全的正确做法

这是我读到的第一个让我停下来反复看的设计。

Alamofire 没有给每个变量各加一把锁。它把所有可变状态收进一个 struct（`MutableState`），然后用一个泛型容器 `Protected<Value>` 包住，一把锁保护所有东西。

```swift
struct MutableState {
    var state: State = .initialized
    var requests: [URLRequest] = []
    var tasks: [URLSessionTask] = []
    var metrics: [URLSessionTaskMetrics] = []
    var retryCount = 0
    var error: AFError?
    var responseSerializers: [...]
    // ... 十几个字段，一把锁
}

let mutableState: Protected<MutableState>
```

分散加锁（N 把锁）的问题是：死锁风险、性能差、状态不一致。集中到一个 struct 里用一把锁，原子性天然保证。

有意思的是 `Protected` 的实现细节。它没有用 `OSAllocatedUnfairLock.withLock`，而是自己定义了 Lock 协议，手动 `lock()` / `unlock()`：

```swift
private func around<T>(_ closure: () throws -> T) rethrows -> T {
    lock.lock(); defer { lock.unlock() }
    return try closure()
}
```

原因是 `withLock` 要求闭包是 `@Sendable`，但 `Protected<Value>` 是泛型容器，`Value` 没有 `Sendable` 约束（`MutableState` 里有 `URLSessionTask` 这种非 Sendable 类型）。用 `withLock` 会编译报错。

不是老式写法，是唯一正确的做法。

整个类标记 `@unchecked Sendable`——锁已经保证了线程安全，但编译器推断不出来，需要手动告诉它。内部的 `value` 属性用 `nonisolated(unsafe)` 标记——Swift 6 严格模式下，`Sendable` 类型的 `var` 必须证明线程安全，这个标记表示"我自己用锁保证"。

## Request 状态机

每个请求有 5 个状态：

```
initialized → resumed ⇄ suspended → cancelled/finished
```

`cancelled` 和 `finished` 是终态，不能转出。`resumed` 和 `suspended` 可以互相切换。状态转换通过 `canTransitionTo` 方法穷举所有合法路径，非法转换直接 return。

一个 Request 可能产生多个 `URLSessionTask`——重试时老 task 废弃，创建新 task。所以 `tasks` 和 `metrics` 都是数组：

| 场景 | tasks 数组 |
|------|-----------|
| 正常请求 | `[task0]` |
| 重试 1 次 | `[task0, task1]` |
| 重试 2 次 | `[task0, task1, task2]` |

日常使用取 `task`（= last），调试分析取 `firstTask`，完整历史取 `tasks`。

## retryOrFinish — 决策分离的枢纽

这是整个库最精妙的方法，四五十行代码。

```swift
func retryOrFinish(error: AFError?) {
    guard !isCancelled, let error, let delegate else { finish(); return }
    
    delegate.retryResult(for: self, dueTo: error) { retryResult in
        switch retryResult {
        case .doNotRetry:           self.finish()
        case .doNotRetryWithError:  self.finish(error: retryError)
        case .retry, .retryWithDelay: delegate.retryRequest(self, ...)
        }
    }
}
```

guard 的三个条件各有语义：已取消不重试、error 为 nil 说明成功直接 finish、delegate 是 weak 如果 Session 已释放就降级。

关键设计：Request 自己不判断该不该重试。它只知道"出错了"，把决策权完全交给 delegate（Session）→ interceptor（你的业务代码）。四个不同的失败路径（URLRequest 构造失败、Adapter 失败、网络错误、响应验证失败）全部汇聚到这一个方法。

Request 只负责问和执行，不包含任何重试策略。策略在 interceptor 里，想换随时换。

## 拦截器的三个槽位

```swift
public protocol RequestAdapter   { func adapt(...) }
public protocol RequestRetrier   { func retry(...) }
public typealias RequestInterceptor = RequestAdapter & RequestRetrier
```

内置的 `Interceptor` 组合器提供三个数组：

| 参数 | 语义 |
|------|------|
| `adapters: [RequestAdapter]` | 只修改请求（注入 Header、Cookie） |
| `retriers: [RequestRetrier]` | 只处理重试 |
| `interceptors: [RequestInterceptor]` | 两者都做 |

拦截管道是 Session 级先执行、Request 级后执行的双层结构。adapt 按顺序串行（前一个的输出是后一个的输入），retry 则是第一个返回 `.retry` 的 retrier 胜出。

实际项目中最常用的场景是认证拦截器。多个请求同时 401 时，只刷新一次凭证，其他请求排队等待。实现要素是 `Protected<AuthState>` 状态机 + pending 回调队列，`attemptToTransitionTo(.authenticating)` 保证原子性——只有第一个请求成功转换并执行刷新。

## 序列化流水线

用户可以链式添加多个序列化器：

```swift
request
    .responseDecodable(of: User.self) { ... }  // serializers[0]
    .responseString { ... }                     // serializers[1]
```

执行机制用了一个巧妙的 trick：`completions.count` 既是"已完成数"也是"下一个要执行的索引"。不需要单独维护 currentIndex 变量。

```
第 1 轮: completions.count = 0 → 执行 serializers[0]
第 2 轮: completions.count = 1 → 执行 serializers[1]
第 3 轮: completions.count = 2 ≥ serializers.count → 执行所有 completions → cleanup
```

重试时 `completions` 清空（游标归零），但 `serializers` 不清——重试后从头重新序列化。

还有一个细节：序列化器的实际执行放在锁外。`write` 闭包里只读取状态、准备好要做的事（返回一个闭包），锁释放后再执行。避免持锁期间做耗时的 JSON 解码。

## 链式 API 的编译器实现

```swift
@discardableResult
public func cancel() -> Self { ... return self }
```

`Self`（大写）在子类中解析为子类类型：`DataRequest` 调完 `cancel()` 返回的仍然是 `DataRequest`，不会退化成 `Request`。编译器为子类自动生成 thunk 函数，内部用 `unchecked_ref_cast` 转换类型，零运行时开销。

为什么用 `return self` 而不是构造新实例？因为构造新实例需要 `required init`，Request 的初始化参数很复杂，强制子类实现没有意义。`return self` 就够了。

## EventMonitor — 无侵入的观测

30 多个方法的协议，全部有默认空实现。`CompositeEventMonitor` 把多个监控者组合成一个，Session 级和 Request 级的事件统一分发。

实际项目中用它做了两件事：一是网络活跃指示器（`requestDidResume` 时 +1，`requestDidFinish` 时 -1），二是请求 Metrics 采集。业务代码完全不知道这些监控存在。

## 双队列分层

```
underlyingQueue    → 所有内部状态变更（串行）
serializationQueue → 响应序列化（串行，target 到 underlyingQueue）
用户指定队列        → 回调执行（默认 .main）
```

Public API（cancel/suspend/resume）可以在任何队列调用——内部用 `mutableState.write {}` 保证线程安全，状态变更后 async 回 underlyingQueue 执行副作用。Internal Event API 开头都有 `dispatchPrecondition(condition: .onQueue(underlyingQueue))`，Debug 模式下检查，Release 优化掉。

## HTTPMethod 为什么是 struct 不是 enum

```swift
public struct HTTPMethod: RawRepresentable, Equatable, Hashable, Sendable {
    public static let get = HTTPMethod(rawValue: "GET")
    public static let post = HTTPMethod(rawValue: "POST")
    // ...
}
```

enum 不能扩展 case。如果有人需要 `PATCH` 或自定义方法，enum 就死了。struct + RawRepresentable + 静态常量，用起来跟 enum 一样（`.get`、`.post`），但用户可以 `HTTPMethod(rawValue: "CUSTOM")`。

同样的 pattern 在 `HTTPHeaders.Name` 里也用了。

## 读完之后做了什么

基于这些设计重构了项目的网络层。几个直接的产出：

- `Protected<Value>` 搬进项目，直接用 `OSAllocatedUnfairLock`（iOS-only 不需要跨平台）
- `AuthState` 状态机 + `canTransitionTo`，从 Alamofire 的 `Request.State` 学来的
- `BiliAuthInterceptor` 实现 coalescing 模式——多个 401 只刷新一次凭证
- `NetworkActivityMonitor` 基于 `EventMonitor` 协议追踪活跃请求
- 网络层从 Singleton 改成协议化的 `NetworkClient`，中间件链替代散落的拦截逻辑

最大的收获不是某个具体 pattern，是「集中式可变状态 + 单锁」这个思路。之前总觉得每个变量各加一把锁才"安全"，读完 Alamofire 才明白那是最不安全的做法。
