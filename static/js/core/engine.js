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
import { buildTrainPlan, lossAt, samplePrompt } from './training.js';
import {
    parseScript, applyTaskResult, buildParsePlan, buildComposePlan, buildShotPlan,
    summaryOf, formatStoryboard, shotAtSecond, shotLabel, videoCost, toneName
} from './drama.js';
import { uid } from './format.js';

const TAB_ID = Math.random().toString(36).slice(2);
const LOCK_KEY = `${KEYS.flag}.engine`;
const TICK_MS = 1100;
const MAX_CONCURRENCY = 2;
/**
 * 分镜镜头单独占用一路队列：一个短剧项目会同时下十几条镜头任务，
 * 与训练 / 图片任务争用同一个并发门会等待过久。真实平台会把它们排到同一批推理集群上。
 */
const MAX_BATCH_CONCURRENCY = 3;

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
        upload: [30, 50],
        script: [9, 16],
        compose: [7, 13]
    };
    // 单个分镜片段比完整短剧轻很多，步长略快，但仍保证能看清逐镜推进
    if (task.payload && task.payload.shotId) return 11 + Math.random() * 7;
    const [min, max] = map[task.type] || [10, 18];
    return min + Math.random() * (max - min);
}

const isShotTask = (task) => Boolean(task.payload && task.payload.shotId);
const findDramaOf = (db, task) => ((db.dramas || []).find((d) => d.id === task.payload?.dramaId) || null);

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
    train: [], // 训练日志由 buildTrainPlan 逐条驱动，不使用静态阶段表
    script: [], // 剧本解析日志由 buildParsePlan 驱动（与工作台流程清单同源）
    compose: [], // 合成日志由 buildComposePlan 驱动
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

function applyStages(task, plan) {
    // 分镜镜头有自己的过程计划，不再叠加静态视频阶段文案（否则会看到“解析分镜”与“镜头 03 装配”并存）
    const statics = isShotTask(task) ? [] : STAGES[task.type] || [];
    statics.forEach(([threshold, level, msg]) => {
        if (task.progress >= threshold) log(task, level, msg);
    });
    // 动态计划（解析 / 合成 / 单镜头）：按进度取已完成条目，log() 自己丢弃重复行
    (plan || []).forEach((item) => {
        if (task.progress >= item.at) log(task, item.level || 'info', item.msg);
    });
}

/** 按任务类型取出与视图同源的过程计划 */
function planFor(db, task) {
    if (task.type === 'script') {
        const drama = findDramaOf(db, task);
        return drama ? buildParsePlan(drama) : [];
    }
    if (task.type === 'compose') {
        const drama = findDramaOf(db, task);
        return drama ? buildComposePlan(drama) : [];
    }
    if (isShotTask(task)) {
        const drama = findDramaOf(db, task);
        const shot = drama ? (drama.shots || []).find((s) => s.id === task.payload.shotId) : null;
        return shot ? buildShotPlan(shot, drama.model, drama.tone) : [];
    }
    return null;
}

/**
 * 推进训练过程：根据共享的阶段计划逐条输出日志，
 * 并在对应里程碑写入 loss 采样点 / checkpoint / 验证样张。
 * 计划不入库（避免冷数据目膨胀），每 tick 由配置重建，与页面展示同源一致。
 */
