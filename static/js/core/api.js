/**
 * 模拟后端 API
 * ------------------------------------------------------------------
 * 与真实服务保持一致的接口形态：异步、分页、错误码、延迟。
 * 视图层只依赖本模块，未来替换为 fetch 即可无缝切换到真实后端。
 */
import { getDb, mutate, persist, findUser, publicUser, addNotification, addTransaction, spendCredits, resetDb, unreadCount } from './db.js';
import { currentUserId } from './auth.js';
import { emit, EVENTS } from './bus.js';
import { TASK_TYPES, taskCost, PLAN_MAP, RECHARGE_PACKAGES, MODEL_MAP } from './constants.js';
import { normalizeConfig, predictFault, configWarnings } from './training.js';
import { uid, sleep, fmtDate } from './format.js';

export class ApiError extends Error {
    constructor(message, code = 'BAD_REQUEST', status = 400) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
    }
}

const NET_MIN = 120;
const NET_MAX = 340;

function changed(scope) {
    // 任何数据变更都先落盘再广播，避免视图跳转后从 localStorage 读到旧数据（新建内容“消失”）
    if (getDb()) persist();
    emit(EVENTS.dataChange, { scope, at: Date.now() });
}

function latency() {
    return NET_MIN + Math.random() * (NET_MAX - NET_MIN);
}

async function respond(factory, { min = 0, max = 0 } = {}) {
    await sleep(latency() + (min ? min + Math.random() * (max - min) : 0));
    try {
        return factory();
    } catch (err) {
        if (err instanceof ApiError) throw err;
        console.error('[api]', err);
        throw new ApiError(err.message || '服务异常，请稍后重试', err.code || 'INTERNAL', 500);
    }
}

function clock() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function now() {
    return new Date().toISOString();
}

function pageOf(list, page = 1, pageSize = 12) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(pageSize) || 12);
    return {
        items: list.slice((p - 1) * size, p * size),
        total: list.length,
        page: p,
        pageSize: size,
        pages: Math.max(1, Math.ceil(list.length / size))
    };
}

function matchText(haystack, q) {
    if (!q) return true;
    return String(haystack || '').toLowerCase().includes(String(q).toLowerCase());
}

function enrichWork(db, work, me = currentUserId()) {
    if (!work) return null;
    return {
        ...work,
        author: publicUser(findUser(db, work.authorId)),
        liked: db.reactions.some((r) => r.userId === me && r.type === 'like' && r.workId === work.id),
        favorited: db.reactions.some((r) => r.userId === me && r.type === 'favorite' && r.workId === work.id),
        licensed: db.reactions.some((r) => r.userId === me && r.type === 'license' && r.workId === work.id),
        isMine: work.authorId === me
    };
}

function scoreOf(work) {
    return work.stats.likes * 3 + work.stats.favorites * 4 + work.stats.views / 40 + work.stats.remixes * 2;
}

function indexWork(db, work) {
    db.works.unshift(work);
    const author = findUser(db, work.authorId);
    if (author) author.worksCount = db.works.filter((w) => w.authorId === author.id && w.status === 'published').length;
    return work;
}

/* ============================ 作品 / 广场 ============================ */

export async function listWorks(query = {}) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const { q = '', kind = 'all', subtype = 'all', sort = 'recommended', page = 1, pageSize = 12, authorId = '', status = '' } = query;
        let list = db.works.slice();

        if (authorId) {
            list = list.filter((w) => w.authorId === authorId);
            if (status) {
                list = list.filter((w) => w.status === status);
            } else if (authorId !== me) {
                list = list.filter((w) => w.status === 'published');
            }
        } else {
            list = list.filter((w) => w.status === 'published');
            if (status) list = list.filter((w) => w.status === status);
        }

        if (kind !== 'all') list = list.filter((w) => w.kind === kind);
        if (subtype !== 'all') list = list.filter((w) => w.subtype === subtype);
        if (q) {
            list = list.filter(
                (w) => matchText(w.title, q) || matchText(w.desc, q) || matchText(w.tags.join(' '), q) || matchText(w.prompt, q)
            );
        }

        switch (sort) {
            case 'latest':
                list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                break;
            case 'popular':
                list.sort((a, b) => b.stats.views - a.stats.views);
                break;
            case 'likes':
                list.sort((a, b) => b.stats.likes - a.stats.likes);
                break;
            case 'oldest':
                list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                break;
            default:
                list.sort((a, b) => scoreOf(b) - scoreOf(a));
        }

        const paged = pageOf(list, page, pageSize);
        return { ...paged, items: paged.items.map((w) => enrichWork(db, w, me)) };
    });
}

export async function getWork(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === id);
        if (!work) throw new ApiError('作品不存在或已被删除', 'NOT_FOUND', 404);
        if (work.status !== 'published' && work.authorId !== me && me !== 'u_ops') {
            throw new ApiError('该作品未公开，无法查看', 'FORBIDDEN', 403);
        }
        const comments = db.comments
            .filter((c) => c.workId === id)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((c) => ({ ...c, user: publicUser(findUser(db, c.userId)) }));
        const related = (work.relatedIds || [])
            .map((rid) => db.works.find((w) => w.id === rid))
            .filter(Boolean)
            .map((w) => enrichWork(db, w, me));
        const source = work.sourceWorkId ? db.works.find((w) => w.id === work.sourceWorkId) : null;
        return {
            work: enrichWork(db, work, me),
            comments,
            related,
            source: source ? enrichWork(db, source, me) : null,
            versions: Array.from({ length: work.version || 1 }, (_, i) => ({
                version: i + 1,
                at: i + 1 === work.version ? work.updatedAt : work.createdAt,
                note: i + 1 === work.version ? '当前版本' : '历史版本'
            })).reverse()
        };
    });
}

export async function viewWork(id) {
    await sleep(60);
    mutate((db) => {
        const work = db.works.find((w) => w.id === id);
        if (work) work.stats.views += 1;
    });
}

