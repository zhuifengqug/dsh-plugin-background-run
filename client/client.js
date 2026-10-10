/* DSH 后台运行插件 - 浏览器侧设置页面（左侧导航独立入口，仿 dsh-myrules）。
 * ModuleLoader 工厂格式。开关读写主通道是 `ctx.configForms.get('background-run')`
 * （0.1.7-rc.2 起 `settingsScope` 更名为 `configForms`），
 * 状态展示走宿主侧 backgroundRunStatus 只读快照（Remote）。
 *
 * 注册 settings.section（id `background-run`）：设置页左侧导航出现「后台运行」，
 * 点进去是整页开关 + 实时状态（电源保持 / 当前任务 / 后台任务 / 网络）。
 * 不再注册 settings.plugin.item，避免与「插件」页卡片重复。
 *
 * 0.2.0 适配（需求 §4）：
 * - B4：写开关走 `form.mutate([{op:'set', path:['backgroundRunEnabled'], …}])`
 *   （**多段路径数组**；`.set(field, value)` 把 field 当单段会被宿主静默拒写），
 *   并从 form 快照的 **user 原始层** 回读确认；
 * - B5：strict codec 改为 `create()` 工厂；`$mount` 加 8s 超时兜底；
 * - B11：删除 `diagLog` / `diagNote` / `__diag` 诊断回传链路。
 */
