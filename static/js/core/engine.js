/**
 * 任务执行引擎
 * ------------------------------------------------------------------
 * 浏览器端的“调度器”：推进排队 / 运行中的任务，产出结果并落库。
 * 通过 localStorage 时间戳避免多标签页重复推进同一任务。
 */
import { KEYS, readLocal, writeLocal } from './storage.js';
import { mutate, findUser, addNotification, addTransaction } from './db.js';
import { emit, EVENTS } from './bus.js';
import { img, VIDEO_SRC } from '../data/media.js';
import { uid } from './format.js';

const TAB_ID = Math.random().toString(36).slice(2);
const LOCK_KEY = `${KEYS.flag}.engine`;
const TICK_MS = 1100;
const MAX_CONCURRENCY = 2;

let timer = null;

function now() {
    return new Date().toISOString();
}

function clock() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(task, level, msg) {
    if (task.logs.some((l) => l.msg === msg)) return;
    task.logs.push({ t: clock(), level, msg });
    if (task.logs.length > 80) task.logs = task.logs.slice(-80);
}

function acquireLock() {
    const current = readLocal(LOCK_KEY, null);
    const ts = Date.now();
    if (current && current.tab !== TAB_ID && ts - current.at < TICK_MS * 2.2) return false;
    writeLocal(LOCK_KEY, { tab: TAB_ID, at: ts });
    return true;
}

function stepFor(task) {
    const map = {
        image: [8, 15],
        video: [5, 9],
        train: [4, 8],
        workflow: [7, 12],
        app: [12, 20],
        review: [22, 34],
        upload: [30, 50]
    };
    const [min, max] = map[task.type] || [10, 18];
    return min + Math.random() * (max - min);
}

const STAGES = {
    image: [
        [12, 'info', '加载底模与 VAE，初始化采样管线'],
        [30, 'info', '提示词编码完成，开始 K 采样'],
        [62, 'info', '采样过半，正在做细节修正'],
        [86, 'info', 'VAE 解码并写入产物目录']
    ],
    video: [
        [10, 'info', '解析分镜与运镜参数'],
        [35, 'info', '逐帧生成中（24fps / 720p）'],
        [72, 'info', '光流插帧与色彩一致性校正'],
        [90, 'info', '封装 MP4 并生成封面']
    ],
    train: [
        [8, 'info', '校验数据集与标注完整性'],
        [30, 'info', '开始训练：加载底模与优化器'],
        [58, 'info', '训练进行中，定期保存 checkpoint'],
        [85, 'info', '收敛检测通过，导出 LoRA 权重']
    ],
    workflow: [
        [10, 'info', '解析工作流 DAG，6 个节点待执行'],
        [35, 'info', '节点「提示词编码」执行完成'],
        [62, 'info', '节点「K 采样器」执行完成'],
        [88, 'info', '节点「保存图像」执行完成']
    ],
    app: [
        [15, 'info', '加载应用配置与输入参数'],
        [48, 'info', '调用底层模型服务'],
        [82, 'info', '整理输出结果与结构化数据']
    ],
    review: [
        [26, 'info', '内容安全模型初筛中'],
        [64, 'info', '人工规则库比对'],
        [88, 'info', '生成审核结论']
    ]
};

function applyStages(task) {
    (STAGES[task.type] || []).forEach(([threshold, level, msg]) => {
        if (task.progress >= threshold) log(task, level, msg);
    });
}

function outputImages(prompt, count = 2) {
    const base = prompt || 'aigc concept art';
    return Array.from({ length: count }, (_, i) => ({
        type: 'image',
        url: img(`${base}, variation ${i + 1}, high detail`),
        title: `output_${String(i + 1).padStart(4, '0')}.png`
    }));
}

