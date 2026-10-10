# dsh-plugin-background-run

DSH Windows 后台运行插件：显示器关闭但系统保持唤醒时，DSH 任务继续执行；
任务运行期间阻止系统自动睡眠；任务结束后释放电源保持。

当前适配目标宿主：**DSH 0.2.0-rc.2**（插件自身版本独立，见「版本与变更日志」）。

## 目标与非目标

- 支持：显示器关闭、锁屏（系统仍在运行）时 DSH 继续执行任务。
- 不支持：真正进入睡眠 / 休眠后继续执行（普通插件无法做到，本插件不声称）。
- 技术重点：只阻止系统睡眠，不阻止显示器关闭。

## 与宿主原生「后台运行」的分工（0.1.7-rc.2 起）

DSH 宿主已原生实现「关闭桌面窗口后任务继续在后台运行，退出应用前提示影响」——
那是**进程/窗口生命周期**层面的能力。本插件不与之竞争、也不重复：

| 维度 | 宿主原生 | 本插件 |
|---|---|---|
| 管什么 | 窗口/进程生命周期：关掉窗口后任务不中断 | 系统电源：任务期间阻止**系统空闲睡眠** |
| 机制 | 桌面壳进程管理 | `SetThreadExecutionState(ES_CONTINUOUS\|ES_SYSTEM_REQUIRED)` |
| 显示器 | 不涉及 | **永不阻止**显示器关闭（不使用 `ES_DISPLAY_REQUIRED`） |

两者不冲突：宿主保证"窗口关了任务还在"，本插件保证"机器别睡着"。
仍然明确**不支持**睡眠/休眠后继续执行。

## 架构判断

- DSH Web 插件运行在浏览器端，不能直接调用 Win32 API。
- 采用前后端配套插件：
  - 宿主侧（Node.js）：`src/` —— 设置绑定、电源保持、任务检测、网络监测；
  - 浏览器侧：`client/client.js` —— 设置开关 + 真实状态展示。
- 电源 API：`kernel32.SetThreadExecutionState`，经 `koffi` FFI 调用（`dsh-win32-process` 同款机制）。
- 标志：`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`；永不使用 `ES_DISPLAY_REQUIRED`。

## 配置（0.2.0 起：Loader 条目 config，不再是 settings.yaml）

命名空间 = **Loader 条目 id = `background-run`**，字段 `backgroundRunEnabled: boolean`，默认 `false`。
类型严格 boolean，旧配置缺字段/类型错误一律按 `false` 处理。

- schema 由插件入口导出 `Config`（`src/config.ts`，字段标 `.volatile()`）；
  宿主的 `dsh-settings` 读 `entry.fiber.runtime.Config` 生成设置页。
- 持久化位置：**profile 的 `cordis.patch.yml` 里该 entry 的 `config:`**：

  ```yaml
  - id: background-run
    name: '@gjs27/dsh-plugin-background-run'
    config:
      backgroundRunEnabled: true
  ```

- 设置页读写主通道是客户端的 `ctx.configForms.get('background-run')`
  （0.1.7-rc.2 起 `settingsScope` 更名为 `configForms`）；
  宿主侧 `backgroundRunStatus.getSettings/updateSettings` 为兜底通道，
  其中 `updateSettings` 走 `settings.update(ns, patch)`，与设置页落在同一位置。

> ⚠️ 条目 id 必须恰好是 `background-run`，否则设置页读不到配置
> （宿主按 `options.id` 匹配命名空间），此时 `backgroundRunStatus.status()` 的
> `settingsBound` 会是 `false`、`enabled` 保持安全默认 `false`。

## 任务检测（复用现有事件）

- 当前任务：`agent/status`（idle ⇄ running，覆盖流式模型请求与工具调用全程）。
- 后台任务：`ctx.jobs.subscribe(ctx, { owners: 'all' }, listener)` 事件驱动
  （`registered` / `stopping` / `settled` / `removed` …），
  并以 `jobs.list()` 快照差分作**唯一可信兜底**（订阅缺失或漏事件时仍正确）。
  活跃态 = `running | stopping`，终止态 = `completed | killed | failed`；
  `removed` 与「从 list 中消失」都收口，避免计数泄漏。
- 定时任务（dsh-schedule）：触发后走 agent turn，已被 `agent/status` 覆盖，不单独计数。
- 无法覆盖：未接入 jobs 注册表的孤立子进程、schedule 触发前等待期。插件不伪造这些任务的状态。

### 自检打点（只读）

`backgroundRunStatus.status()` 快照含三个诊断字段，便于确认接线是否正确：

| 字段 | 含义 |
|---|---|
| `settingsBound` | 是否绑定到 id = `background-run` 的 Loader 条目（false = 正在用默认值 false） |
| `agentStatusEvents` | 本进程收到的 `agent/status` 事件数（0 = 事件被 scope 过滤，需改订阅方式） |
| `jobEvents` | 本进程收到的 jobs 订阅事件数（0 = `subscribe` 未接通） |

## 电源保持策略