export async function toggleReaction(workId, type) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === workId);
        if (!work) throw new ApiError('作品不存在', 'NOT_FOUND', 404);
        const idx = db.reactions.findIndex((r) => r.userId === me && r.workId === workId && r.type === type);
        if (idx >= 0) {
            db.reactions.splice(idx, 1);
            work.stats[type === 'like' ? 'likes' : 'favorites'] = Math.max(0, work.stats[type === 'like' ? 'likes' : 'favorites'] - 1);
        } else {
            db.reactions.push({ userId: me, type, workId, at: now() });
            work.stats[type === 'like' ? 'likes' : 'favorites'] += 1;
            if (work.authorId !== me) {
                addNotification(db, {
                    userId: work.authorId,
                    type: 'social',
                    tone: 'brand',
                    title: `${publicUser(findUser(db, me)).name} ${type === 'like' ? '赞了' : '收藏了'}你的作品`,
                    body: `「${work.title}」收到 1 个新${type === 'like' ? '点赞' : '收藏'}。`,
                    link: `assets/detail.html?id=${work.id}`
                });
            }
        }
        changed('reaction');
        return { active: idx < 0, count: work.stats[type === 'like' ? 'likes' : 'favorites'] };
    });
}

export async function purchaseWork(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === id);
        if (!work) throw new ApiError('作品不存在', 'NOT_FOUND', 404);
        if (work.authorId === me) throw new ApiError('这是你自己的作品，无需购买');
        if (!work.price || work.price.mode === 'free' || !work.price.amount) throw new ApiError('该资产可免费使用');
        if (db.reactions.some((r) => r.userId === me && r.type === 'license' && r.workId === id)) {
            throw new ApiError('你已获得该作品的授权');
        }
        spendCredits(db, me, work.price.amount, `资产授权 · ${work.title}`, work.id);
        db.reactions.push({ userId: me, type: 'license', workId: id, at: now() });
        addNotification(db, {
            userId: work.authorId,
            type: 'billing',
            tone: 'ok',
            title: '你的资产被授权使用',
            body: `${publicUser(findUser(db, me)).name} 获取了「${work.title}」的使用授权。`,
            link: `assets/detail.html?id=${work.id}`
        });
        changed('license');
        return { amount: work.price.amount, licensed: true };
    });
}

export async function addComment(workId, content) {
    return respond(() => {
        const text = String(content || '').trim();
        if (!text) throw new ApiError('评论内容不能为空');
        if (text.length > 500) throw new ApiError('评论最多 500 字');
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === workId);
        if (!work) throw new ApiError('作品不存在', 'NOT_FOUND', 404);
        const comment = {
            id: uid('c'),
            workId,
            userId: me,
            content: text,
            likes: 0,
            parentId: null,
            createdAt: now()
        };
        db.comments.unshift(comment);
        work.stats.comments += 1;
        if (work.authorId !== me) {
            addNotification(db, {
                userId: work.authorId,
                type: 'social',
                tone: 'brand',
                title: '作品收到新评论',
                body: `${publicUser(findUser(db, me)).name}：${text.slice(0, 40)}`,
                link: `assets/detail.html?id=${work.id}`
            });
        }
        changed('comment');
        return { ...comment, user: publicUser(findUser(db, me)) };
    });
}

export async function likeComment(commentId) {
    await sleep(120);
    return mutate((db) => {
        const c = db.comments.find((x) => x.id === commentId);
        if (!c) throw new ApiError('评论不存在', 'NOT_FOUND', 404);
        c.likes += 1;
        return c.likes;
    });
}

/* ============================ 资产库 ============================ */

export async function listAssets(query = {}) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const { kind = 'all', status = 'all', q = '', page = 1, pageSize = 12, sort = 'updated' } = query;
        let list = db.works.filter((w) => w.authorId === me);
        if (kind !== 'all') list = list.filter((w) => w.kind === kind);
        if (status !== 'all') list = list.filter((w) => w.status === status);
        if (q) list = list.filter((w) => matchText(w.title, q) || matchText(w.tags.join(' '), q) || matchText(w.desc, q));
        if (sort === 'updated') list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        if (sort === 'created') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        if (sort === 'views') list.sort((a, b) => b.stats.views - a.stats.views);
        if (sort === 'likes') list.sort((a, b) => b.stats.likes - a.stats.likes);
        const paged = pageOf(list, page, pageSize);
        return { ...paged, items: paged.items.map((w) => enrichWork(db, w, me)) };
    });
}

export async function assetSummary() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const mine = db.works.filter((w) => w.authorId === me);
        const byKind = {};
        Object.keys(TASK_TYPES).forEach(() => {});
        mine.forEach((w) => {
            byKind[w.kind] = byKind[w.kind] || { total: 0, published: 0, draft: 0, pending: 0 };
            byKind[w.kind].total += 1;
            if (w.status === 'published') byKind[w.kind].published += 1;
            if (w.status === 'draft') byKind[w.kind].draft += 1;
            if (w.status === 'pending') byKind[w.kind].pending += 1;
        });
        return {
            total: mine.length,
            published: mine.filter((w) => w.status === 'published').length,
            draft: mine.filter((w) => w.status === 'draft').length,
            pending: mine.filter((w) => w.status === 'pending').length,
            rejected: mine.filter((w) => w.status === 'rejected').length,
            private: mine.filter((w) => w.status === 'private').length,
            views: mine.reduce((s, w) => s + w.stats.views, 0),
            likes: mine.reduce((s, w) => s + w.stats.likes, 0),
            byKind,
            recent: mine.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5).map((w) => enrichWork(db, w, me))
        };
    });
}

export async function createWork(payload) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        if (!payload.title || !String(payload.title).trim()) throw new ApiError('请填写资产名称');
        if (!payload.cover && (payload.status || 'draft') === 'published') throw new ApiError('发布前请上传或生成一张封面');
        const status = payload.status || 'draft';
        const work = {
            id: uid(payload.kind || 'w'),
            kind: payload.kind,
            subtype: payload.subtype || 'other',
            title: String(payload.title).trim(),
            desc: payload.desc || '',
            cover: payload.cover,
            mediaType: payload.kind === 'video' ? 'video' : 'image',
            mediaUrl: payload.mediaUrl || null,
            duration: payload.duration || 0,
            tags: payload.tags || [],
            prompt: payload.prompt || '',
            negative: payload.negative || 'low quality, blurry, watermark',
            params: payload.params || {},
            authorId: me,
            status: status === 'published' ? 'pending' : status,
            visibility: payload.visibility || 'public',
            price: payload.price || { mode: 'free', amount: 0 },
            stats: { views: 0, likes: 0, favorites: 0, comments: 0, remixes: 0 },
            createdAt: now(),
            updatedAt: now(),
            review: null,
            version: 1,
            sourceWorkId: payload.sourceWorkId || null,
            relatedIds: [],
            meta: payload.meta || null,
            assetRefs: payload.assetRefs || null,
            ownerNote: ''
        };
        indexWork(db, work);

        let task = null;
        if (work.status === 'pending') {
            task = createReviewTask(db, work);
        }
        changed('work');
        return { work: enrichWork(db, work, me), task };
    });
}