function appText(app, inputs) {
    if (!app) return '应用执行完成。';
    if (app.id === 'app_003') {
        const shots = Number(inputs.shots || 8);
        return Array.from({ length: shots }, (_, i) => {
            const no = String(i + 1).padStart(2, '0');
            const label = ['建立镜头', '人物近景', '环境特写', '动作跟拍', '情绪停顿', '转场空镜'][i % 6];
            return `镜头 ${no}｜${label}｜${i % 3 === 0 ? '广角' : '中景'}｜运镜：${i % 2 ? '缓慢推近' : '横移'}｜${inputs.tone === 'tense' ? '冷色高对比' : '暖色柔光'}`;
        }).join('\n');
    }
    if (app.id === 'app_008') {
        return `标题：${inputs.topic}｜我居然在家做出来了\n\n正文：\n最近把自己关在房间里折腾了一下午，终于用 AI 把「${inputs.topic}」做出来了。\n1. 先定风格：把参考图丢进工作流，锁定色调；\n2. 再定结构：角色 / 场景分开生成，避免画面打架；\n3. 最后统一出片：一次生成 4 张，挑最自然的那张。\n\n整体比想象中省时间，成本大概 ${app.price} 算力积分。\n\n#AI创作 #AIGC #${(inputs.topic || '').slice(0, 8)}`;
    }
    if (app.id === 'app_005') {
        return `配音完成：\n「${inputs.text}」\n\n音色：${inputs.voice === 'suwan' ? '苏晚（清冷女声）' : '林澈（低沉男声）'}\n情绪强度：${inputs.emotion}%\n时长：约 ${Math.max(3, Math.ceil((inputs.text || '').length / 5))} 秒\n输出：voice_${Date.now().toString(36)}.mp3 + 字幕时间轴`;
    }
    if (app.id === 'app_004') {
        return `已根据「${inputs.product}」生成电商主图方案：\n· 场景：${inputs.scene} \n· 构图：居中留白 40%，光源左上方 45°\n· 输出：${inputs.ratio} 主图 2 张 + 详情页长图 1 张\n建议在后期补充商品真实材质细节。`;
    }
    if (app.id === 'app_007') {
        return `扩图完成：按 ${inputs.scale}% 比例向${inputs.direction === 'horizontal' ? '左右' : inputs.direction === 'vertical' ? '上下' : '四周'}扩展，已补全边缘场景并保持透视一致。`;
    }
    return `「${app.name}」执行完成，共处理 ${Object.keys(inputs || {}).length} 个输入参数。`;
}

function appOutputs(db, task) {
    const app = db.apps.find((a) => a.id === task.payload.appId);
    const inputs = task.payload.inputs || {};
    if (!app) return [{ type: 'text', title: '结果', text: '应用已下线，无法生成结果。' }];
    if (['app_004', 'app_002', 'app_007'].includes(app.id)) {
        return outputImages(inputs.product || inputs.prompt || app.name, app.id === 'app_002' ? 3 : 2);
    }
    if (app.id === 'app_006') {
        return [{ type: 'video', url: VIDEO_SRC, poster: img('digital human presentation, studio lighting'), title: '口播视频（15s）' }];
    }
    return [{ type: 'text', title: '生成结果', text: appText(app, inputs) }];
}