- 开关关闭：不申请，不干预睡眠。
- 开启但无任务：不持有，仅在线。
- 有任务：引用计数 +1 申请，归零释放；失败/取消/超时同样走结束路径。
- 卸载 / 退出 / 未捕获异常：清理保持请求、监测器、定时器、计数。

## 网络

仅观测 + 提示（DNS 探测，30s 间隔，单次探测 8s 显式超时）。
中断时打日志并在设置页展示，恢复后是否继续遵循 DSH 原有任务模型。
不改网卡/适配器/驱动配置。

## 安装（profile）

```sh
dsh plugin --profile web add <插件目录或包名>
```

然后在 `profiles/<profile>/cordis.patch.yml` 里确保存在该条目（id 必须是 `background-run`）：

```yaml
- insert:
    - id: background-run
      name: '@gjs27/dsh-plugin-background-run'
    - id: background-run-status
      name: '@gjs27/dsh-plugin-background-run/status-controller'
    - id: ui-background-run
      name: '@gjs27/dsh-plugin-background-run/client'
```

依赖可见性：`zod` / `koffi` 由本包自身依赖提供，`@deepseek-ai/*`（含 `schemastery`、
`cordis`、`dsh-settings`、`dsh-agent`、`dsh-jobs`、`dsh-typert-protocol`）由 profile 的宿主 cohort 提供。
从源码目录以 `link:` 方式接入时，请先在本插件目录执行 `pnpm install`，
否则运行时依赖不在解析链上（电源后端会降级为 `unsupported` 并在快照里给 `backendNote`）。

## 开发与验证

```sh
pnpm install          # 仅在本插件目录；不改 profile
pnpm run typecheck    # tsc --noEmit
pnpm run build        # node ./scripts/build.mjs → lib/*.js（src/ 为唯一权威源码）
pnpm test             # 纯逻辑 + 构建产物回归（state/power/plugin-lifecycle/config/network/jobs）
pnpm test:host        # 真实 Cordis Context 集成测试（需 @deepseek-ai/* 可解析）
```

> `src/` 改动后必须重建 `lib/`：`lib/` 是纯产物，`node ./scripts/build.mjs` 可重复生成。

## 手动验证（Windows，需用户重启 DSH）

1. 打开 DSH 设置 → 后台运行，打开「允许 DSH 后台运行」。
2. 开始一个长任务（如让 agent 执行耗时工具）。
3. 状态应显示：后台运行已启用 / 电源保持已生效 / 当前任务运行中；
   `backgroundRunStatus.status()` 里 `settingsBound: true`、`agentStatusEvents > 0`。
4. `powercfg /requests` 应出现 SYSTEM 请求（来自 DSH 进程）。
5. 等显示器按系统设置关闭（或 Win+L 锁屏），任务应继续推进。
6. 任务结束后状态回到空闲，`powercfg /requests` 不再有本插件的 SYSTEM 请求。
7. 关闭开关 → 不再申请；卸载插件 → 无残留（定时器与电源请求均清零）。

## 版本与变更日志

- 插件版本与 DSH 宿主版本是**两个独立坐标**：插件 `0.2.0` ≠ 宿主 `0.2.0-rc.2`。

### 0.2.0（适配 DSH 0.2.0-rc.2）

破坏性 / 对外可见变更（因此按 minor 提升，而非 patch）：

- **设置面**：删除 `ctx.settings.register(ns, schema)`（0.1.7 起宿主已移除），
  改为入口导出 `Config` + Loader 条目 `config` + `ctx.settings.configure({ auto: true }, ctx.fiber)`；
  持久化从 `$DSH_HOME/settings.yaml` 迁到 profile 的 `cordis.patch.yml`，
  **旧值不会自动迁移**（新装后默认 `false`）。
- **任务计数**：`ctx.jobs.onJobsChanged/onJobDone` 与 `JobSnapshot` 在目标宿主全库无命中，
  改为 `jobs.subscribe(...)` 事件驱动 + `jobs.list()` 差分兜底，按 `status` 判定活跃态。
- **客户端**：`ctx.settingsScope` → `ctx.configForms`（`ConfigForm`），
  写开关改走 `mutate([{ op:'set', path:['backgroundRunEnabled'], … }])` 并从 user 层回读。
- **Remote**：客户端 strict codec 补齐 `create()` 工厂；`$mount` 加 8s 超时兜底。
- **peer 范围**：4 个 DSH peer 由 `^0.1.5-rc.1 || … || ^0.1.7-rc.1` 改为
  `^0.1.0 || ^0.2.0-rc.1`（实测覆盖 `0.2.0-rc.2`）；`cordis ^4.0.4`、`schemastery ^3.18.4`。
- **清理**：删除 TEMP-DIAG（向 `D:/DSHData/home/background-run-diag.log` 的硬编码写入，
  连同伴随的 `__diag` 回传链路）；`dns.lookup({signal})` 的无效超时改为 `Promise.race` 显式超时。

### 0.1.0

首个版本（最后完整人工验证：0.1.5-rc.1 时代，2026-09-14）。