function createReviewTask(db, work) {
    const task = {
        id: uid('t'),
        type: 'review',
        title: `内容审核 · ${work.title}`,
        ownerId: work.authorId,
        status: 'queued',
        progress: 0,
        cost: 0,
        payload: { workId: work.id },
        outputs: [],
        logs: [{ t: clock(), level: 'info', msg: '已提交安全审核，等待初审' }],
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        refId: work.id
    };
    db.tasks.unshift(task);
    return task;
}

export async function updateWork(id, patch) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === id);
        if (!work) throw new ApiError('资产不存在', 'NOT_FOUND', 404);
        if (work.authorId !== me && me !== 'u_ops') throw new ApiError('无权修改该资产', 'FORBIDDEN', 403);
        const allowed = ['title', 'desc', 'tags', 'prompt', 'negative', 'subtype', 'price', 'visibility', 'cover', 'mediaUrl', 'duration', 'assetRefs', 'meta', 'ownerNote'];
        allowed.forEach((key) => {
            if (patch[key] !== undefined) work[key] = patch[key];
        });
        work.updatedAt = now();
        work.version = (work.version || 1) + 1;
        changed('work');
        return enrichWork(db, work, me);
    });
}

export async function deleteWork(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const idx = db.works.findIndex((w) => w.id === id);
        if (idx < 0) throw new ApiError('资产不存在', 'NOT_FOUND', 404);
        const work = db.works[idx];
        if (work.authorId !== me && me !== 'u_ops') throw new ApiError('无权删除该资产', 'FORBIDDEN', 403);
        db.works.splice(idx, 1);
        db.comments = db.comments.filter((c) => c.workId !== id);
        db.reactions = db.reactions.filter((r) => r.workId !== id);
        changed('work');
        return { id };
    });
}

export async function submitWork(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === id);
        if (!work) throw new ApiError('资产不存在', 'NOT_FOUND', 404);
        if (work.authorId !== me) throw new ApiError('无权操作该资产', 'FORBIDDEN', 403);
        if (work.status === 'pending') throw new ApiError('该资产正在审核中，请耐心等待');
        work.status = 'pending';
        work.updatedAt = now();
        work.review = { status: 'pending', by: '', at: '', note: '排队等待审核' };
        const task = createReviewTask(db, work);
        changed('work');
        return { work: enrichWork(db, work, me), task };
    });
}

export async function unpublishWork(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const work = db.works.find((w) => w.id === id);
        if (!work) throw new ApiError('资产不存在', 'NOT_FOUND', 404);
        if (work.authorId !== me) throw new ApiError('无权操作该资产', 'FORBIDDEN', 403);
        work.status = 'private';
        work.updatedAt = now();
        changed('work');
        return enrichWork(db, work, me);
    });
}

export async function bulkWorkAction(ids, action) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const targets = db.works.filter((w) => ids.includes(w.id) && w.authorId === me);
        const tasks = [];
        targets.forEach((work) => {
            if (action === 'delete') {
                const idx = db.works.indexOf(work);
                db.works.splice(idx, 1);
            } else if (action === 'submit') {
                work.status = 'pending';
                work.updatedAt = now();
                work.review = { status: 'pending', by: '', at: '', note: '排队等待审核' };
                tasks.push(createReviewTask(db, work));
            } else if (action === 'private') {
                work.status = 'private';
                work.updatedAt = now();
            }
        });
        changed('work');
        return { count: targets.length, tasks };
    });
}

/* ============================ 生成任务 ============================ */

export async function createTask(payload) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const type = payload.type;
        if (!TASK_TYPES[type]) throw new ApiError('未知任务类型');
        const cost = Number(payload.cost != null ? payload.cost : taskCost(type, payload));
        const task = {
            id: uid('t'),
            type,
            title: payload.title || `${TASK_TYPES[type].name}任务`,
            ownerId: me,
            status: 'queued',
            progress: 0,
            cost,
            payload: payload.payload || {},
            outputs: [],
            logs: [{ t: clock(), level: 'info', msg: '任务已创建，等待调度器分配算力' }],
            createdAt: now(),
            startedAt: null,
            finishedAt: null,
            error: null,
            refId: payload.refId || ''
        };
        if (cost > 0) {
            spendCredits(db, me, cost, `${TASK_TYPES[type].name} · ${task.title}`, task.id);
        }
        db.tasks.unshift(task);
        changed('task');
        return task;
    });
}

/** 提交审核后由引擎调用的审核结论 */
export function finalizeReview(workId, approved, note = '') {
    return mutate((db) => {
        const work = db.works.find((w) => w.id === workId);
        if (!work) return null;
        work.status = approved ? 'published' : 'rejected';
        work.updatedAt = now();
        work.review = {
            status: approved ? 'approved' : 'rejected',
            by: '灵犀安全审核',
            at: now(),
            note: note || (approved ? '自动审核通过' : '内容不符合社区规范')
        };
        addNotification(db, {
            userId: work.authorId,
            type: 'review',
            tone: approved ? 'ok' : 'danger',
            title: approved ? '作品审核通过' : '作品未通过审核',
            body: approved
                ? `「${work.title}」已通过审核并发布到作品广场。`
                : `「${work.title}」未通过审核：${work.review.note}`,
            link: `assets/detail.html?id=${work.id}`
        });
        changed('work');
        return work;
    });
}

export async function cancelTask(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const task = db.tasks.find((t) => t.id === id);
        if (!task) throw new ApiError('任务不存在', 'NOT_FOUND', 404);
        if (task.ownerId !== me) throw new ApiError('无权操作该任务', 'FORBIDDEN', 403);
        if (!['queued', 'running'].includes(task.status)) throw new ApiError('当前状态不可取消');
        task.status = 'canceled';
        task.finishedAt = now();
        task.logs.push({ t: clock(), level: 'warn', msg: '任务已被用户取消' });
        if (task.type === 'train') {
            const training = db.trainings.find((t) => t.id === task.refId);
            if (training && ['queued', 'running'].includes(training.status)) {
                training.status = 'canceled';
                training.finishedAt = now();
                training.error = '用户手动中断训练';
            }
        }
        if (task.cost > 0) {
            // 训练按时结算：已跑完的进度不予退还，其余按比例退回（比全退更接近真实计费）
            const ratio = task.type === 'train' ? 1 - Math.min(100, task.progress || 0) / 100 : 1;
            const refund = Math.max(0, Math.round(task.cost * ratio));
            if (refund > 0) {
                addTransaction(db, me, { type: 'refund', amount: refund, title: `任务取消退款 · ${task.title}`, refId: task.id });
                task.logs.push({ t: clock(), level: 'info', msg: `按已完成 ${Math.round(task.progress || 0)}% 结算，退还 ${refund} / ${task.cost} 算力` });
            } else {
                task.logs.push({ t: clock(), level: 'warn', msg: '任务已跑满，无可退还算力' });
            }
        }
        changed('task');
        return task;
    });
}

