/**
 * 本地持久化封装
 * 所有数据统一挂在 lingxi.aigc.* 命名空间下，便于演示数据重置与迁移。
 */
const NS = 'lingxi.aigc';
// 种子数据结构变更时自增，旧数据会在下次访问自动重建
// v6：训练流水补齐「失败训练扣除」记录，余额与逐笔 balanceAfter 重新对账
export const SCHEMA_VERSION = 6;
export const KEYS = {
    db: `${NS}.db`,
    session: `${NS}.session`,
    prefs: `${NS}.prefs`,
    flag: `${NS}.flag`
};

export function readLocal(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        console.warn('[storage] 读取失败', key, err);
        return fallback;
    }
}

export function writeLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.warn('[storage] 写入失败', key, err);
        throw new Error('本地存储空间不足，请清理部分上传素材后重试');
    }
}

export function removeLocal(key) {
    try {
        localStorage.removeItem(key);
    } catch (err) {
        console.warn('[storage] 删除失败', key, err);
    }
}

export function clearAppStorage() {
    Object.values(KEYS).forEach(removeLocal);
}

export function storageSize() {
    let bytes = 0;
    Object.keys(localStorage).forEach((key) => {
        if (!key.startsWith(NS)) return;
        bytes += (localStorage.getItem(key) || '').length * 2;
    });
    return bytes;
}