window.__ModuleLoader__.load({
  id: '@gjs27/dsh-plugin-background-run',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');

    var NS = 'background-run';
    var SETTINGS_NS = 'background-run';

    // ── styles ──────────────────────────────────────────────────────────
    var CSS_ID = 'background-run/styles';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'background-run';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        '.bgr-wrap{display:flex;flex-direction:column;gap:14px;min-height:0;color:var(--dsw-alias-label-primary,#1f2329);font-size:14px;line-height:22px;padding:2px 0;max-width:760px}',
        '.bgr-title{font-size:18px;font-weight:700;line-height:26px;margin-bottom:4px}',
        '.bgr-sub{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:12px;line-height:18px;margin-bottom:10px}',
        '.bgr-divider{height:1px;background:var(--dsw-alias-divider,#e5e6eb);border:none;margin:0}',
        '.bgr-block{display:flex;flex-direction:column;gap:8px}',
        '.bgr-block-head{display:flex;align-items:center;gap:10px}',
        '.bgr-block-title{font-weight:600;font-size:15px;line-height:22px}',
        '.bgr-hint{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:13px;line-height:20px}',
        '.bgr-card{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border,#d9dce1);border-radius:8px;background:var(--dsw-alias-bg-module-platform,#f7f8fa);cursor:pointer}',
        '.bgr-checkbox{width:16px;height:16px;margin-top:3px;flex:none;accent-color:var(--dsw-alias-label-primary,#1f2329)}',
        '.bgr-card-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.bgr-card-title{font-weight:600;font-size:14px;line-height:21px}',
        '.bgr-card-desc{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:12px;line-height:18px}',
        '.bgr-status{display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:20px}',
        '.bgr-ok{color:#12965b}',
        '.bgr-warn{color:#d48806}',
        '.bgr-err{color:#d54941}',
        '.bgr-note{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:12px;line-height:18px}',
        '.bgr-footer{display:flex;align-items:center;gap:12px}',
        '.bgr-btn{cursor:pointer;border:1px solid var(--dsw-alias-label-tertiary,#8f959e);border-radius:999px;padding:2px 14px;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-bg-layer-2,#fff);background:var(--dsw-alias-label-primary,#1f2329)}',
        '.bgr-btn:hover{opacity:.85}',
        '.bgr-btn:disabled{opacity:.5;cursor:not-allowed}',
      ].join('');
      document.head.appendChild(tag);
    }

    // ── i18n ────────────────────────────────────────────────────────────
    // nav/title/hint 对齐 myrules 的页面结构：左侧导航 label 用 nav。
    // saveFailed 支持 {message} 插值：把宿主侧拒绝原因直接展示出来，
    // 不再是永远一句“请重试”。
    var zh = {
      nav: '后台运行',
      title: '后台运行',
      hint: '启用后，关闭显示器或锁屏时 DSH 仍可继续执行任务，并在任务运行期间阻止系统自动睡眠。',
      blockTitle: '电源保持',
      toggleLabel: '允许 DSH 后台运行',
      toggleDesc: '任务运行时申请 Windows 电源保持（仅阻止系统睡眠，不阻止显示器关闭）。任务结束自动释放。',
      statusEnabled: '后台运行：已启用',
      statusDisabled: '后台运行：未启用',
      powerActive: '电源保持：已生效',
      powerIdle: '电源保持：未生效',
      taskRunning: '当前任务：运行中',
      taskIdle: '当前任务：空闲',
      netOnline: '网络状态：已连接',
      netOffline: '网络状态：连接中断',
      jobsLine: '后台任务：{count} 个运行中',
      lastError: '提示：{message}',
      unsupportedNote: '当前系统不支持后台电源保持，DSH 仍可运行，但电脑进入睡眠后任务可能暂停。',
      powerFailed: '后台运行已启用，但无法申请 Windows 电源保持，请检查插件权限和系统环境。',
      netInterrupted: '网络连接中断，当前任务状态将由 DSH 的现有重试机制处理。',
      retry: '重试',
      loading: '正在加载后台运行状态…',
      unavailable: '后台运行设置暂不可用。',
      saveFailed: '设置保存失败：{message}',
      saveFailedUnknown: '设置保存失败，请重试。',
    };
    var en = {
      nav: 'Background Run',
      title: 'Background Run',
      hint: 'When enabled, DSH keeps running tasks with the display off or locked, and blocks automatic sleep while tasks run.',
      blockTitle: 'Power hold',
      toggleLabel: 'Allow DSH to run in the background',
      toggleDesc: 'Acquires a Windows power hold while tasks run (blocks sleep only, never the display). Released when tasks finish.',
      statusEnabled: 'Background run: enabled',
      statusDisabled: 'Background run: disabled',
      powerActive: 'Power hold: active',
      powerIdle: 'Power hold: inactive',
      taskRunning: 'Current task: running',
      taskIdle: 'Current task: idle',
      netOnline: 'Network: connected',
      netOffline: 'Network: interrupted',
      jobsLine: 'Background jobs: {count} running',
      lastError: 'Notice: {message}',
      unsupportedNote: 'Background power hold is not supported on this system. DSH still runs, but tasks may pause after sleep.',
      powerFailed: 'Background run is enabled, but the Windows power hold could not be acquired. Check plugin permissions and environment.',
      netInterrupted: 'Network interrupted. Current tasks follow the existing DSH retry handling.',
      retry: 'Retry',
      loading: 'Loading background-run status…',
      unavailable: 'Background-run settings are unavailable.',
      saveFailed: 'Failed to save settings: {message}',
      saveFailedUnknown: 'Failed to save settings. Please retry.',
    };
    function fmt(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, function (m, k) {
        return vars && vars[k] !== undefined ? String(vars[k]) : m;
      });
    }
    function errText(e) {
      if (!e) return '';
      if (typeof e === 'string') return e;
      // Typert RemoteError / settings/rejected 等：message 藏法各异，全扒一遍。
      if (e.error && e.error.message) return String(e.error.message);
      if (e.data && e.data.message) return String(e.data.message);
      if (e.details && e.details.message) return String(e.details.message);
      if (e.message) return String(e.message);
      try { return JSON.stringify(e).slice(0, 300); } catch (ignored) { return String(e); }
    }
    // 挂载 remote 的方法返回 RPC 信封 {ok, value}（value 才是业务结果），
    // 而非业务结果本身（dsh-api-gateway client.js: invoke() 统一返回
    // {ok:true, value: result} / {ok:false, error}）。这里统一解包，
    // 兼容两种形状，避免二次嵌套误读导致开关被每 5s 强制打回 false。
    function unwrapEnvelope(res) {
      if (res && typeof res === 'object' && typeof res.ok === 'boolean' && Object.prototype.hasOwnProperty.call(res, 'value')) {
        return res.value;
      }
      return res;
    }
    function saveErrorText(t, message) {
      var msg = (message === undefined || message === null || message === '') ? null : String(message);
      if (msg) return fmt(t('saveFailed'), { message: msg });
      return t('saveFailedUnknown');
    }

    // ── remote surface ──────────────────────────────────────────────────
    // at-file 同款 descriptor-driven Remote：浏览器侧显式 $mount 自己的
    // contribution；stock DSH remote bundle 不认识本插件的自定义命名空间。
    // 三个方法与宿主 TYPERT invocations 一一对应（顺序一致）：
    // status / getSettings / updateSettings。
    // 0.2.0（需求 §4 B5）：strict codec **必须**是 create 工厂。
    // 宿主 requireStrictCodec 检查的是 `typeof codec.create === 'function'`
    // （dsh-typert-loader/lib/index.js:208-211）；旧的 { mode, typeSymbol, schema }
    // 写法会让 remote.$mount() 既不 resolve 也不 reject，界面永远停在「正在连接」。
    // 真正的 strict 校验由宿主侧 src/typert.ts 的 zod schema 负责，这里只做透传。
    function passthroughCodec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol: typeSymbol,
        create: function () {
          return {
            parse: function (value) { return value; },
            safeParse: function (value) { return { success: true, data: value }; },
          };
        },
      };
    }
    // $mount 的挂起上限：不合规贡献可能永不 settle（见上），必须自己兜底。
    var MOUNT_TIMEOUT_MS = 8000;
    function withTimeout(promise, timeoutMs) {
      if (!promise || typeof promise.then !== 'function') return promise;
      return Promise.race([
        promise,
        new Promise(function (_resolve, reject) {
          var timer = setTimeout(function () {
            reject(new Error('remote.$mount 超时（' + timeoutMs + ' ms）'));
          }, timeoutMs);
          if (timer && timer.unref) timer.unref();
        }),
      ]);
    }
    function descriptor(method, inputSymbol, resultSymbol) {
      return {
        id: '@gjs27/dsh-plugin-background-run#backgroundRunStatus/' + method,
        service: 'backgroundRunStatus',
        namespace: 'backgroundRunStatus',
        method: method,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: passthroughCodec(inputSymbol),
        }],
        result: passthroughCodec(resultSymbol),
      };
    }
    var REMOTE_CONTRIBUTION = {
      package: '@gjs27/dsh-plugin-background-run',
      descriptors: [
        descriptor('status', '@gjs27/dsh-plugin-background-run/types#EmptyInput', '@gjs27/dsh-plugin-background-run/types#BackgroundRunStatusResult'),
        descriptor('getSettings', '@gjs27/dsh-plugin-background-run/types#EmptyInput', '@gjs27/dsh-plugin-background-run/types#BackgroundRunGetSettingsResult'),
        descriptor('updateSettings', '@gjs27/dsh-plugin-background-run/types#UpdateInput', '@gjs27/dsh-plugin-background-run/types#BackgroundRunUpdateSettingsResult'),
      ],
    };

    // ── plumbing ────────────────────────────────────────────────────────
    var tRef = null;
    var controllerRef = null;

    // Minimal snapshot store: React.useSyncExternalStore only needs
    // getSnapshot/subscribe/set. No dependency on dsh-client-store.
    function createCardStore(initial) {
      var snapshot = initial;
      var listeners = [];
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          };
        },
        set: function (patch) {
          var next = {};
          for (var k in snapshot) next[k] = snapshot[k];
          for (var k2 in patch) next[k2] = patch[k2];
          snapshot = next;
          var copy = listeners.slice();
          for (var i = 0; i < copy.length; i++) copy[i]();
        },
      };
    }
    function createInitialState() {
      return {
        settingsStatus: 'loading',
        enabled: false,
        writable: false,
        saving: false,
        saveFailed: false,
        saveError: null,
        live: null,
      };
    }
    // 0.2.0（需求 §4 B4）：第三参数仍是 Remote 兜底通道；第二参数由
    // `ctx.settingsScope.bind()` 换成 `ctx.configForms.get()` 得到的 ConfigForm。
    // 快照形状 `{ status, value, base, user, revision, writable, mode }`。
    function Controller(ctx, form, remotes) {
      this.ctx = ctx;
      this.form = form || null;
      this.remotes = remotes;
      this.store = createCardStore(createInitialState());
      this.disposed = false;
      this.pollTimer = undefined;
      var self = this;
      this.unsubscribe = null;
      if (this.form && typeof this.form.subscribe === 'function') {
        try {
          this.unsubscribe = this.form.subscribe(function () { self.deriveFromForm(); });
        } catch (e) {
          this.unsubscribe = null;
        }
      }
      this.deriveFromForm();
      this.reloadSettings();
      this.refreshLive();
      this.pollTimer = setInterval(function () {
        self.refreshLive();
        self.reloadSettings();
      }, 5000);
      if (this.pollTimer && this.pollTimer.unref) this.pollTimer.unref();
    }
    // configForms 可用时：标准通道派生开关（宿主会随写入/热重载推送新快照）。
    Controller.prototype.deriveFromForm = function () {
      if (this.disposed) return;
      if (!this.form || typeof this.form.getSnapshot !== 'function') return;
      var snap;
      try {
        snap = this.form.getSnapshot();
      } catch (e) {
        return;
      }
      var prev = this.store.getSnapshot();
      if (snap.status === 'ready') {
        var value = snap.value || {};
        this.store.set({
          settingsStatus: 'ready',
          enabled: value.backgroundRunEnabled === true,
          writable: snap.writable === true,
          saveFailed: prev.saveFailed,
        });
      } else if (snap.status === 'loading') {
        // 还在加载：保持 loading，不吞掉 Remote 兜底已拿到的值。
        if (prev.settingsStatus !== 'ready') {
          this.store.set({ settingsStatus: 'loading', enabled: false, writable: false, saving: false, saveFailed: false });
        }
      }
      // 其它状态（unavailable 等）：不动，等 Remote 兜底（reloadSettings）决定。
      // 注意：derive 绝不主动把 ready 打回 loading/unavailable ——
      // 之前版本里 form 短暂抖动会吞掉已拿到的开关值，导致“未启用 + 保存失败”假象。
    };
    // Remote 兜底（at-file 同款模式）：经 backgroundRunStatus 的
    // getSettings 读宿主侧真实值；configForms 不可用/未 ready 时这是兜底通道。
    Controller.prototype.reloadSettings = function () {
      var self = this;
      if (this.disposed) return Promise.resolve();
      var remote = self.remotes;
      if (!remote || typeof remote.getSettings !== 'function') return Promise.resolve();
      try {
        return remote.getSettings().then(function (res) {
          if (self.disposed || !res) return;
          // 解开 RPC 信封 {ok, value} → 业务结果 {ok, value:{backgroundRunEnabled}, writable}
          var business = unwrapEnvelope(res);
          if (business && typeof business === 'object' && business.ok === false) return;
          var value = business && business.value !== undefined ? business.value : business;
          if (!value || typeof value !== 'object') return;
          self.store.set({
            settingsStatus: 'ready',
            enabled: value.backgroundRunEnabled === true,
            writable: business && business.writable !== undefined ? business.writable !== false : true,
            saving: false,
          });
        }).catch(function () { /* 兜底通道失败不打断开关，保留 configForms 的值 */ });
      } catch (e) {
        return Promise.resolve();
      }
    };
    Controller.prototype.toggle = function () {
      var self = this;
      var snap = this.store.getSnapshot();
      if (snap.settingsStatus !== 'ready' || !snap.writable || snap.saving) {
        return Promise.resolve();
      }
      var prevEnabled = snap.enabled;
      var next = !prevEnabled;
      this.store.set({ enabled: next, saving: true, saveFailed: false, saveError: null });
      // 主通道（需求 §4 B4/B9）：configForms.mutate + **多段路径数组**。
      // ConfigForm.set(field, value) 内部是 mutate([{op:'set', path:[field], …}])，
      // 把 field 整个当作**一个**路径段；宿主按 schema.dict['a.b'] 查表必然查不到，
      // 于是**静默拒写**（返回 false，不抛错）。所以这里显式给出 path 数组，
      // 并在写后从 **user 原始层** 回读确认（继承值恰好相等不算写入成功）。
      var formReady = false;
      if (this.form && typeof this.form.mutate === 'function') {
        try {
          var formSnap = this.form.getSnapshot();
          formReady = !!formSnap && formSnap.status === 'ready' && formSnap.writable !== false;
        } catch (e) {
          formReady = false;
        }
      }
      var p = null;
      if (formReady) {
        try {
          p = this.form.mutate([{ op: 'set', path: ['backgroundRunEnabled'], value: next }]).then(function (acceptedByHost) {
            var landed = null;
            try { landed = self.form.getSnapshot(); } catch (e) { landed = null; }
            var userLayer = landed && landed.user;
            var inUserLayer = !!(userLayer && typeof userLayer === 'object' && userLayer.backgroundRunEnabled === next);
            if (acceptedByHost === false || !inUserLayer) {
              // 宿主明确拒绝（revision 冲突 / 字段非 volatile / 条目未绑定）时
              // 必须把原因显示出来，不能让开关自己弹回去却没有任何解释。
              throw new Error('宿主拒绝写入 backgroundRunEnabled（revision 冲突或字段不可写）');
            }
            return landed;
          });
        } catch (e) {
          p = null;
        }
      }
      if (!p && this.remotes && typeof this.remotes.updateSettings === 'function') {
        try {
          p = this.remotes.updateSettings({ field: 'backgroundRunEnabled', value: next }).then(function (res) {
            // 解开 RPC 信封 → 业务结果；业务失败（ok:false）才视为失败
            var business = unwrapEnvelope(res);
            if (business && typeof business === 'object' && business.ok === false) {
              throw new Error((business.error && business.error.message) || 'update failed');
            }
            return business;
          });
        } catch (e) {
          p = null;
        }
      }
      if (!p) {
        if (!self.disposed) self.store.set({ enabled: prevEnabled, saving: false, saveFailed: true, saveError: null });
        return Promise.resolve();
      }
      return p.then(function () {
        if (self.disposed) return;
        self.store.set({ saving: false, saveFailed: false, saveError: null });
        // 以宿主侧真实值为准（configForms 优先，Remote 兜底再拉一次）。
        if (self.form && typeof self.form.getSnapshot === 'function') {
          try {
            var landed = self.form.getSnapshot();
            if (landed && landed.status === 'ready') {
              var landedValue = (((landed.value || {}).backgroundRunEnabled) === true);
              if (landedValue !== next) {
                // 镜像还没追上写操作（revision fence）：等 mirror 回放再定，
                // 先保持乐观值，别立刻打脸用户。
                self.reloadSettings();
                self.refreshLive();
                return;
              }
              self.store.set({ enabled: landedValue });
            }
          } catch (e) { /* 忽略，用 Remote 校验 */ }
        }
        self.reloadSettings();
        self.refreshLive();
      }).catch(function (e) {
        if (self.disposed) return;
        self.store.set({ enabled: prevEnabled, saving: false, saveFailed: true, saveError: errText(e) });
      });
    };
    Controller.prototype.refreshLive = function () {
      var self = this;
      if (this.disposed) return Promise.resolve();
      var remote = self.remotes;
      if (!remote || typeof remote.status !== 'function') return Promise.resolve();
      try {
        // 0.2.0（需求 §4 B11）：不再捎带 __diag 诊断串（宿主侧的回传落盘链路已删除）。
        return remote.status({}).then(function (live) {
          if (self.disposed) return;
          // 解开 RPC 信封 {ok, value} → 状态快照
          var snapshot = unwrapEnvelope(live);
          if (snapshot && typeof snapshot === 'object' && snapshot.state) {
            self.store.set({ live: snapshot });
          } else if (live) {
            self.store.set({ live: live });
          }
        }).catch(function () { /* 状态读取失败不打断开关，保持上次快照 */ });
      } catch (e) {
        return Promise.resolve();
      }
    };
    Controller.prototype.dispose = function () {
      this.disposed = true;
      if (this.unsubscribe) {
        try { this.unsubscribe(); } catch (e) { /* ignore */ }
      }
      if (this.pollTimer) clearInterval(this.pollTimer);
    };

    // ── page ────────────────────────────────────────────────────────────
    function h(type, props) {
      var args = [type, props];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return React.createElement.apply(React, args);
    }

    function BackgroundRunSection(props) {
      // 与 myrules 一致：slot shell 可能给也可能不给 t，兜底用 apply 时绑定的 tRef。
      var t = (props && props.t) || tRef || function (key) { return key; };
      var controller = (props && props.controller) || controllerRef;
      var fallback = createInitialState();
      fallback.settingsStatus = 'unavailable';
      var state;
      try {
        state = React.useSyncExternalStore(
          function (l) { return controller.store.subscribe(l); },
          function () { return controller.store.getSnapshot(); },
          function () { return controller.store.getSnapshot(); }
        );
      } catch (e) {
        state = fallback;
      }
      if (!state || state.settingsStatus === 'loading') {
        return h('div', { className: 'bgr-wrap' },
          h('div', { className: 'bgr-title' }, t('title')),
          h('div', { className: 'bgr-sub' }, t('hint')),
          h('hr', { className: 'bgr-divider' }),
          h('div', { className: 'bgr-hint', role: 'status' }, t('loading')));
      }
      if (state.settingsStatus === 'unavailable') {
        return h('div', { className: 'bgr-wrap' },
          h('div', { className: 'bgr-title' }, t('title')),
          h('div', { className: 'bgr-sub' }, t('hint')),
          h('hr', { className: 'bgr-divider' }),
          h('div', { className: 'bgr-hint', role: 'status' }, t('unavailable')));
      }
      var live = state.live;
      var running = live ? live.activeTasks > 0 : false;
      var powerHeld = live ? live.powerHeld === true : false;
      var online = live ? live.networkOnline !== false : true;
      var showPowerFailed = state.enabled && live && !powerHeld && running;
      var onToggle = function () { controller.toggle(); };
      var onRetry = function () { controller.toggle(); };
      return h('div', { className: 'bgr-wrap' },
        h('div', { className: 'bgr-title' }, t('title')),
        h('div', { className: 'bgr-sub' }, t('hint')),
        h('hr', { className: 'bgr-divider' }),
        h('div', { className: 'bgr-block' },
          h('div', { className: 'bgr-block-head' },
            h('span', { className: 'bgr-block-title' }, t('blockTitle'))),
          h('label', { className: 'bgr-card' },
            h('input', {
              type: 'checkbox',
              className: 'bgr-checkbox',
              checked: state.enabled,
              disabled: !state.writable || state.saving,
              onChange: onToggle,
            }),
            h('span', { className: 'bgr-card-text' },
              h('span', { className: 'bgr-card-title' }, t('toggleLabel')),
              h('span', { className: 'bgr-card-desc' }, t('toggleDesc')))),
          h('div', { className: 'bgr-status', role: 'status', 'aria-live': 'polite' },
            h('div', { className: state.enabled ? 'bgr-ok' : '' }, t(state.enabled ? 'statusEnabled' : 'statusDisabled')),
            state.enabled ? h('div', null, t(powerHeld ? 'powerActive' : 'powerIdle')) : null,
            state.enabled ? h('div', null, t(running ? 'taskRunning' : 'taskIdle')) : null,
            state.enabled ? h('div', { className: online ? '' : 'bgr-err' }, t(online ? 'netOnline' : 'netOffline')) : null,
            state.enabled && live && live.runningJobs > 0
              ? h('div', null, fmt(t('jobsLine'), { count: live.runningJobs }))
              : null,
            live && live.backendNote && !state.enabled
              ? h('div', { className: 'bgr-note', role: 'note' }, t('unsupportedNote'))
              : null,
            showPowerFailed ? h('div', { className: 'bgr-err', role: 'alert' }, t('powerFailed')) : null,
            !online && state.enabled ? h('div', { className: 'bgr-err', role: 'alert' }, t('netInterrupted')) : null,
            live && live.lastError ? h('div', { className: 'bgr-warn', role: 'alert' }, fmt(t('lastError'), { message: live.lastError })) : null,
            state.saveFailed
              ? h('div', { className: 'bgr-footer' },
                  h('span', { className: 'bgr-err', role: 'alert' }, saveErrorText(t, state.saveError)),
                  h('button', { type: 'button', className: 'bgr-btn', onClick: onRetry }, t('retry')))
              : null)));
    }

    // ── plugin face ─────────────────────────────────────────────────────
    // 对齐 pixel-skin：settings.section 左侧导航入口。不再注册 settings.plugin.item。
    // inject 用壳里存在的 slots/locale/remote 三件套 + `configForms`
    // （DSH 0.1.7-rc.2 起 `settingsScope` 更名为 `configForms`，见需求 §4 B4）。
    // 开关读写主通道走 configForms，缺失时降级走 Remote（经 index.ts 的
    // getSettings/updateSettings 兜底方法），两条路都进同一个 store。
    var inject = ['slots', 'locale', 'remote', 'configForms'];
    function apply(ctx) {
      ctx.locale.register(NS, { zh: zh, en: en });
      tRef = ctx.locale.bind(NS);
      var remoteStatus = null;
      var settingsRemote = null;
      var mountP = null;
      try {
        // 超时兜底：不合规的 contribution 会让 $mount 既不 resolve 也不 reject，
        // 没有上限时状态区永远停在「正在连接」。
        mountP = withTimeout(ctx.remote.$mount(REMOTE_CONTRIBUTION), MOUNT_TIMEOUT_MS);
      } catch (e) {
        mountP = null;
      }
      function afterMount() {
        var mounted = null;
        try {
          mounted = ctx.reflect.get('remote.backgroundRunStatus');
        } catch (e) {
          mounted = null;
        }
        if (mounted && typeof mounted.status === 'function') {
          remoteStatus = mounted;
          if (typeof mounted.getSettings === 'function') settingsRemote = mounted;
        }
        if (controllerRef) {
          controllerRef.refreshLive();
          controllerRef.reloadSettings();
        }
      }
      if (mountP && typeof mountP.then === 'function') {
        mountP.then(afterMount).catch(function () { /* 状态通道不可用时降级显示，开关不受影响 */ });
      }
      // 命名空间 = Loader 条目 id（dsh-settings 以 entries() 的 options.id 匹配）；
      // 因此该插件的 profile 条目 id 必须恰好是 'background-run'。
      var form = null;
      try {
        if (ctx.configForms && typeof ctx.configForms.get === 'function') {
          form = ctx.configForms.get(SETTINGS_NS);
        }
      } catch (e) {
        form = null;
      }
      var controller = new Controller(ctx, form, {
        status: function (input) {
          if (remoteStatus) return remoteStatus.status(input);
          return Promise.resolve(null);
        },
        getSettings: function () {
          if (settingsRemote) return settingsRemote.getSettings({});
          return Promise.resolve(null);
        },
        updateSettings: function (update) {
          if (settingsRemote) return settingsRemote.updateSettings(update);
          return Promise.resolve(null);
        },
      });
      controllerRef = controller;
      ctx.effect(function () {
        return function () {
          controller.dispose();
          if (controllerRef === controller) controllerRef = null;
        };
      }, 'background-run: section lifecycle');
      // 左侧导航入口（仿 myrules）：id + order + label，页面组件用闭包读 controller。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'background-run',
          order: 60,
          label: function () { return tRef('nav'); },
          locale: NS,
          inject: function () { return { t: tRef, controller: controller }; },
        }, BackgroundRunSection);
      });
    }
    module.exports = { apply: apply, inject: inject, NS: NS };
    return module.exports;
  },
});