export async function retryTask(id) {
    const db = getDb();
    const task = db.tasks.find((t) => t.id === id);
    if (!task) throw new ApiError('任务不存在', 'NOT_FOUND', 404);
    if (task.type === 'train') throw new ApiError('训练任务请在训练页使用「改参数重试」，以保留新的训练记录', 'USE_TRAINING_RETRY', 400);
    return createTask({
        type: task.type,
        title: task.title,
        payload: task.payload,
        refId: task.refId,
        cost: task.cost,
        retryOf: task.id
    });
}

export async function listTasks(query = {}) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const { status = 'all', type = 'all', page = 1, pageSize = 20 } = query;
        let list = db.tasks.filter((t) => t.ownerId === me && t.type !== 'review');
        if (status !== 'all') list = list.filter((t) => t.status === status);
        if (type !== 'all') list = list.filter((t) => t.type === type);
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const paged = pageOf(list, page, pageSize);
        return {
            ...paged,
            counts: {
                all: db.tasks.filter((t) => t.ownerId === me && t.type !== 'review').length,
                running: db.tasks.filter((t) => t.ownerId === me && t.status === 'running').length,
                queued: db.tasks.filter((t) => t.ownerId === me && t.status === 'queued').length,
                succeeded: db.tasks.filter((t) => t.ownerId === me && t.status === 'succeeded').length,
                failed: db.tasks.filter((t) => t.ownerId === me && t.status === 'failed').length
            }
        };
    });
}

export async function getTask(id) {
    return respond(() => {
        const db = getDb();
        const task = db.tasks.find((t) => t.id === id);
        if (!task) throw new ApiError('任务不存在', 'NOT_FOUND', 404);
        return { ...task, typeMeta: TASK_TYPES[task.type] };
    }, { min: 0, max: 80 });
}

/* ============================ AI 应用 ============================ */

function enrichApp(db, app, me = currentUserId()) {
    return {
        ...app,
        author: publicUser(findUser(db, app.authorId)),
        isMine: app.authorId === me,
        favorite: db.reactions.some((r) => r.userId === me && r.type === 'appFavorite' && r.workId === app.id)
    };
}

export async function listApps(query = {}) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const { category = 'all', q = '', sort = 'popular', page = 1, pageSize = 12, mine = false } = query;
        let list = db.apps.filter((a) => a.status === 'published' || (mine && a.authorId === me));
        if (mine) list = list.filter((a) => a.authorId === me);
        if (category !== 'all') list = list.filter((a) => a.category === category);
        if (q) list = list.filter((a) => matchText(a.name, q) || matchText(a.desc, q) || matchText(a.tags.join(' '), q));
        if (sort === 'latest') list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        else if (sort === 'rating') list.sort((a, b) => b.rating - a.rating);
        else if (sort === 'price') list.sort((a, b) => a.price - b.price);
        else list.sort((a, b) => b.runs - a.runs);
        const paged = pageOf(list, page, pageSize);
        return { ...paged, items: paged.items.map((a) => enrichApp(db, a, me)) };
    });
}

export async function getApp(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const app = db.apps.find((a) => a.id === id);
        if (!app) throw new ApiError('应用不存在或已下架', 'NOT_FOUND', 404);
        const runs = db.tasks
            .filter((t) => t.ownerId === me && t.type === 'app' && t.refId === app.id)
            .slice(0, 5)
            .map((t) => ({ ...t, typeMeta: TASK_TYPES[t.type] }));
        const related = db.apps.filter((a) => a.category === app.category && a.id !== app.id).slice(0, 3).map((a) => enrichApp(db, a, me));
        const workflow = app.workflowId ? db.workflows.find((w) => w.id === app.workflowId) : null;
        return { app: enrichApp(db, app, me), runs, related, workflow };
    });
}

export async function toggleAppFavorite(id) {
    await sleep(150);
    return mutate((db) => {
        const me = currentUserId();
        const idx = db.reactions.findIndex((r) => r.userId === me && r.workId === id && r.type === 'appFavorite');
        if (idx >= 0) db.reactions.splice(idx, 1);
        else db.reactions.push({ userId: me, type: 'appFavorite', workId: id, at: now() });
        changed('app');
        return { active: idx < 0 };
    });
}

export async function runApp(appId, inputs) {
    const db = getDb();
    const app = db.apps.find((a) => a.id === appId);
    if (!app) throw new ApiError('应用不存在', 'NOT_FOUND', 404);
    const task = await createTask({
        type: 'app',
        title: `${app.name} · 运行`,
        cost: app.price,
        refId: app.id,
        payload: { appId, appName: app.name, inputs }
    });
    mutate((d) => {
        const target = d.apps.find((a) => a.id === appId);
        if (target) target.runs += 1;
    });
    return task;
}

