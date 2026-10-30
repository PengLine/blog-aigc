/**
 * 主题管理：跟随系统 / 强制浅色 / 强制暗色
 * 偏好写入 lingxi.aigc.prefs，各页面 head 的内联脚本会在首屏前还原，避免闪白。
 */
import { KEYS, readLocal, writeLocal } from './storage.js';

const MEDIA = '(prefers-color-scheme: dark)';
export const THEME_MODES = ['system', 'light', 'dark'];
export const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '暗色' };

function prefs() {
    return readLocal(KEYS.prefs, {}) || {};
}

/** 用户选择的模式，默认跟随系统 */
export function getThemeMode() {
    const mode = prefs().theme;
    return THEME_MODES.includes(mode) ? mode : 'system';
}

/** 当前真正生效的主题（解析「跟随系统」） */
export function effectiveTheme() {
    const mode = getThemeMode();
    if (mode !== 'system') return mode;
    return window.matchMedia && window.matchMedia(MEDIA).matches ? 'dark' : 'light';
}

/** 应用主题到 <html>，system 时移除属性交给媒体查询 */
export function applyTheme(mode) {
    const next = THEME_MODES.includes(mode) ? mode : 'system';
    if (next === 'system') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', next);
    }
    return next;
}

/** 记住偏好并立即生效 */
export function setThemeMode(mode) {
    const next = applyTheme(mode);
    try {
        writeLocal(KEYS.prefs, { ...prefs(), theme: next });
    } catch (err) {
        console.warn('[theme] 无法保存主题偏好', err);
    }
    return next;
}

/** 循环：跟随系统 → 浅色 → 暗色 */
export function cycleTheme() {
    const idx = THEME_MODES.indexOf(getThemeMode());
    return setThemeMode(THEME_MODES[(idx + 1) % THEME_MODES.length]);
}

/** 系统偏好变化时回调（仅在「跟随系统」下有意义） */
export function watchSystemTheme(handler) {
    if (!window.matchMedia) return () => {};
    const mq = window.matchMedia(MEDIA);
    const listener = () => handler(mq.matches ? 'dark' : 'light');
    if (mq.addEventListener) mq.addEventListener('change', listener);
    else if (mq.addListener) mq.addListener(listener);
    return () => {
        if (mq.removeEventListener) mq.removeEventListener('change', listener);
        else if (mq.removeListener) mq.removeListener(listener);
    };
}
