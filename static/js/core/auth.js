import { KEYS, readLocal, writeLocal } from './storage.js';
import { getDb, findUser, publicUser } from './db.js';
import { emit } from './bus.js';

const DEFAULT_USER = 'u_me';

export function session() {
    const stored = readLocal(KEYS.session, null);
    if (stored && stored.userId) return stored;
    return { userId: DEFAULT_USER, at: new Date().toISOString() };
}

export function currentUserId() {
    const db = getDb();
    const id = session().userId;
    return (db.users || []).some((u) => u.id === id) ? id : DEFAULT_USER;
}

export function currentUser() {
    return findUser(getDb(), currentUserId());
}

export function currentPublicUser() {
    return publicUser(currentUser());
}

export function isOps() {
    return currentUser()?.role === 'ops';
}

export function isSelf(userId) {
    return userId === currentUserId();
}

/** 切换演示账号（真实系统中对应登录 / 退出） */
export function loginAs(userId) {
    writeLocal(KEYS.session, { userId, at: new Date().toISOString() });
    emit('auth:change', { userId });
}

export function logout() {
    loginAs(DEFAULT_USER);
}

export function demoAccounts() {
    return (getDb().users || []).filter((u) => u.demo).map(publicUser);
}

export function canManage(userId) {
    return isOps() || isSelf(userId);
}
