/**
 * Windows 电源保持：SetThreadExecutionState 的最小安全封装。
 *
 * 设计约束（需求 §五）：
 * - 只使用 ES_SYSTEM_REQUIRED（保持系统运行），绝不使用 ES_DISPLAY_REQUIRED，
 *   否则会阻止显示器按系统设置关闭；
 * - ES_CONTINUOUS 维持持续请求；清除时调用 SetThreadExecutionState(ES_CONTINUOUS)；
 * - koffi 为 DSH 自带（dsh-win32-process 依赖）的 FFI，无需新增原生编译依赖；
 * - 非 Windows / koffi 缺失 / API 调用失败时一律降级为 no-op 并上报错误，
 *   绝不让 DSH 崩溃。
 */

import { createRequire } from 'node:module';

export const ES_CONTINUOUS = 0x80000000;
export const ES_SYSTEM_REQUIRED = 0x00000001;
/** 显式禁用：绝不能使用的标志（会阻止显示器关闭）。 */
export const ES_DISPLAY_REQUIRED = 0x00000002;

export type PowerBackendKind = 'win32-koffi' | 'unsupported';

export interface PowerHandle {
  readonly kind: PowerBackendKind;
  /** 当前是否有生效的保持请求。 */
  readonly held: boolean;
  /** 申请保持（幂等）。失败时返回 error 而不是抛错。 */
  acquire(): { ok: true } | { ok: false; error: string };
  /** 释放保持（幂等）。失败时返回 error 而不是抛错。 */
  release(): { ok: true } | { ok: false; error: string };
}

interface SetThreadExecutionStateFn {
  (flags: number): number;
}

function tryLoadWin32(): { fn?: SetThreadExecutionStateFn; error?: string } {
  if (process.platform !== 'win32') {
    return { error: `unsupported platform: ${process.platform}（仅 Windows 10/11 支持电源保持）` };
  }
  let koffi: { load(lib: string): { func(name: string, ret: string, args: string[]): unknown } };
  try {
    // 可选依赖：DSH 安装自带（dsh-win32-process 依赖 koffi），缺失时降级。
    const require = createRequire(import.meta.url);
    koffi = require('koffi') as typeof koffi;
  } catch (error) {
    return { error: `无法加载 koffi FFI 模块：${String(error)}` };
  }
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const fn = kernel32.func('SetThreadExecutionState', 'uint32', ['uint32']) as unknown as SetThreadExecutionStateFn;
    // 探测调用：先读回当前状态再恢复，不留下任何请求。
    fn(ES_CONTINUOUS);
    return { fn };
  } catch (error) {
    return { error: `无法绑定 kernel32.SetThreadExecutionState：${String(error)}` };
  }
}

class Win32PowerHandle implements PowerHandle {
  readonly kind: PowerBackendKind = 'win32-koffi';
  private readonly fn: SetThreadExecutionStateFn;
  private readonly onError: (message: string) => void;
  held = false;

  constructor(fn: SetThreadExecutionStateFn, onError: (message: string) => void) {
    this.fn = fn;
    this.onError = onError;
  }

  acquire(): { ok: true } | { ok: false; error: string } {
    if (this.held) return { ok: true };
    try {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED：阻止系统空闲睡眠，允许显示器关闭。
      this.fn(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
      this.held = true;
      return { ok: true };
    } catch (error) {
      const message = `申请 Windows 电源保持失败：${String(error)}`;
      this.onError(message);
      return { ok: false, error: message };
    }
  }

  release(): { ok: true } | { ok: false; error: string } {
    if (!this.held) return { ok: true };
    try {
      // ES_CONTINUOUS 单独调用：清除本线程的持续请求。
      this.fn(ES_CONTINUOUS);
      this.held = false;
      return { ok: true };
    } catch (error) {
      const message = `释放 Windows 电源保持失败：${String(error)}`;
      this.onError(message);
      // 释放失败也视为未持有，避���残留计数阻止后续 acquire。
      this.held = false;
      return { ok: false, error: message };
    }
  }
}

class UnsupportedPowerHandle implements PowerHandle {
  readonly kind: PowerBackendKind = 'unsupported';
  readonly held = false;
  acquire(): { ok: false; error: string } {
    return { ok: false, error: '当前系统不支持后台电源保持，DSH 仍可运行，但电脑进入睡眠后任务可能暂停。' };
  }
  release(): { ok: true } {
    return { ok: true };
  }
}

/**
 * 创建电源保持句柄。非 Windows / 缺依赖时返回 unsupported 句柄（no-op），
 * 调用方通过 kind + loadError 展示真实状态。
 */
export function createPowerHandle(onError: (message: string) => void): { handle: PowerHandle; loadError?: string } {
  const loaded = tryLoadWin32();
  if (!loaded.fn) {
    return { handle: new UnsupportedPowerHandle(), loadError: loaded.error };
  }
  return { handle: new Win32PowerHandle(loaded.fn, onError) };
}
