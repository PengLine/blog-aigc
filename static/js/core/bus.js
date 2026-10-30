/**
 * 极简事件总线：用于任务进度、数据变更等跨组件通知。
 */
const listeners = new Map();

export function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
}

export function off(event, handler) {
    const set = listeners.get(event);
    if (set) set.delete(handler);
}

export function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    [...set].forEach((handler) => {
        try {
            handler(payload);
        } catch (err) {
            console.error(`[bus] ${event} 处理器异常`, err);
        }
    });
}

export function once(event, handler) {
    const unwrap = (payload) => {
        off(event, unwrap);
        handler(payload);
    };
    return on(event, unwrap);
}

export const EVENTS = {
    taskUpdate: 'task:update',
    dataChange: 'data:change',
    credits: 'account:credits',
    notify: 'notify:new'
};