export async function createApp(payload) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        if (!payload.name || !String(payload.name).trim()) throw new ApiError('请填写应用名称');
        if (!payload.desc) throw new ApiError('请填写应用简介');
        if (!payload.inputs || !payload.inputs.length) throw new ApiError('至少需要配置一个输入参数');
        const app = {
            id: uid('app'),
            name: String(payload.name).trim(),
            icon: String(payload.name).slice(0, 1),
            iconTone: payload.iconTone || '',
            category: payload.category || 'image',
            authorId: me,
            price: Number(payload.price) || 0,
            runs: 0,
            rating: 0,
            ratingCount: 0,
            version: 'v1.0',
            updatedAt: now(),
            status: payload.status || 'published',
            desc: payload.desc,
            tags: payload.tags || [],
            model: payload.model || 'lingxi-xl',
            workflowId: payload.workflowId || null,
            inputs: payload.inputs
        };
        db.apps.unshift(app);
        db.works.unshift({
            id: app.id,
            kind: 'app',
            subtype: 'other',
            title: app.name,
            desc: app.desc,
            cover: payload.cover || '',
            mediaType: 'image',
            mediaUrl: null,
            duration: 0,
            tags: app.tags,
            prompt: '',
            negative: '',
            params: { model: app.model },
            authorId: me,
            status: 'published',
            visibility: 'public',
            price: { mode: 'credits', amount: app.price },
            stats: { views: 0, likes: 0, favorites: 0, comments: 0, remixes: 0 },
            createdAt: now(),
            updatedAt: now(),
            review: { status: 'approved', by: '灵犀安全审核', at: now(), note: '自动审核通过' },
            version: 1,
            sourceWorkId: null,
            relatedIds: [],
            meta: null,
            assetRefs: null,
            ownerNote: ''
        });
        changed('app');
        return enrichApp(db, app, me);
    });
}

/* ============================ LoRA 训练 ============================ */

export async function listTrainings() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const list = db.trainings
            .filter((t) => t.ownerId === me)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((t) => ({
                ...t,
                dataset: db.datasets.find((d) => d.id === t.datasetId) || null,
                task: db.tasks.find((x) => x.id === t.taskId) || null
            }));
        const datasets = db.datasets
            .filter((d) => d.ownerId === me || d.ownerId === 'platform')
            .map((d) => ({ ...d, isOfficial: d.ownerId === 'platform' }));
        return { trainings: list, datasets };
    });
}

/** 单条训练详情（含数据集与任务），供训练页轮询实时过程使用，避免拉全量列表 */
export async function getTraining(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const training = db.trainings.find((t) => t.id === id);
        if (!training) throw new ApiError('训练记录不存在', 'NOT_FOUND', 404);
        if (training.ownerId !== me) throw new ApiError('无权查看该训练', 'FORBIDDEN', 403);
        return {
            training: {
                ...training,
                dataset: db.datasets.find((d) => d.id === training.datasetId) || null,
                task: db.tasks.find((x) => x.id === training.taskId) || null
            }
        };
    }, { min: 40, max: 120 });
}

/** 参数归一化 + 校验（纯函数，不写库）：显存超限 / 样本不足 / 触发词非法都会抛 ApiError */
function checkTraining(payload) {
    const db = getDb();
    if (!payload.name || !String(payload.name).trim()) throw new ApiError('请填写模型名称');
    if (String(payload.name).trim().length > 24) throw new ApiError('模型名称不超过 24 个字符');
    if (!payload.trigger || !String(payload.trigger).trim()) throw new ApiError('请设置触发词');
    if (!/^[A-Za-z0-9_]{1,16}$/.test(String(payload.trigger).trim())) throw new ApiError('触发词仅支持字母、数字与下划线，且不超过 16 字符');
    if (!payload.datasetId) throw new ApiError('请选择训练数据集');
    const dataset = db.datasets.find((d) => d.id === payload.datasetId);
    if (!dataset) throw new ApiError('数据集不存在', 'NOT_FOUND', 404);
    if (dataset.count < 10) throw new ApiError('数据集样本过少，至少需要 10 张图片');
    if (dataset.tagged < Math.ceil(dataset.count * 0.6)) throw new ApiError(`${dataset.name} 还有 ${dataset.count - dataset.tagged} 张未打标，请先在资产库补齐标注`);
    const config = normalizeConfig(payload.config || {}, dataset);
    if (config.vramGb > config.vramLimitGb) {
        throw new ApiError(`显存估算 ${config.vramGb.toFixed(1)} GB 超出节点上限 ${config.vramLimitGb} GB：请降低 Rank / 分辨率 / 批次，或增大梯度累积`);
    }
    return { dataset, config, warnings: configWarnings(config, dataset), fault: predictFault(config) };
}

/** 下单前的预估接口：与真实后端一致，前端只展示服务端算出的成本与时长 */
export async function previewTraining(payload) {
    return respond(() => {
        const { dataset, config, warnings, fault } = checkTraining(payload);
        const credits = findUser(getDb(), currentUserId())?.credits || 0;
        return { dataset, config, warnings, fault, credits, enough: credits >= config.estimateCost };
    }, { min: 60, max: 160 });
}

/** 真正建单（同步内部实现，createTraining / restartTraining 共用） */
function submitTraining(db, me, payload) {
    const { dataset, config, fault } = checkTraining(payload);
    const cost = config.estimateCost;
    if ((findUser(db, me)?.credits || 0) < cost) throw new ApiError(`算力不足：本次训练需要 ${cost} 积分`, 'NO_CREDIT', 402);
    const training = {
        id: uid('tr'),
        name: String(payload.name).trim(),
        ownerId: me,
        datasetId: dataset.id,
        taskId: '',
        modelId: null,
        status: 'queued',
        trigger: String(payload.trigger).trim(),
        config,
        loss: [],
        samples: [],
        checkpoints: [],
        epochsDone: 0,
        createdAt: now(),
        finishedAt: null,
        durationMin: 0,
        estimateMin: config.estimateMin,
        error: null,
        autoPublish: !!payload.autoPublish,
        // 故意提交的已知危险组合：跑到对应阶段后失败，用于演示失败链路
        expectFault: fault ? fault.reason : null,
        faultAt: fault ? fault.at : null
    };
    spendCredits(db, me, cost, `LoRA 训练 · ${training.name}`, training.id);
    const task = {
        id: uid('t'),
        type: 'train',
        title: training.name,
        ownerId: me,
        status: 'queued',
        progress: 0,
        cost,
        payload: {
            datasetId: dataset.id,
            trainingId: training.id,
            base: config.base,
            rank: config.rank,
            steps: config.steps,
            lr: config.lr
        },
        outputs: [],
        logs: [
            { t: clock(), level: 'info', msg: `训练任务已排队（${dataset.count} 张样本 · ${config.epochs} epoch · 预算 ${cost} 算力）` },
            { t: clock(), level: 'info', msg: `预计 ${config.estimateMin} 分钟 · 显存估算 ${config.vramGb} GB · 权重约 ${config.weightMb} MB` }
        ],
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        refId: training.id
    };
    training.taskId = task.id;
    db.trainings.unshift(training);
    db.tasks.unshift(task);
    changed('training');
    return { training, task };
}

export async function createTraining(payload) {
    return respond(() => submitTraining(getDb(), currentUserId(), payload));
}

