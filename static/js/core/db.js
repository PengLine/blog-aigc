import { KEYS, SCHEMA_VERSION, readLocal, writeLocal, removeLocal } from './storage.js';
import { buildSeed } from '../data/seed.js';
import { uid } from './format.js';
import { emit, EVENTS } from './bus.js';

let cache = null;

/** 读取数据库（首次访问自动写入种子数据） */
export function getDb() {
    if (cache) return cache;
    const stored = readLocal(KEYS.db);
    if (!stored || stored.version !== SCHEMA_VERSION || !Array.isArray(stored.users)) {
        cache = buildSeed();
        persist();
    } else {
        cache = stored;
    }
    return cache;
}

function persist() {
    writeLocal(KEYS.db, cache);
}

/** 事务式写入：fn 内直接修改 db，结束后持久化 */
export function mutate(fn) {
    const db = getDb();
    const result = fn(db);
    db.updatedAt = new Date().toISOString();
    persist();
    return result;
}

export function saveDb(db) {
    cache = db;
    persist();
}

export function resetDb() {
    removeLocal(KEYS.db);
    cache = null;
    return getDb();
}

export function findUser(db, id) {
    return (db.users || []).find((u) => u.id === id) || (db.users || [])[0] || null;
}

export function publicUser(user) {
    if (!user) {
        return {
            id: 'u_unknown',
            name: '未知用户',
            handle: 'unknown',
            avatar: '',
            bio: '',
            level: 1,
            followers: 0,
            following: 0,
            worksCount: 0,
            likesReceived: 0,
            verified: false,
            plan: 'free',
            joinedAt: new Date().toISOString(),
            tags: []
        };
    }
    const { credits, ...rest } = user;
    return rest;
}

export function getAccount(userId) {
    const db = getDb();
    const user = findUser(db, userId);
    const plan = user.plan || 'free';
    return {
        user: publicUser(user),
        credits: user.credits || 0,
        plan,
        computeUsed: user.computeUsed || 0,
        nextResetAt: user.creditsResetAt || null
    };
}

export function addNotification(db, payload) {
    const item = {
        id: uid('n'),
        userId: payload.userId,
        type: payload.type || 'system',
        tone: payload.tone || 'brand',
        title: payload.title || '系统通知',
        body: payload.body || '',
        link: payload.link || '',
        read: false,
        createdAt: new Date().toISOString()
    };
    db.notifications.unshift(item);
    db.notifications = db.notifications.slice(0, 200);
    emit(EVENTS.notify, item);
    return item;
}

export function unreadCount(userId) {
    const db = getDb();
    return (db.notifications || []).filter((n) => n.userId === userId && !n.read).length;
}

export function addTransaction(db, userId, payload) {
    const user = findUser(db, userId);
    const amount = Number(payload.amount) || 0;
    user.credits = Number(user.credits || 0) + amount;
    const tx = {
        id: uid('tx'),
        userId,
        type: payload.type,
        amount,
        balanceAfter: user.credits,
        title: payload.title || '账户变动',
        refId: payload.refId || '',
        createdAt: new Date().toISOString()
    };
    db.transactions.unshift(tx);
    db.transactions = db.transactions.slice(0, 300);
    emit(EVENTS.credits, { userId, credits: user.credits, amount });
    return tx;
}

export function spendCredits(db, userId, amount, title, refId = '') {
    const user = findUser(db, userId);
    const cost = Number(amount) || 0;
    if (cost <= 0) return null;
    if ((user.credits || 0) < cost) {
        const err = new Error(`算力积分不足，还差 ${cost - (user.credits || 0)} 点`);
        err.code = 'INSUFFICIENT_CREDITS';
        throw err;
    }
    return addTransaction(db, userId, { type: 'consume', amount: -cost, title, refId });
}

export function nowIso() {
    return new Date().toISOString();
}