function advanceTraining(db, task, training) {
    const cfg = training.config || {};
    const dataset = db.datasets.find((d) => d.id === training.datasetId) || {};
    const plan = buildTrainPlan(cfg, dataset, training.trigger);
    if (!Array.isArray(training.loss)) training.loss = [];
    if (!Array.isArray(training.samples)) training.samples = [];
    if (!Array.isArray(training.checkpoints)) training.checkpoints = [];

    // loss 采样点按进度逐步生成，所以曲线会“边训边长”
    const points = cfg.lossPoints || 24;
    const want = Math.max(0, Math.min(points, Math.floor((task.progress / 100) * points)));
    while (training.loss.length < want) {
        const idx = training.loss.length;
        training.loss.push({
            step: Math.round((cfg.steps || 1000) * ((idx + 1) / points)),
            loss: lossAt(cfg, idx, points)
        });
    }

    const emitted = Number(training.emitted) || 0;
    let i = emitted;
    while (i < plan.length && plan[i].at <= task.progress) {
        const item = plan[i];
        log(task, item.level || 'info', item.msg);
        if (item.kind === 'epoch') {
            training.epochsDone = Math.max(Number(training.epochsDone) || 0, item.epoch);
        } else if (item.kind === 'ckpt') {
            if (!training.checkpoints.some((c) => c.step === item.step)) {
                training.checkpoints.push({ step: item.step, epoch: item.epoch, name: item.label, sizeMb: cfg.weightMb || 16, loss: training.loss.length ? training.loss[training.loss.length - 1].loss : lossAt(cfg, 0, points) });
            }
        } else if (item.kind === 'sample' || item.kind === 'finalSample') {
            if (!training.samples.some((s) => s.step === item.step && s.kind === item.kind)) {
                training.samples.push({
                    step: item.step || Math.round((cfg.steps || 0) * (task.progress / 100)),
                    kind: item.kind === 'finalSample' ? 'final' : 'epoch',
                    label: item.kind === 'finalSample' ? '终版对比' : `step ${item.step}`,
                    loss: training.loss.length ? training.loss[training.loss.length - 1].loss : null,
                    prompt: samplePrompt(cfg, training, item.kind),
                    image: img(samplePrompt(cfg, training, item.kind), 'square')
                });
            }
        }
        i += 1;
    }
    if (i !== emitted) training.emitted = i;

    // 确定性故障：已知的破坏性参数组合跑到对应阶段后终止（不靠随机骰子）
    if (training.expectFault && task.progress >= (training.faultAt || 55)) {
        return training.expectFault;
    }
    return null;
}

function outputImages(prompt, count = 2) {
    const base = prompt || 'aigc concept art';
    return Array.from({ length: count }, (_, i) => ({
        type: 'image',
        url: img(`${base}, variation ${i + 1}, high detail`),
        title: `output_${String(i + 1).padStart(4, '0')}.png`
    }));
}

/**
 * 合成完成后创建成片作品（kind: video，状态为草稿，由工作台引导提交发布）。
 * 封面沿用站点一致约定：默认取成片第 3 秒所在镜头的帧图。
 */