/** 以既有训练的配置为模板重开一轮（改参数重试，不复制模型资产） */
export async function restartTraining(trainingId, overrides = {}) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const src = db.trainings.find((t) => t.id === trainingId);
        if (!src) throw new ApiError('训练记录不存在', 'NOT_FOUND', 404);
        if (src.ownerId !== me) throw new ApiError('无权操作该训练', 'FORBIDDEN', 403);
        const config = { ...src.config, ...overrides };
        ['estimateCost', 'estimateMin', 'samplesPerSec', 'vramGb', 'vramLimitGb', 'weightMb', 'perEpochRows', 'stepsPerEpoch', 'datasetCount', 'repeat', 'warmupSteps', 'lossPoints'].forEach((k) => delete config[k]);
        return submitTraining(db, me, {
            name: overrides.name || src.name,
            trigger: src.trigger,
            datasetId: overrides.datasetId || src.datasetId,
            autoPublish: src.autoPublish,
            config
        });
    });
}

export async function finishTraining(trainingId, modelWorkId) {
    return mutate((db) => {
        const training = db.trainings.find((t) => t.id === trainingId);
        if (!training) return null;
        training.status = 'succeeded';
        training.modelId = modelWorkId;
        training.finishedAt = now();
        training.durationMin = Math.max(1, Math.round((Date.now() - new Date(training.createdAt).getTime()) / 60000));
        addNotification(db, {
            userId: training.ownerId,
            type: 'task',
            tone: 'ok',
            title: 'LoRA 训练完成',
            body: `「${training.name}」训练完成，已生成可用的模型资产。`,
            link: `lora-train.html?training=${training.id}`
        });
        changed('training');
        return training;
    });
}

export async function createModelAsset({ trainingId, title, desc, cover, price, publish }) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const training = db.trainings.find((t) => t.id === trainingId);
        if (!training) throw new ApiError('训练记录不存在', 'NOT_FOUND', 404);
        const work = {
            id: uid('m'),
            kind: 'model',
            subtype: 'art',
            title: title || training.name,
            desc: desc || `基于 ${training.dataset?.name || '自制数据集'} 训练的 LoRA 模型，触发词 ${training.trigger}。`,
            cover: cover || db.works.find((w) => w.id === training.modelId)?.cover || '',
            mediaType: 'image',
            mediaUrl: null,
            duration: 0,
            tags: ['模型', 'LoRA', training.config.base],
            prompt: '',
            negative: '',
            params: { model: training.config.base, steps: 28, cfg: 6 },
            authorId: me,
            status: publish ? 'published' : 'draft',
            visibility: 'public',
            price: { mode: price > 0 ? 'credits' : 'free', amount: Number(price) || 0 },
            stats: { views: 0, likes: 0, favorites: 0, comments: 0, remixes: 0 },
            createdAt: now(),
            updatedAt: now(),
            review: publish ? { status: 'approved', by: '灵犀安全审核', at: now(), note: '模型自动审核通过' } : null,
            version: 1,
            sourceWorkId: null,
            relatedIds: [],
            meta: {
                base: training.config.base,
                trigger: training.trigger,
                rank: training.config.rank,
                steps: training.config.steps,
                size: `${Math.max(6, Math.round(training.config.rank * 0.7))} MB`,
                downloads: 0,
                loss: training.loss.length ? training.loss[training.loss.length - 1].loss : 0.06
            },
            assetRefs: null,
            ownerNote: ''
        };
        indexWork(db, work);
        training.modelId = work.id;
        changed('work');
        return enrichWork(db, work, me);
    });
}

/* ============================ 工作流 ============================ */

export async function listWorkflows() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const list = db.workflows.map((w) => ({
            ...w,
            owner: publicUser(findUser(db, w.ownerId)),
            isMine: w.ownerId === me,
            recentRuns: db.tasks.filter((t) => t.type === 'workflow' && t.refId === w.id).length
        }));
        return { items: list };
    });
}

export async function getWorkflow(id) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const workflow = db.workflows.find((w) => w.id === id) || db.workflows[0];
        if (!workflow) throw new ApiError('工作流不存在', 'NOT_FOUND', 404);
        const runs = db.tasks
            .filter((t) => t.type === 'workflow' && t.refId === workflow.id)
            .slice(0, 8)
            .map((t) => ({ ...t }));
        return {
            workflow: { ...workflow, isMine: workflow.ownerId === me, owner: publicUser(findUser(db, workflow.ownerId)) },
            runs,
            templates: db.workflows.map((w) => ({ id: w.id, name: w.name, nodes: w.nodes.length, runs: w.runs }))
        };
    });
}

export async function runWorkflow(workflowId, overrides = {}) {
    const db = getDb();
    const workflow = db.workflows.find((w) => w.id === workflowId);
    if (!workflow) throw new ApiError('工作流不存在', 'NOT_FOUND', 404);
    const task = await createTask({
        type: 'workflow',
        title: `${workflow.name} · ${overrides.count || 2} 张`,
        cost: taskCost('workflow'),
        refId: workflow.id,
        payload: { workflowId, count: overrides.count || 2, nodes: workflow.nodes.map((n) => n.id), prompt: overrides.prompt || '' }
    });
    mutate((d) => {
        const wf = d.workflows.find((x) => x.id === workflowId);
        if (wf) {
            wf.runs += 1;
            wf.updatedAt = now();
        }
    });
    return task;
}

/** 小版本号 +1：v1.4 → v1.5，无纯数字时回退 v2 */
function bumpVersion(v) {
    const m = /^v?(\d+)\.(\d+)$/i.exec(String(v || '').trim());
    if (!m) return 'v2.0';
    return `v${m[1]}.${Number(m[2]) + 1}`;
}

/**
 * 保存工作流编辑（节点增删改、拖拽坐标、名称/描述）。
 * 仅落盘不广播 dataChange：编辑器自持内存态，广播会触发整屏重绘打断操作。
 */
export async function patchWorkflow(workflowId, patch = {}) {
    return respond(() => {
        const wf = mutate((d) => {
            const target = d.workflows.find((x) => x.id === workflowId);
            if (!target) throw new ApiError('工作流不存在', 'NOT_FOUND', 404);
            if (Array.isArray(patch.nodes)) target.nodes = patch.nodes;
            if (typeof patch.name === 'string' && patch.name.trim()) target.name = patch.name.trim();
            if (typeof patch.desc === 'string') target.desc = patch.desc;
            target.updatedAt = now();
            if (patch.bumpVersion) target.version = bumpVersion(target.version);
            return { ...target };
        });
        return { workflow: wf };
    });
}