function completeTask(db, task) {
    task.status = 'succeeded';
    task.progress = 100;
    task.finishedAt = now();
    log(task, 'ok', '任务执行完成，产物已写入');

    const owner = findUser(db, task.ownerId);

    if (task.type === 'review') {
        const work = db.works.find((w) => w.id === task.payload.workId);
        if (work) {
            const banned = ['真实地标', '血腥', '暴力', '政治', '恐怖袭击', '枪支', '涉黄'];
            const text = `${work.title} ${work.desc} ${(work.tags || []).join(' ')}`;
            const hit = banned.find((word) => text.includes(word));
            const approved = !hit;
            work.status = approved ? 'published' : 'rejected';
            work.updatedAt = now();
            work.review = {
                status: approved ? 'approved' : 'rejected',
                by: '灵犀安全审核',
                at: now(),
                note: approved ? '自动审核通过，内容符合社区规范' : `包含敏感内容「${hit}」，请修改后重新提交`
            };
            task.outputs = [{ type: 'text', title: '审核结论', text: work.review.note }];
            addNotification(db, {
                userId: work.authorId,
                type: 'review',
                tone: approved ? 'ok' : 'danger',
                title: approved ? '作品审核通过' : '作品未通过审核',
                body: approved ? `「${work.title}」已发布到作品广场。` : `「${work.title}」未通过：${work.review.note}`,
                link: `assets/detail.html?id=${work.id}`
            });
        }
        return;
    }

    if (task.type === 'image' || task.type === 'workflow') {
        const count = task.type === 'workflow' ? Number(task.payload.count) || 2 : 2;
        task.outputs = outputImages(task.payload.prompt || task.title, count);
    } else if (task.type === 'video') {
        task.outputs = [
            {
                type: 'video',
                url: VIDEO_SRC,
                poster: img(`${task.payload.prompt || task.title}, cinematic still`),
                title: '生成的视频片段（5s）'
            }
        ];
    } else if (task.type === 'app') {
        task.outputs = appOutputs(db, task);
    } else if (task.type === 'train') {
        const training = db.trainings.find((t) => t.id === task.payload.trainingId);
        if (training) {
            const loss = Array.isArray(training.loss) ? training.loss : [];
            for (let i = loss.length; i < 36; i += 1) {
                const step = (i + 1) * Math.max(50, Math.round(training.config.steps / 36));
                loss.push({ step, loss: Number((0.26 * Math.exp(-i / 11) + 0.052 + Math.sin(i * 2.1) * 0.005).toFixed(3)) });
            }
            training.loss = loss;
            training.status = 'succeeded';
            training.finishedAt = now();
            training.durationMin = Math.max(1, Math.round((Date.now() - new Date(training.createdAt).getTime()) / 60000));

            const model = {
                id: uid('m'),
                kind: 'model',
                subtype: 'art',
                title: training.name,
                desc: `基于数据集训练的 LoRA 模型，触发词 ${training.trigger}，rank ${training.config.rank}。`,
                cover: img(`style sample from lora model ${training.name}, high detail`),
                mediaType: 'image',
                mediaUrl: null,
                duration: 0,
                tags: ['模型', 'LoRA', training.config.base],
                prompt: '',
                negative: '',
                params: { model: training.config.base, steps: 28, cfg: 6 },
                authorId: training.ownerId,
                status: training.autoPublish ? 'published' : 'draft',
                visibility: 'public',
                price: { mode: 'free', amount: 0 },
                stats: { views: 0, likes: 0, favorites: 0, comments: 0, remixes: 0 },
                createdAt: now(),
                updatedAt: now(),
                review: training.autoPublish ? { status: 'approved', by: '灵犀安全审核', at: now(), note: '模型自动审核通过' } : null,
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
                    loss: training.loss[training.loss.length - 1]?.loss || 0.06
                },
                assetRefs: null,
                ownerNote: ''
            };
            db.works.unshift(model);
            training.modelId = model.id;
            task.outputs = [{ type: 'model', title: model.title, workId: model.id, url: model.cover }];
            addNotification(db, {
                userId: training.ownerId,
                type: 'task',
                tone: 'ok',
                title: 'LoRA 训练完成',
                body: `「${training.name}」训练完成，最终 loss ${model.meta.loss}，已生成模型资产。`,
                link: `lora-train.html?training=${training.id}`
            });
        }
    }

    if (owner) {
        addNotification(db, {
            userId: task.ownerId,
            type: 'task',
            tone: 'ok',
            title: `${task.title} 已完成`,
            body: `任务消耗 ${task.cost} 算力积分，产物可在任务中心查看。`,
            link: 'tasks.html'
        });
    }
    emit(EVENTS.dataChange, { scope: 'task', at: Date.now() });
}

function failTask(db, task, reason) {
    task.status = 'failed';
    task.progress = 100;
    task.finishedAt = now();
    task.error = reason;
    log(task, 'err', reason);
    if (task.cost > 0) {
        addTransaction(db, task.ownerId, { type: 'refund', amount: task.cost, title: `任务失败退款 · ${task.title}`, refId: task.id });
    }
    addNotification(db, {
        userId: task.ownerId,
        type: 'task',
        tone: 'danger',
        title: `${task.title} 执行失败`,
        body: `${reason}，已自动退还 ${task.cost} 算力积分。`,
        link: 'tasks.html'
    });
}

function tick() {
    if (!acquireLock()) return;
    let snapshot = null;
    mutate((db) => {
        const active = db.tasks.filter((t) => t.status === 'queued' || t.status === 'running');
        let running = active.filter((t) => t.status === 'running').length;
        active
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
            .forEach((task) => {
                if (task.status === 'queued') {
                    if (running >= MAX_CONCURRENCY) return;
                    task.status = 'running';
                    task.startedAt = now();
                    task.progress = Math.max(task.progress || 0, 2);
                    running += 1;
                    log(task, 'info', '已分配算力节点，任务开始执行');
                    snapshot = task;
                    return;
                }
                if (task.status === 'running') {
                    task.progress = Math.min(100, task.progress + stepFor(task));
                    applyStages(task);
                    if (task.progress >= 100) {
                        if (task.type === 'image' && String(task.payload.prompt || '').includes('__fail__')) {
                            failTask(db, task, '内容安全检查未通过');
                        } else {
                            completeTask(db, task);
                        }
                    }
                    snapshot = task;
                }
            });
    });
    if (snapshot) emit(EVENTS.taskUpdate, { task: snapshot });
}

export function startEngine() {
    if (window.__lxEngineStarted) return;
    window.__lxEngineStarted = true;
    tick();
    timer = setInterval(tick, TICK_MS);
    window.addEventListener('beforeunload', () => {
        clearInterval(timer);
        writeLocal(LOCK_KEY, { tab: TAB_ID, at: 0 });
    });
}

export function stopEngine() {
    clearInterval(timer);
}