function createFilmWork(db, drama, task) {
    const sum = summaryOf(drama.shots || [], { model: drama.model, targetSec: drama.targetSec });
    const coverShot = shotAtSecond(drama.shots, 3) || drama.shots[0] || {};
    const cover = coverShot.output?.poster || img(`${coverShot.prompt || drama.title}, cinematic film still`);
    const work = {
        id: uid('video'),
        kind: 'video',
        subtype: drama.subtype || 'story',
        title: drama.title,
        desc: drama.desc || `由 ${sum.count} 个镜头合成的 ${sum.totalSec}s 短剧，全局影调「${toneName(drama.tone)}」，已逐镜头控制一致性。`,
        cover,
        mediaType: 'video',
        mediaUrl: VIDEO_SRC,
        duration: sum.totalSec,
        tags: ['短剧', '分镜合成', `${sum.count} 镜头`],
        prompt: String(drama.script || '').slice(0, 200),
        negative: drama.negative || 'low quality, blurry, watermark',
        params: { model: drama.model, ratio: drama.ratio, tone: drama.tone, shots: sum.count },
        authorId: drama.ownerId,
        status: 'draft',
        visibility: 'private',
        price: { mode: 'free', amount: 0 },
        stats: { views: 0, likes: 0, favorites: 0, comments: 0, remixes: 0 },
        createdAt: now(),
        updatedAt: now(),
        review: null,
        version: 1,
        sourceWorkId: null,
        relatedIds: [],
        meta: { dramaId: drama.id, shotCount: sum.count, totalSec: sum.totalSec, composeCost: task.cost },
        assetRefs: drama.assetRefs,
        ownerNote: ''
    };
    db.works.unshift(work);
    drama.workId = work.id;
    drama.cover = cover;
    return work;
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
        const drama = isShotTask(task) ? findDramaOf(db, task) : null;
        const shot = drama ? (drama.shots || []).find((s) => s.id === task.payload.shotId) : null;
        const sec = shot ? Number(shot.seconds) : Number(task.payload.duration) || 5;
        const poster = img(`${shot ? shot.prompt : task.payload.prompt || task.title}, cinematic still`);
        task.outputs = [
            {
                type: 'video',
                url: VIDEO_SRC,
                poster,
                seconds: sec,
                title: shot ? `${shotLabel(shot)} 片段（${sec}s）` : `生成的视频片段（${sec}s）`
            }
        ];
        if (shot) {
            // 镜头产物直接回写项目：工作台据此展示片段、判定能否进入合成
            shot.output = { url: VIDEO_SRC, poster, seconds: sec, cost: videoCost(drama.model, sec), no: shot.no };
            shot.status = 'succeeded';
            shot.error = null;
            applyTaskResult(drama, task, 'succeeded');
            if (drama.status === 'ready') {
                addNotification(db, {
                    userId: drama.ownerId,
                    type: 'task',
                    tone: 'ok',
                    title: '短剧镜头全部就绪',
                    body: `「${drama.title}」共 ${drama.shots.length} 个镜头已生成完成，可以回到工作台进行片段合成。`,
                    link: `assets/create-video.html?drama=${drama.id}&long=1`
                });
            }
        }
    } else if (task.type === 'script') {
        const drama = findDramaOf(db, task);
        if (drama) {
            drama.shots = parseScript({
                script: drama.script,
                targetSec: drama.targetSec,
                model: drama.model,
                tone: drama.tone,
                ratio: drama.ratio,
                negative: drama.negative,
                assetRefs: drama.assetRefs
            });
            applyTaskResult(drama, task, 'succeeded');
            const sum = summaryOf(drama.shots, { model: drama.model, targetSec: drama.targetSec });
            task.outputs = [{ type: 'text', title: `分镜表 · ${sum.count} 个镜头 / ${sum.totalSec}s`, text: formatStoryboard(drama) }];
            addNotification(db, {
                userId: drama.ownerId,
                type: 'task',
                tone: 'ok',
                title: '剧本解析完成',
                body: `「${drama.title}」已拆出 ${sum.count} 个镜头（合计 ${sum.totalSec}s，预估 ${sum.cost} 算力），请在工作台审核分镜。`,
                link: `assets/create-video.html?drama=${drama.id}&long=1`
            });
        }
    } else if (task.type === 'compose') {
        const drama = findDramaOf(db, task);
        if (drama) {
            const work = createFilmWork(db, drama, task);
            applyTaskResult(drama, task, 'succeeded');
            const sum = summaryOf(drama.shots, { model: drama.model, targetSec: drama.targetSec });
            task.outputs = [
                { type: 'video', url: VIDEO_SRC, poster: work.cover, seconds: sum.totalSec, title: `${drama.title} 成片（${sum.totalSec}s）`, workId: work.id }
            ];
            addNotification(db, {
                userId: drama.ownerId,
                type: 'task',
                tone: 'ok',
                title: '短剧合成完成',
                body: `「${drama.title}」已拼接为 ${sum.totalSec}s 成片（${sum.count} 个镜头），封面取第 3 秒，确认后可提交发布。`,
                link: `assets/create-video.html?drama=${drama.id}&long=1`
            });
        }
    } else if (task.type === 'app') {
        task.outputs = appOutputs(db, task);
    } else if (task.type === 'train') {
        const training = db.trainings.find((t) => t.id === task.payload.trainingId);
        if (training) {
            const cfg = training.config || {};
            const dataset = db.datasets.find((d) => d.id === training.datasetId) || {};
            advanceTraining(db, task, training);
            const points = cfg.lossPoints || 24;
            const loss = Array.isArray(training.loss) ? training.loss : [];
            while (loss.length < points) {
                const idx = loss.length;
                loss.push({ step: Math.round((cfg.steps || 1000) * ((idx + 1) / points)), loss: lossAt(cfg, idx, points) });
            }
            training.loss = loss;
            training.status = 'succeeded';
            training.epochsDone = cfg.epochs || training.epochsDone;
            training.finishedAt = now();
            training.durationMin = Math.max(1, Math.round((Date.now() - new Date(training.createdAt).getTime()) / 60000));
            const finalLoss = loss[loss.length - 1]?.loss ?? 0.06;
            if (!training.samples.some((s) => s.kind === 'final')) {
                training.samples.push({
                    step: cfg.steps || 0,
                    kind: 'final',
                    label: '终版对比',
                    loss: finalLoss,
                    prompt: samplePrompt(cfg, training, 'final'),
                    image: img(samplePrompt(cfg, training, 'final'), 'square')
                });
            }

            const model = {
                id: uid('m'),
                kind: 'model',
                subtype: 'art',
                title: training.name,
                desc: `基于「${dataset.name || '自制数据集'}」训练的 LoRA 模型，触发词 ${training.trigger}，rank ${cfg.rank} / alpha ${cfg.alpha}，${cfg.epochs} epoch。`,
                cover: img(`style sample from lora model ${training.name}, high detail`),
                mediaType: 'image',
                mediaUrl: null,
                duration: 0,
                tags: ['模型', 'LoRA', cfg.base],
                prompt: '',
                negative: '',
                params: { model: cfg.base, steps: 28, cfg: 6 },
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
                    base: cfg.base,
                    trigger: training.trigger,
                    rank: cfg.rank,
                    alpha: cfg.alpha,
                    steps: cfg.steps,
                    epochs: cfg.epochs,
                    lr: cfg.lr,
                    optimizer: cfg.optimizer,
                    scheduler: cfg.scheduler,
                    precision: cfg.precision,
                    resolution: cfg.resolution,
                    datasetName: dataset.name || '自制数据集',
                    size: `${cfg.weightMb || Math.max(6, Math.round((cfg.rank || 32) * 0.7))} MB`,
                    recommendedWeight: cfg.rank >= 64 ? 0.7 : 0.8,
                    downloads: 0,
                    loss: finalLoss,
                    trainingId: training.id
                },
                assetRefs: null,
                ownerNote: ''
            };
            db.works.unshift(model);
            training.modelId = model.id;
            task.outputs = [{ type: 'model', title: model.title, workId: model.id, url: model.cover }];
            task.outputs.push(...training.samples.slice(-3).map((s) => ({ type: 'image', url: s.image, title: `训练样张 @ step ${s.step}` })));
            addNotification(db, {
                userId: training.ownerId,
                type: 'task',
                tone: 'ok',
                title: 'LoRA 训练完成',
                body: `「${training.name}」跑完 ${cfg.epochs} epoch / ${cfg.steps} 步，最终 loss ${finalLoss}，已生成模型资产（${model.meta.size}）。`,
                link: `lora-train.html?training=${training.id}`
            });
        }
    }

    if (owner && task.type !== 'train' && !isShotTask(task) && !['script', 'compose'].includes(task.type)) {
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
    const failedAt = Math.round(task.progress || 0);
    task.status = 'failed';
    task.progress = task.type === 'train' ? failedAt : 100;
    task.finishedAt = now();
    task.error = reason;
    log(task, 'err', reason);
    // 短剧流水线：解析 / 镜头 / 合成失败都要把状态回写项目
    if (task.payload?.dramaId) {
        const drama = findDramaOf(db, task);
        if (drama) {
            applyTaskResult(drama, task, 'failed');
            if (isShotTask(task)) {
                const shot = (drama.shots || []).find((s) => s.id === task.payload.shotId);
                if (shot) log(task, 'warn', `${shotLabel(shot)} 可在工作台单独重试，不影响其他镜头`);
            }
        }
    }
    if (task.type === 'train') {
        const training = db.trainings.find((t) => t.id === task.payload.trainingId);
        if (training) {
            training.status = 'failed';
            training.error = reason;
            training.finishedAt = now();
            training.failedAtPct = failedAt;
            training.durationMin = Math.max(1, Math.round((Date.now() - new Date(training.createdAt).getTime()) / 60000));
        }
        log(task, 'warn', '已保存中断前的 loss 与 checkpoint，可在训练详情中「改参数重试」');
    }
    if (task.cost > 0) {
        // 失败全额退还，同样记到任务上，任务中心才能展示「实际消耗 0」
        task.refund = task.cost;
        addTransaction(db, task.ownerId, { type: 'refund', amount: task.cost, title: `任务失败退款 · ${task.title}`, refId: task.id });
    }
    addNotification(db, {
        userId: task.ownerId,
        type: 'task',
        tone: 'danger',
        title: `${task.title} 执行失败`,
        body: `${reason}，已自动退还 ${task.cost} 算力积分。`,
        link: task.type === 'train' ? `lora-train.html?training=${task.refId}` : 'tasks.html'
    });
}

