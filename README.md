# dsh-plugin-background-run

DSH Windows 后台运行插件：显示器关闭但系统保持唤醒时，DSH 任务继续执行；
任务运行期间阻止系统自动睡眠；任务结束后释放电源保持。

## 目标与非目标

- 支持：显示器关闭、锁屏（系统仍在运行）时 DSH 继续执行任务。
- 不支持：真正进入睡眠 / 休眠后继续执行（普通插件无法做到，本插件不声称）。
- 技术重点：只阻止系统睡眠，不阻止显示器关闭。

## 架构判断（需求 §三.1 结论）

- DSH Web 插件运行在浏览器端，不能直接调用 Win32 API。
- 采用前后端配套插件：
  - 宿主侧（Node.js）：`src/` —— 设置注册、电源保持、任务检测、网络监测；
  - 浏览器侧：`client/client.js` —— 设置开关 + 真实状态展示。
- 电源 API：`kernel32.SetThreadExecutionState`，经 DSH 自带的 `koffi` FFI 调用
  （与 `dsh-win32-process` 同款机制），无新增原生编译依赖，无第三方电源包。
- 标志：`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`；永不使用 `ES_DISPLAY_REQUIRED`。

## 配置

命名空间 `background-run`，字段 `backgroundRunEnabled: boolean`，默认 `false`。
旧配置缺字段按 `false` 处理；页面刷新 / DSH 重启后保持（标准 settings 持久化）。

## 任务检测（复用现有事件）

- 当前任务：`agent/status`（idle ⇄ running，覆盖流式模型请求与工具调用全程）。
- 后台任务：`ctx.jobs` 注册表（`onJobsChanged` + `onJobDone` + `list()` 差分）。
- 定时任务（dsh-schedule）：触发后走 agent turn，已被 `agent/status` 覆盖，
  不单独计数（避免重复计数）。
- 无法覆盖：未接入 jobs 注册表的孤立子进程、schedule 触发前等待期。
  插件不伪造这些任务的状态。

## 电源保持策略

- 开关关闭：不申请，不干预睡眠。
- 开启但无任务：不持有，仅在线。
- 有任务：引用计数 +1 申请，归零释放；失败/取消/超时同样走结束路径。
- 卸载 / 退出 / 未捕获异常：清理保持请求、监测器、计数。

## 网络

仅观测 + 提示（DNS 探测，30s 间隔）。中断时打日志并在设置页展示，
恢复后是否继续遵循 DSH 原有任务模型。不改网卡/适配器/驱动配置。

## 安装（web profile）

```sh
dsh plugin --profile web add /d/dsh-workspaces/dev/dsh-plugin-background-run
```

再在 `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: background-run
      name: '@gjs27/dsh-plugin-background-run'
    - id: background-run-status
      name: '@gjs27/dsh-plugin-background-run/status-controller'
    - id: ui-background-run
      name: '@gjs27/dsh-plugin-background-run/client'
```

## 手动验证（Windows）

1. 打开 DSH 设置 → 插件 → 后台运行，打开“允许 DSH 后台运行”。
2. 开始一个长任务（如让 agent 执行耗时工具）。
3. 状态应显示：后台运行已启用 / 电源保持已生效 / 当前任务运行中。
4. `powercfg /requests` 应出现 SYSTEM 请求（来自 DSH 进程）。
5. 等显示器按系统设置关闭（或 Win+L 锁屏），任务应继续推进。
6. 任务结束后状态回到空闲，`powercfg /requests` 不再有本插件的 SYSTEM 请求。
7. 关闭开关 → 不再申请；卸载插件 → 无残留。

## 验证结果（2026-09-14）

- 单元/逻辑测试 24 项全过：`npm test`
  （引用计数、状态派生、配置归一化、电源 mock、生命周期语义）。
- 真实 Cordis 集成测试 6 项全过：在 `D:\DSHData\home\profiles\web`
  下运行 `node --test <插件>/test/host-harness.test.mjs`
  （真实 `Context` + `lib/index.js`：命名空间注册、快照服务、
  开关关闭不计数、running→idle 计数释放、多任务、开关关闭清零）。
- `dsh --profile web --dump-config`（`DSH_HOME=D:\DSHData\home`）：
  composed tree 含 `- id: background-run`。
- 真实 Win32 电源调用冒烟（profile 内 koffi）：
  `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` 申请/释放成功。
- 浏览器 bundle 已 served（`GET /plugins/??@gjs27/dsh-plugin-background-run/client.js` 200）。
- 待用户重启 DSH 后手动验证：设置页开关、`powercfg /requests`、
  显示器关闭/锁屏下任务继续、任务结束释放。
