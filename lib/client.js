/* DSH 后台运行插件 - 浏览器侧设置页面（左侧导航独立入口，仿 dsh-myrules）。
 * ModuleLoader 工厂格式。开关写入走标准 settings 通道，
 * 状态展示走宿主侧 backgroundRunStatus 只读快照。
 *
 * 注册 settings.section（id `background-run`）：设置页左侧导航出现「后台运行」，
 * 点进去是整页开关 + 实时状态（电源保持 / 当前任务 / 后台任务 / 网络）。
 * 不再注册 settings.plugin.item，避免与「插件」页卡片重复。
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
    function passthroughCodec(typeSymbol) {
      return { mode: 'strict', typeSymbol: typeSymbol, schema: { parse: function (value) { return value; } } };
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
    function Controller(ctx, scope, remotes) {
      this.ctx = ctx;
      this.scope = scope || null;
      this.remotes = remotes;
      this.store = createCardStore(createInitialState());
      this.disposed = false;
      this.pollTimer = undefined;
      var self = this;
      this.unsubscribe = null;
      this.diagLog = [];
      this.diagNote = function (msg) {
        try {
          self.diagLog.push(String(msg).slice(0, 300));
          if (self.diagLog.length > 24) self.diagLog.splice(0, self.diagLog.length - 24);
        } catch (e) { /* ignore */ }
      };
      this.diagNote('ctor host=' + (typeof location !== 'undefined' ? location.host : '?') + ' scope=' + (scope ? 'yes' : 'NULL') + ' remotes.updateSettings=' + (typeof (remotes && remotes.updateSettings)) + ' remotes.getSettings=' + (typeof (remotes && remotes.getSettings)));
      if (this.scope && typeof this.scope.subscribe === 'function') {
        try {
          this.unsubscribe = this.scope.subscribe(function () { self.deriveFromScope(); });
        } catch (e) {
          this.unsubscribe = null;
        }
      }
      this.deriveFromScope();
      this.reloadSettings();
      this.refreshLive();
      this.pollTimer = setInterval(function () {
        self.refreshLive();
        self.reloadSettings();
      }, 5000);
      if (this.pollTimer && this.pollTimer.unref) this.pollTimer.unref();
    }
    // settingsScope 可用时：标准通道派生开关（image-gen 同款 scope 语义）。
    Controller.prototype.deriveFromScope = function () {
      if (this.disposed) return;
      if (!this.scope || typeof this.scope.getSnapshot !== 'function') return;
      var snap;
      try {
        snap = this.scope.getSnapshot();
      } catch (e) {
        return;
      }
      var prev = this.store.getSnapshot();
      if (snap.status === 'ready') {
        var value = snap.value || {};
        this.diagNote('derive: scope=ready value=' + JSON.stringify(value).slice(0, 120) + ' writable=' + (snap.writable === true) + ' => enabled=' + (value.backgroundRunEnabled === true) + ' (prev.enabled=' + prev.enabled + ')');
        this.store.set({
          settingsStatus: 'ready',
          enabled: value.backgroundRunEnabled === true,
          writable: snap.writable === true,
          saveFailed: prev.saveFailed,
        });
      } else if (snap.status === 'loading') {
        // 还在加载：保持 loading，不吞掉 Remote 兜底已拿到的值。
        this.diagNote('derive: scope=loading (prev.settingsStatus=' + prev.settingsStatus + ', prev.enabled=' + prev.enabled + ')' + (prev.settingsStatus !== 'ready' ? ' => RESET enabled=false' : ' => skip'));
        if (prev.settingsStatus !== 'ready') {
          this.store.set({ settingsStatus: 'loading', enabled: false, writable: false, saving: false, saveFailed: false });
        }
      } else {
        this.diagNote('derive: scope=' + snap.status + ' (skip)');
      }
      // 其它状态：不动，等 Remote 兜底（reloadSettings）决定。
      // 注意：derive 绝不主动把 ready 打回 loading/unavailable ——
      // 之前版本里 scope 短暂抖动会吞掉已拿到的开关值，导致“未启用 + 保存失败”假象。
    };
    // Remote 兜底（at-file 同款模式）：经 backgroundRunStatus 的
    // getSettings 读宿主侧真实值；settingsScope 缺失/不可写时这是主通道。
    Controller.prototype.reloadSettings = function () {
      var self = this;
      if (this.disposed) return Promise.resolve();
      var remote = self.remotes;
      if (!remote || typeof remote.getSettings !== 'function') return Promise.resolve();
      try {
        return remote.getSettings().then(function (res) {
          if (self.disposed || !res) { self.diagNote('reload: res=' + JSON.stringify(res).slice(0, 100)); return; }
          // 解开 RPC 信封 {ok, value} → 业务结果 {ok, value:{backgroundRunEnabled}, writable}
          var business = unwrapEnvelope(res);
          if (business && typeof business === 'object' && business.ok === false) {
            self.diagNote('reload: business ok=false ' + JSON.stringify(business.error || {}).slice(0, 120));
            return;
          }
          var value = business && business.value !== undefined ? business.value : business;
          if (!value || typeof value !== 'object') { self.diagNote('reload: bad value=' + JSON.stringify(res).slice(0, 120)); return; }
          self.diagNote('reload: ok value=' + JSON.stringify(value).slice(0, 100) + ' => enabled=' + (value.backgroundRunEnabled === true));
          self.store.set({
            settingsStatus: 'ready',
            enabled: value.backgroundRunEnabled === true,
            writable: business && business.writable !== undefined ? business.writable !== false : true,
            saving: false,
          });
        }).catch(function (e) { self.diagNote('reload: REJECTED ' + errText(e).slice(0, 160)); });
      } catch (e) {
        self.diagNote('reload: SYNC THROW ' + errText(e).slice(0, 120));
        return Promise.resolve();
      }
    };
    Controller.prototype.toggle = function () {
      var self = this;
      var snap = this.store.getSnapshot();
      if (snap.settingsStatus !== 'ready' || !snap.writable || snap.saving) {
        self.diagNote('toggle: IGNORED status=' + snap.settingsStatus + ' writable=' + snap.writable + ' saving=' + snap.saving);
        return Promise.resolve();
      }
      var prevEnabled = snap.enabled;
      var next = !prevEnabled;
      this.diagNote('toggle: START prev=' + prevEnabled + ' next=' + next);
      this.store.set({ enabled: next, saving: true, saveFailed: false, saveError: null });
      // 优先标准通道（settingsScope），不可用时走 Remote 兜底。
      var p = null;
      if (this.scope && typeof this.scope.set === 'function') {
        try {
          p = this.scope.set('backgroundRunEnabled', next);
          this.diagNote('toggle: channel=scope.set (promise)');
        } catch (e) {
          p = null;
          this.diagNote('toggle: scope.set SYNC THROW ' + errText(e).slice(0, 140));
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
            self.diagNote('toggle: updateSettings business=' + JSON.stringify(business).slice(0, 140));
            return business;
          });
          this.diagNote('toggle: channel=remote.updateSettings');
        } catch (e) {
          p = null;
          this.diagNote('toggle: updateSettings SYNC THROW ' + errText(e).slice(0, 140));
        }
      }
      if (!p) {
        this.diagNote('toggle: NO CHANNEL => instant revert');
        if (!self.disposed) self.store.set({ enabled: prevEnabled, saving: false, saveFailed: true, saveError: null });
        return Promise.resolve();
      }
      return p.then(function () {
        if (self.disposed) return;
        self.diagNote('toggle: write promise RESOLVED (next=' + next + ')');
        self.store.set({ saving: false, saveFailed: false, saveError: null });
        // 以宿主侧真实值为准（两种通道都重新拉一次）。
        if (self.scope && typeof self.scope.getSnapshot === 'function') {
          try {
            var landed = self.scope.getSnapshot();
            if (landed && landed.status === 'ready') {
              var landedValue = (((landed.value || {}).backgroundRunEnabled) === true);
              self.diagNote('toggle: landed scope ready value=' + JSON.stringify(landed.value).slice(0, 100) + ' landedValue=' + landedValue);
              if (landedValue !== next) {
                // 镜像还没追上写操作（revision  fence）：等 mirror 回放再定，
                // 先保持乐观值，别立刻打脸用户。
                self.reloadSettings();
                self.refreshLive();
                return;
              }
              self.store.set({ enabled: landedValue });
            } else {
              self.diagNote('toggle: landed scope status=' + (landed && landed.status));
            }
          } catch (e) { /* 忽略，用 Remote 校验 */ }
        }
        self.reloadSettings();
        self.refreshLive();
      }).catch(function (e) {
        if (self.disposed) return;
        self.diagNote('toggle: write promise REJECTED ' + errText(e).slice(0, 200));
        self.store.set({ enabled: prevEnabled, saving: false, saveFailed: true, saveError: errText(e) });
      });
    };
    Controller.prototype.refreshLive = function () {
      var self = this;
      if (this.disposed) return Promise.resolve();
      var remote = self.remotes;
      if (!remote || typeof remote.status !== 'function') return Promise.resolve();
      try {
        var diagPayload;
        if (self.diagLog && self.diagLog.length > 0) {
          diagPayload = self.diagLog.splice(0, self.diagLog.length).join(' | ');
        }
        var snap = this.store.getSnapshot();
        var input = {};
        if (diagPayload) {
          input.__diag = 'store[' + snap.settingsStatus + ' enabled=' + snap.enabled + ' writable=' + snap.writable + '] ' + diagPayload;
        }
        return remote.status(input).then(function (live) {
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
    // inject 只用壳里一定存在的 slots/locale/remote 三件套（pixel-skin 同款），
    // 开关读写先走 settingsScope（标准通道），缺失时降级走 Remote（经 index.ts
    // 里新增的 getSettings/updateSettings 方法），两种路都拿到快照后进同一个 store。
    var inject = ['slots', 'locale', 'remote'];
    function apply(ctx) {
      ctx.locale.register(NS, { zh: zh, en: en });
      tRef = ctx.locale.bind(NS);
      var remoteStatus = null;
      var settingsRemote = null;
      var mountP = null;
      try {
        mountP = ctx.remote.$mount(REMOTE_CONTRIBUTION);
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
      var scope = null;
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') {
          scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
        }
      } catch (e) {
        scope = null;
      }
      var controller = new Controller(ctx, scope, {
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