function tick() {
    if (!acquireLock()) return;
    let snapshot = null;
    mutate((db) => {
        const active = db.tasks.filter((t) => t.status === 'queued' || t.status === 'running');
        // 两条独立队列：常规任务共用 MAX_CONCURRENCY，分镜镜头另用 MAX_BATCH_CONCURRENCY
        let running = active.filter((t) => t.status === 'running' && !isShotTask(t)).length;
        let batchRunning = active.filter((t) => t.status === 'running' && isShotTask(t)).length;
        active
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
            .forEach((task) => {
                if (task.status === 'queued') {
                    const batch = isShotTask(task);
                    if (batch ? batchRunning >= MAX_BATCH_CONCURRENCY : running >= MAX_CONCURRENCY) return;
                    task.status = 'running';
                    task.startedAt = now();
                    task.progress = Math.max(task.progress || 0, 2);
                    if (batch) batchRunning += 1;
                    else running += 1;
                    log(task, 'info', '已分配算力节点，任务开始执行');
                    // 训练记录与任务状态保持同步，否则训练页徽章会一直停在「排队中」
                    if (task.type === 'train') {
                        const training = db.trainings.find((t) => t.id === task.payload.trainingId);
                        if (training && training.status === 'queued') training.status = 'running';
                    }
                    if (task.payload?.dramaId && isShotTask(task)) {
                        const drama = findDramaOf(db, task);
                        const shot = drama ? (drama.shots || []).find((s) => s.id === task.payload.shotId) : null;
                        if (shot) shot.status = 'running';
                    }
                    snapshot = task;
                    return;
                }
                if (task.status === 'running') {
                    task.progress = Math.min(100, task.progress + stepFor(task));
                    applyStages(task, planFor(db, task));
                    let fault = null;
                    if (task.type === 'train') {
                        const training = db.trainings.find((t) => t.id === task.payload.trainingId);
                        if (training) fault = advanceTraining(db, task, training);
                    }
                    if (fault) {
                        failTask(db, task, fault);
                    } else if (task.progress >= 100) {
                        if (task.type === 'image' && String(task.payload.prompt || '').includes('__fail__')) {
                            failTask(db, task, '内容安全检查未通过');
                        } else if (task.type === 'video' && String(task.payload.prompt || '').includes('__fail__')) {
                            failTask(db, task, '镜头生成失败：运动幅度超出模型安全范围，已退还算力，可拆分时长后重试');
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