/** 复制工作流为“我的草稿”，返回新对象（官方/他人模板被编辑时用） */
export async function duplicateWorkflow(workflowId) {
    return respond(() => {
        const me = currentUserId();
        const copy = mutate((d) => {
            const src = d.workflows.find((x) => x.id === workflowId);
            if (!src) throw new ApiError('工作流不存在', 'NOT_FOUND', 404);
            const id = uid('wf');
            const next = {
                ...src,
                id,
                ownerId: me,
                name: `${src.name} · 副本`,
                template: false,
                isMine: true,
                runs: 0,
                version: 'v0.1',
                createdAt: now(),
                updatedAt: now(),
                nodes: src.nodes.map((n) => ({ ...n, params: { ...n.params }, pos: n.pos ? { ...n.pos } : undefined }))
            };
            d.workflows.unshift(next);
            return { ...next };
        });
        changed(`workflow:${copy.id}`);
        return { workflow: copy };
    });
}

/* ============================ 创作者 / 社交 ============================ */

export async function getCreator(userId) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        // 严格查找：findUser 对缺失作者会兜底到首个用户，个人中心需要真正的 404
        const user = (db.users || []).find((u) => u.id === userId);
        if (!user) throw new ApiError('用户不存在或已注销', 'NOT_FOUND', 404);
        const works = db.works.filter((w) => w.authorId === userId && w.status === 'published');
        const likes = works.reduce((sum, w) => sum + w.stats.likes, 0);
        return {
            user: publicUser(user),
            works: works
                .slice()
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .map((w) => enrichWork(db, w, me)),
            isSelf: userId === me,
            isFollowing: db.follows.some((f) => f.followerId === me && f.followeeId === userId),
            followerCount: db.follows.filter((f) => f.followeeId === userId).length + (user.followers || 0),
            followingCount: db.follows.filter((f) => f.followerId === userId).length + (user.following || 0),
            likesReceived: likes,
            followers: db.follows.filter((f) => f.followeeId === userId).map((f) => publicUser(findUser(db, f.followerId))),
            following: db.follows.filter((f) => f.followerId === userId).map((f) => publicUser(findUser(db, f.followeeId)))
        };
    });
}

export async function toggleFollow(userId) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        if (userId === me) throw new ApiError('不能关注自己');
        const idx = db.follows.findIndex((f) => f.followerId === me && f.followeeId === userId);
        if (idx >= 0) {
            db.follows.splice(idx, 1);
        } else {
            db.follows.push({ followerId: me, followeeId: userId, at: now() });
            addNotification(db, {
                userId,
                type: 'social',
                tone: 'brand',
                title: '有新的关注者',
                body: `${publicUser(findUser(db, me)).name} 关注了你。`,
                link: `profile.html?uid=${me}`
            });
        }
        const user = findUser(db, userId);
        const meUser = findUser(db, me);
        if (user) user.followers = Math.max(0, (user.followers || 0) + (idx >= 0 ? -1 : 1));
        if (meUser) meUser.following = Math.max(0, (meUser.following || 0) + (idx >= 0 ? -1 : 1));
        changed('follow');
        return { following: idx < 0 };
    });
}

export async function updateProfile(patch) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const user = findUser(db, me);
        if (!user) throw new ApiError('账号不存在', 'NOT_FOUND', 404);
        if (patch.name !== undefined) {
            if (!String(patch.name).trim()) throw new ApiError('昵称不能为空');
            user.name = String(patch.name).trim().slice(0, 20);
        }
        if (patch.handle !== undefined) {
            const handle = String(patch.handle).trim().replace(/[^\w-]/g, '');
            if (!handle) throw new ApiError('用户名只能包含字母、数字与下划线');
            user.handle = handle;
        }
        ['bio', 'avatar', 'region', 'cover'].forEach((key) => {
            if (patch[key] !== undefined) user[key] = patch[key];
        });
        if (Array.isArray(patch.tags)) user.tags = patch.tags.slice(0, 6);
        changed('user');
        return publicUser(user);
    });
}

export async function favorites() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const ids = db.reactions.filter((r) => r.userId === me && r.type === 'favorite').map((r) => r.workId);
        const list = ids.map((id) => db.works.find((w) => w.id === id)).filter(Boolean).map((w) => enrichWork(db, w, me));
        return { items: list, total: list.length };
    });
}

/* ============================ 账户 / 计费 ============================ */

export async function getAccount() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const user = findUser(db, me);
        const plan = PLAN_MAP[user.plan] || PLAN_MAP.free;
        const used = user.computeUsed || 0;
        const quota = plan.credits || 0;
        return {
            credits: user.credits || 0,
            plan: plan.id,
            planName: plan.name,
            planPrice: plan.price,
            quota,
            used,
            usedPercent: quota ? Math.min(100, Math.round((used / quota) * 100)) : 0,
            resetAt: user.creditsResetAt,
            autoRecharge: !!user.autoRecharge,
            transactions: db.transactions.filter((t) => t.userId === me).slice(0, 30),
            plans: Object.values(PLAN_MAP),
            packages: RECHARGE_PACKAGES
        };
    });
}

export async function recharge(packageIndex) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const pack = RECHARGE_PACKAGES[packageIndex];
        if (!pack) throw new ApiError('充值档位不存在');
        const total = pack.credits + pack.bonus;
        addTransaction(db, me, { type: 'recharge', amount: total, title: `充值 ${pack.credits} 积分${pack.bonus ? `（赠 ${pack.bonus}）` : ''}`, refId: `pkg_${pack.credits}` });
        addNotification(db, {
            userId: me,
            type: 'billing',
            tone: 'ok',
            title: '充值成功',
            body: `已到账 ${total} 算力积分，当前余额 ${findUser(db, me).credits}。`,
            link: 'wallet.html'
        });
        changed('billing');
        return { credits: findUser(db, me).credits, added: total };
    });
}

