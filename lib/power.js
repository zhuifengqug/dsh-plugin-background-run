import { createRequire } from 'node:module';
export const ES_CONTINUOUS = 0x80000000;
export const ES_SYSTEM_REQUIRED = 0x00000001;
export const ES_DISPLAY_REQUIRED = 0x00000002;
function tryLoadWin32() {
    if (process.platform !== 'win32') {
        return {
            error: `unsupported platform: ${process.platform}（仅 Windows 10/11 支持电源保持）`
        };
    }
    let koffi;
    try {
        const require = createRequire(import.meta.url);
        koffi = require('koffi');
    } catch (error) {
        return {
            error: `无法加载 koffi FFI 模块：${String(error)}`
        };
    }
    try {
        const kernel32 = koffi.load('kernel32.dll');
        const fn = kernel32.func('SetThreadExecutionState', 'uint32', [
            'uint32'
        ]);
        fn(ES_CONTINUOUS);
        return {
            fn
        };
    } catch (error) {
        return {
            error: `无法绑定 kernel32.SetThreadExecutionState：${String(error)}`
        };
    }
}
class Win32PowerHandle {
    kind = 'win32-koffi';
    fn;
    onError;
    held = false;
    constructor(fn, onError){
        this.fn = fn;
        this.onError = onError;
    }
    acquire() {
        if (this.held) return {
            ok: true
        };
        try {
            this.fn(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            this.held = true;
            return {
                ok: true
            };
        } catch (error) {
            const message = `申请 Windows 电源保持失败：${String(error)}`;
            this.onError(message);
            return {
                ok: false,
                error: message
            };
        }
    }
    release() {
        if (!this.held) return {
            ok: true
        };
        try {
            this.fn(ES_CONTINUOUS);
            this.held = false;
            return {
                ok: true
            };
        } catch (error) {
            const message = `释放 Windows 电源保持失败：${String(error)}`;
            this.onError(message);
            this.held = false;
            return {
                ok: false,
                error: message
            };
        }
    }
}
class UnsupportedPowerHandle {
    kind = 'unsupported';
    held = false;
    acquire() {
        return {
            ok: false,
            error: '当前系统不支持后台电源保持，DSH 仍可运行，但电脑进入睡眠后任务可能暂停。'
        };
    }
    release() {
        return {
            ok: true
        };
    }
}
export function createPowerHandle(onError) {
    const loaded = tryLoadWin32();
    if (!loaded.fn) {
        return {
            handle: new UnsupportedPowerHandle(),
            loadError: loaded.error
        };
    }
    return {
        handle: new Win32PowerHandle(loaded.fn, onError)
    };
}