export async function subscribePlan(planId) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const plan = PLAN_MAP[planId];
        if (!plan) throw new ApiError('套餐不存在');
        const user = findUser(db, me);
        if (user.plan === planId) throw new ApiError('当前已是该套餐');
        user.plan = planId;
        if (plan.credits) {
            addTransaction(db, me, { type: 'subscribe', amount: plan.credits, title: `订阅${plan.name} · 赠送算力`, refId: planId });
        }
        addNotification(db, {
            userId: me,
            type: 'billing',
            tone: 'ok',
            title: `已升级至${plan.name}`,
            body: `订阅成功，已发放 ${plan.credits} 算力积分，并发数上限 ${plan.limits.concurrency}。`,
            link: 'wallet.html'
        });
        changed('billing');
        return plan;
    });
}

export async function toggleAutoRecharge(enabled) {
    await sleep(120);
    return mutate((db) => {
        const user = findUser(db, currentUserId());
        user.autoRecharge = !!enabled;
        changed('billing');
        return user.autoRecharge;
    });
}

/* ============================ 通知 ============================ */

export async function listNotifications() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const items = db.notifications.filter((n) => n.userId === me).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return { items, unread: items.filter((n) => !n.read).length };
    });
}

export async function markNotificationRead(id) {
    await sleep(80);
    return mutate((db) => {
        const n = db.notifications.find((x) => x.id === id);
        if (n) n.read = true;
        return unreadCount(currentUserId());
    });
}

export async function markAllNotificationsRead() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        db.notifications.filter((n) => n.userId === me).forEach((n) => {
            n.read = true;
        });
        return 0;
    });
}

export function getUnreadCount() {
    return unreadCount(currentUserId());
}

/* ============================ 搜索 / 概览 ============================ */

export async function search(q) {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const keyword = String(q || '').trim();
        if (!keyword) return { works: [], apps: [], users: [] };
        const works = db.works
            .filter((w) => w.status === 'published' && (matchText(w.title, keyword) || matchText(w.desc, keyword) || matchText(w.tags.join(' '), keyword)))
            .slice(0, 8)
            .map((w) => enrichWork(db, w, me));
        const apps = db.apps.filter((a) => matchText(a.name, keyword) || matchText(a.desc, keyword)).slice(0, 5).map((a) => enrichApp(db, a, me));
        const users = db.users
            .filter((u) => u.role !== 'ops' && (matchText(u.name, keyword) || matchText(u.handle, keyword) || matchText(u.tags.join(' '), keyword)))
            .slice(0, 5)
            .map(publicUser);
        return { works, apps, users };
    });
}

/** 平台级统计：近 7 天由任务表直接派生，首页 / 应用广场 / 后台共用同一口径 */
export function platformStats(db) {
    const week = [];
    for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 86400000);
        const key = d.toDateString();
        const list = db.tasks.filter((t) => new Date(t.createdAt).toDateString() === key);
        week.push({
            label: `${d.getMonth() + 1}/${d.getDate()}`,
            tasks: list.length,
            generated: list.reduce((s, t) => s + ((t.outputs || []).length), 0),
            credits: list.reduce((s, t) => s + (t.cost || 0), 0)
        });
    }
    const today = week[week.length - 1];
    return {
        creators: db.users.filter((u) => u.role === 'creator').length,
        works: db.works.filter((w) => w.status === 'published').length,
        apps: db.apps.filter((a) => a.status === 'published').length,
        totalRuns: db.apps.reduce((s, a) => s + (a.runs || 0), 0),
        todayGenerated: today.generated,
        todayTasks: today.tasks,
        todayCredits: today.credits,
        week
    };
}

export async function getOverview() {
    return respond(() => {
        const db = getDb();
        const me = currentUserId();
        const user = findUser(db, me);
        const mine = db.works.filter((w) => w.authorId === me);
        const published = mine.filter((w) => w.status === 'published');
        const tagCount = {};
        db.works.filter((w) => w.status === 'published').forEach((w) => w.tags.forEach((t) => {
            tagCount[t] = (tagCount[t] || 0) + 1;
        }));
        return {
            credits: user.credits || 0,
            plan: user.plan,
            works: mine.length,
            published: published.length,
            drafts: mine.filter((w) => w.status === 'draft').length,
            pending: mine.filter((w) => w.status === 'pending').length,
            views: published.reduce((s, w) => s + w.stats.views, 0),
            likes: published.reduce((s, w) => s + w.stats.likes, 0),
            favorites: published.reduce((s, w) => s + w.stats.favorites, 0),
            runningTasks: db.tasks.filter((t) => t.ownerId === me && ['queued', 'running'].includes(t.status)).length,
            unread: unreadCount(me),
            trendingTags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
            platform: platformStats(db)
        };
    });
}

/* ============================ 平台管理 ============================ */

export async function adminOverview() {
    return respond(() => {
        const db = getDb();
        const pending = db.works.filter((w) => w.status === 'pending');
        const today = new Date().toDateString();
        const todayTasks = db.tasks.filter((t) => new Date(t.createdAt).toDateString() === today);
        return {
            pendingCount: pending.length,
            pending: pending.map((w) => ({ ...enrichWork(db, w, 'u_ops'), work: w })),
            users: db.users.filter((u) => u.role !== 'ops').map(publicUser),
            stats: {
                users: db.users.filter((u) => u.role !== 'ops').length,
                works: db.works.length,
                published: db.works.filter((w) => w.status === 'published').length,
                tasks: db.tasks.length,
                todayTasks: todayTasks.length,
                todayCost: todayTasks.reduce((s, t) => s + (t.cost || 0), 0),
                failed: db.tasks.filter((t) => t.status === 'failed').length,
                credits: db.users.reduce((s, u) => s + (u.role === 'ops' ? 0 : u.credits || 0), 0)
            },
            recentTasks: db.tasks.slice(0, 8).map((t) => ({
                ...t,
                ownerName: publicUser(findUser(db, t.ownerId)).name,
                typeMeta: TASK_TYPES[t.type]
            })),
            platform: platformStats(db)
        };
    });
}

export async function reviewWork(id, approved, note = '') {
    return respond(() => {
        const work = finalizeReview(id, approved, note);
        if (!work) throw new ApiError('作品不存在', 'NOT_FOUND', 404);
        return work;
    });
}

/* ============================ 系统 ============================ */

export async function resetDemo() {
    await sleep(200);
    resetDb();
    changed('reset');
    return true;
}

export async function exportData() {
    await sleep(150);
    return JSON.stringify(getDb(), null, 2);
}

export function planInfo(planId) {
    return PLAN_MAP[planId] || PLAN_MAP.free;
}

export function modelInfo(modelId) {
    return MODEL_MAP[modelId] || null;
}

export function formatDateTime(iso) {
    return fmtDate(iso, true);
}
