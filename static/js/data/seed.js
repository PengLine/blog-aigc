import { SCHEMA_VERSION } from '../core/storage.js';
import { USERS } from './users.js';
import { WORKS } from './works.js';
import { APPS } from './apps.js';
import { WORKFLOWS, DATASETS } from './workflows.js';
import { normalizeConfig, buildTrainPlan, lossAt, samplePrompt } from '../core/training.js';
import {
    parseScript, formatStoryboard, summaryOf, shotLabel, shotAtSecond,
    scriptCost, videoCost, composeCost,
    buildParsePlan, buildComposePlan, buildShotPlan
} from '../core/drama.js';
import { TASK_TYPES } from '../core/constants.js';
import { daysAgo, img, VIDEO_SRC, DAY } from './media.js';

const ME = 'u_me';
const HOUR = 3600000;

function hhmm(offsetMinutes = 0) {
    const d = new Date(Date.now() - offsetMinutes * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clockOf(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 把过程计划按时间窗铺开成任务日志，与引擎真实推进的时序一致 */
function timedLogs(plan, fromMs, toMs) {
    const span = Math.max(1000, toMs - fromMs);
    return (plan || []).map((item, idx) => ({
        t: clockOf(new Date(fromMs + span * (plan.length > 1 ? idx / (plan.length - 1) : 1))),
        level: item.level || 'info',
        msg: item.msg
    }));
}

// 平台任务模板：用于生成近 7 天其他创作者的历史任务，让首页趋势、后台统计与任务表口径一致
const PLATFORM_JOBS = [
    { type: 'image', cost: 6, subject: 'neon cyberpunk portrait, rim light', titles: ['图片生成 · 霓虹人像', '图片生成 · 雨夜街角'] },
    { type: 'image', cost: 12, subject: 'traditional chinese architecture ink mood', titles: ['批量出图 · 国风场景 4 张'] },
    { type: 'video', cost: 30, subject: 'cinematic drone shot over snow mountains', titles: ['视频生成 · 雪山旅行短片', '视频生成 · 城市夜跑预告'] },
    { type: 'workflow', cost: 18, subject: 'rainy cyberpunk street wide shot', titles: ['工作流 · 文生图标准流', '工作流 · 短剧分镜出图'] },
    { type: 'app', cost: 9, subject: 'ecommerce product banner layout', titles: ['应用运行 · 电商主图工坊', '应用运行 · 小红书文案助手', '应用运行 · 短剧分镜工坊'] },
    { type: 'train', cost: 120, subject: 'soft portrait photography style', titles: ['LoRA 训练 · 日系柔光', 'LoRA 训练 · 水墨国风场景'] }
];

/** 生成平台历史任务（仅 succeeded / failed，避免被本地任务引擎重新执行） */
function buildPlatformTasks(users) {
    let acc = 20261030;
    const rand = () => {
        acc = (acc * 1103515245 + 12345) % 2147483648;
        return acc / 2147483648;
    };
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const owners = users.filter((u) => u.role !== 'ops' && u.id !== ME);
    const list = [];
    for (let day = 6; day >= 0; day -= 1) {
        const count = 3 + Math.floor(rand() * 4);
        for (let i = 0; i < count; i += 1) {
            const job = pick(PLATFORM_JOBS);
            const owner = pick(owners);
            const failed = rand() > 0.9;
            const hours = Math.floor(rand() * 11) + 1;
            const createdAt = daysAgo(day, hours);
            const outputs = failed || job.type === 'train'
                ? (failed ? [] : [{ type: 'model', title: pick(job.titles).replace('LoRA 训练 · ', '') + ' LoRA', workId: '', url: '' }])
                : Array.from({ length: job.type === 'workflow' ? 2 : 1 }, (_, k) => ({
                    type: job.type === 'video' ? 'video' : 'image',
                    url: img(`${job.subject}, take ${day}${i}-${k}`),
                    title: `output_${day}${i}_0${k + 1}.${job.type === 'video' ? 'mp4' : 'png'}`
                }));
            list.push({
                id: `t_p${day}${i}`,
                type: job.type,
                title: pick(job.titles),
                ownerId: owner.id,
                status: failed ? 'failed' : 'succeeded',
                progress: 100,
                cost: job.cost,
                payload: { prompt: job.subject },
                outputs,
                logs: [
                    { t: clockOf(createdAt), level: 'info', msg: '任务已进入队列并分配算力节点' },
                    { t: clockOf(daysAgo(day, Math.max(0, hours - 1))), level: failed ? 'error' : 'info', msg: failed ? '显存不足，任务中断' : '产物已写入资产存储' }
                ],
                createdAt,
                startedAt: createdAt,
                finishedAt: daysAgo(day, Math.max(0, hours - 1)),
                error: failed ? '显存不足，任务失败，积分已自动退还' : ''
            });
        }
    }
    return list;
}

function buildUsers(works, meAccount = {}) {
    return USERS.map((u) => {
        const published = works.filter((w) => w.authorId === u.id && w.status === 'published');
        return {
            ...u,
            // 演示账号的余额与本期净消耗由种子流水反推，保证钱包账本与任务计费同源
            ...(u.id === ME ? meAccount : {}),
            worksCount: published.length,
            likesReceived: published.reduce((sum, w) => sum + (w.stats?.likes || 0), 0)
        };
    });
}

/**
 * 账本重建：流水只写「金额 + 时间」，余额逐笔累加、id 按时间顺序下发，最后倒序输出。
 * 钱包页直接遍历 api.getAccount 返回的 transactions（服务端不排序），
 * 由代码推导 balanceAfter 能从结构上杜绝手写账本不闭合。
 */
function buildLedger(entries) {
    const asc = entries
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let balance = 0;
    const withBalance = asc.map((e, i) => {
        balance = Math.round((balance + Number(e.amount || 0)) * 100) / 100;
        return { id: `tx_${String(i + 1).padStart(3, '0')}`, userId: ME, ...e, balanceAfter: balance };
    });
    return withBalance.reverse();
}

/** 末笔余额 = 账户 credits；本期已用 = 30 天内消费与退款净额（与训练失败「一出一进」不计入净消耗保持一致） */
function accountOf(transactions) {
    const since = Date.now() - 30 * DAY;
    const net = transactions
        .filter((t) => ['consume', 'refund'].includes(t.type) && new Date(t.createdAt).getTime() >= since)
        .reduce((sum, t) => sum + t.amount, 0);
    return {
        credits: transactions[0]?.balanceAfter || 0,
        computeUsed: Math.max(0, Math.round(-net))
    };
}

function buildRelated(works) {
    const published = works.filter((w) => w.status === 'published');
    works.forEach((w) => {
        const pool = published.filter((x) => x.kind === w.kind && x.id !== w.id);
        const picked = [];
        for (let i = 0; i < Math.min(4, pool.length); i += 1) {
            picked.push(pool[(w.id.length * 3 + i * 2) % pool.length].id);
        }
        w.relatedIds = [...new Set(picked)];
    });
    return works;
}

export function buildSeed() {
    const works = buildRelated(
        WORKS.map((w) => {
            if (w.id === 'm_001') return { ...w, sourceWorkId: 'w_001' };
            if (w.id === 'm_010') return { ...w, sourceWorkId: 'w_011' };
            return w;
        })
    );

    const comments = [
        { id: 'c_001', workId: 'w_001', userId: 'u_suwan', content: '三视图的一致性很好，右臂结构可以直接拿去做分镜了。', likes: 24, createdAt: daysAgo(2, 4) },
        { id: 'c_002', workId: 'w_001', userId: 'u_aji', content: '能量刃的展开逻辑能给个提示词吗？想做成道具资产。', likes: 11, createdAt: daysAgo(2, 2) },
        { id: 'c_003', workId: 'w_001', userId: 'u_me', content: '已经复刻成「赛博少女·零」了，感谢开放参数 🙏', likes: 8, createdAt: daysAgo(1, 8) },
        { id: 'c_004', workId: 'w_005', userId: 'u_bailu', content: '这个光感太舒服了，准备用在小熊绘本第二册。', likes: 32, createdAt: daysAgo(6, 3) },
        { id: 'c_005', workId: 'w_006', userId: 'u_me', content: '第 37 秒那个镜头切换太妙了，请问是直接生成的还是后期剪的？', likes: 18, createdAt: daysAgo(0, 9) },
        { id: 'c_006', workId: 'w_006', userId: 'u_suwan', content: '生成 4 个机位后剪的，工作流模板已经放到「短剧分镜出图」里了。', likes: 41, createdAt: daysAgo(0, 7) },
        { id: 'c_007', workId: 'w_018', userId: 'u_zhixia', content: '断剑的质感这次用了新的 LoRA，细节比上一版好很多。', likes: 15, createdAt: daysAgo(19, 2) },
        { id: 'c_008', workId: 'm_001', userId: 'u_zhixia', content: '同款做得不错，白发的层次保留住了。', likes: 6, createdAt: daysAgo(1, 5) },
        { id: 'c_009', workId: 'w_003', userId: 'u_me', content: '体积光的部分能分享一下参数吗？', likes: 4, createdAt: daysAgo(5, 6) },
        { id: 'c_010', workId: 'w_017', userId: 'u_moqi', content: '收藏了，下期旅行视频就用这个色调。', likes: 9, createdAt: daysAgo(15, 8) }
    ].map((c) => ({ ...c, parentId: null }));

    const reactions = [
        { userId: ME, type: 'like', workId: 'w_001', at: daysAgo(2) },
        { userId: ME, type: 'like', workId: 'w_005', at: daysAgo(6) },
        { userId: ME, type: 'like', workId: 'w_006', at: daysAgo(1) },
        { userId: ME, type: 'like', workId: 'w_018', at: daysAgo(18) },
        { userId: ME, type: 'favorite', workId: 'w_006', at: daysAgo(1) },
        { userId: ME, type: 'favorite', workId: 'w_018', at: daysAgo(18) },
        { userId: ME, type: 'favorite', workId: 'w_003', at: daysAgo(4) },
        { userId: ME, type: 'favorite', workId: 'w_009', at: daysAgo(10) },
        { userId: 'u_zhixia', type: 'like', workId: 'm_001', at: daysAgo(1, 5) },
        { userId: 'u_zhixia', type: 'favorite', workId: 'm_001', at: daysAgo(1, 5) },
        { userId: 'u_bailu', type: 'like', workId: 'm_001', at: daysAgo(1, 2) }
    ];

    const follows = [
        { followerId: ME, followeeId: 'u_zhixia', at: daysAgo(120) },
        { followerId: ME, followeeId: 'u_jianshan', at: daysAgo(96) },
        { followerId: ME, followeeId: 'u_suwan', at: daysAgo(64) },
        { followerId: 'u_bailu', followeeId: ME, at: daysAgo(30) },
        { followerId: 'u_moqi', followeeId: ME, at: daysAgo(22) },
        { followerId: 'u_aji', followeeId: ME, at: daysAgo(12) }
    ];

    const models = works.filter((w) => w.kind === 'model');

    /*
     * 训练历史直接用与前端/引擎同一套领域函数生成（配置归一化 → 阶段计划 → loss / checkpoint / 样张），
     * 避免种子数据里出现与真实训练不一致的魔法数字。
     */
    function trainFixture(spec) {
        const ds = DATASETS.find((d) => d.id === spec.datasetId) || { count: 42, tagged: 42 };
        const config = normalizeConfig(spec.config, ds);
        // 种子流水（tx_004 / tx_007）里的金额已纳入余额链，因此历史训练固定按 120 计费
        if (spec.cost) config.estimateCost = spec.cost;
        const plan = buildTrainPlan(config, ds, spec.trigger);
        const points = config.lossPoints;
        const cut = spec.status === 'failed' ? Math.max(1, Math.round(points * (spec.failedPct || 36) / 100)) : points;
        const loss = Array.from({ length: cut }, (_, i) => ({
            step: Math.round((config.steps * (i + 1)) / points),
            loss: lossAt(config, i, points)
        }));
        const atStepLoss = (step) => lossAt(config, Math.round((step / Math.max(1, config.steps)) * (points - 1)), points);
        const reached = loss.length ? loss[loss.length - 1].step : 0;
        const checkpoints = plan
            .filter((i) => i.kind === 'ckpt')
            .filter((i) => i.step <= reached)
            .map((i) => ({ step: i.step, epoch: i.epoch, name: i.label, sizeMb: config.weightMb, loss: atStepLoss(i.step) }));
        const samples = plan
            .filter((i) => i.kind === 'sample' || i.kind === 'finalSample')
            .filter((i) => (i.step || config.steps) <= reached)
            .map((i) => {
                const step = i.step || config.steps;
                const prompt = samplePrompt(config, { trigger: spec.trigger }, i.kind);
                return { step, kind: i.kind === 'finalSample' ? 'final' : 'epoch', label: i.kind === 'finalSample' ? '终版对比' : `step ${step}`, loss: atStepLoss(step), prompt, image: img(prompt, 'square') };
            });
        const cutAt = spec.status === 'failed' ? spec.failedPct || 36 : 100;
        // 日志时刻按 createdAt → finishedAt 均匀铺开，与这条历史记录的真实时间线对齐
        const reachedPlan = plan.filter((i) => i.at <= cutAt);
        const from = new Date(spec.createdAt).getTime();
        const to = new Date(spec.finishedAt || Date.now()).getTime();
        const logs = reachedPlan.map((i, idx) => ({
            t: clockOf(new Date(from + (to - from) * (reachedPlan.length > 1 ? idx / (reachedPlan.length - 1) : 1))),
            level: i.level || 'info',
            msg: i.msg
        }));
        const epochDone = reachedPlan.filter((i) => i.kind === 'epoch').map((i) => i.epoch);
        return {
            id: spec.id,
            name: spec.name,
            ownerId: ME,
            datasetId: spec.datasetId,
            taskId: spec.taskId,
            modelId: spec.modelId || null,
            status: spec.status,
            trigger: spec.trigger,
            config,
            loss,
            samples,
            checkpoints,
            epochsDone: epochDone.length ? Math.max(...epochDone) : 0,
            emitted: logs.length,
            createdAt: spec.createdAt,
            finishedAt: spec.finishedAt,
            durationMin: spec.durationMin,
            estimateMin: config.estimateMin,
            failedAtPct: spec.status === 'failed' ? spec.failedPct || 36 : null,
            error: spec.error || null,
            autoPublish: !!spec.autoPublish,
            _logs: logs
        };
    }

    const trainingFixtures = [
        trainFixture({
            id: 'tr_001',
            name: '灵犀人像 LoRA',
            datasetId: 'ds_001',
            taskId: 't_003',
            modelId: 'm_008',
            status: 'succeeded',
            trigger: 'lxportrait',
            cost: 120,
            config: { base: 'SDXL 1.0', mode: 'standard', rank: 32, alpha: 16, lr: 0.0001, batch: 2, gradAccum: 1, resolution: '1024', epochs: 20, dropout: 0.1, optimizer: 'AdamW8bit', scheduler: 'cosine', precision: 'bf16', seed: 20260213, clipSkip: 2, noiseOffset: true, savePerEpoch: 4, trainTextEncoder: false },
            createdAt: daysAgo(20, 5),
            finishedAt: daysAgo(20, 1),
            durationMin: 236,
            autoPublish: true
        }),
        trainFixture({
            id: 'tr_002',
            name: '赛博街景 LoRA',
            datasetId: 'ds_002',
            taskId: 't_008',
            status: 'failed',
            failedPct: 36,
            cost: 120,
            trigger: 'cyberstreet',
            config: { base: 'SD 1.5', mode: 'quick', rank: 16, alpha: 8, lr: 0.0002, batch: 4, gradAccum: 1, resolution: '1216', epochs: 12, dropout: 0.15, optimizer: 'AdamW8bit', scheduler: 'linear', precision: 'fp16', seed: -1, clipSkip: 1, noiseOffset: false, savePerEpoch: 4, trainTextEncoder: false },
            createdAt: daysAgo(7, 3),
            finishedAt: daysAgo(7, 2),
            durationMin: 68,
            error: 'CUDA out of memory：显存不足，请降低 batch size 或分辨率后重试'
        })
    ];

    const trainings = trainingFixtures.map(({ _logs, ...rest }) => rest);
    const trainingTaskLogs = { t_003: trainingFixtures[0]._logs, t_008: trainingFixtures[1]._logs };

    /*
     * 长剧本短剧（>15 秒）历史项目：与前端 / 引擎共用同一套领域函数生成
     * （剧本解析 → 逐镜头片段 → 片段合成），镜头数、时长配平、逐笔计费全部复算，
     * 因此种子里的分镜表、任务产物和钱包流水不会与真实流水线口径打架。
     */
    function dramaFixture(spec) {
        const project = {
            id: spec.id,
            ownerId: spec.ownerId,
            title: spec.title,
            script: spec.script,
            targetSec: spec.targetSec,
            model: spec.model,
            tone: spec.tone,
            ratio: spec.ratio,
            negative: 'low quality, blurry, watermark, extra fingers, inconsistent face',
            assetRefs: spec.assetRefs
        };
        const shots = parseScript(project);
        const sum = summaryOf(shots, { model: spec.model, targetSec: spec.targetSec });
        const parseCost = scriptCost(spec.targetSec, spec.script.length);
        const composePrice = composeCost(sum.totalSec, sum.count);
        const from = new Date(spec.createdAt).getTime();
        const to = new Date(spec.finishedAt || Date.now()).getTime();
        const span = Math.max(HOUR, to - from);
        const at = (pct) => new Date(from + span * pct).toISOString();
        const pad2 = (n) => String(n).padStart(2, '0');
        const tid = (i) => (spec.taskIds && spec.taskIds[i]) || `${spec.id}_t${i}`;
        const mine = spec.ownerId === ME;
        const finished = spec.status === 'done';
        // 成片封面沿用站点约定：取第 3 秒所在镜头的帧图，并与作品封面保持一致
        const coverShot = shotAtSecond(shots, 3);
        const workCover = spec.workId ? (works.find((w) => w.id === spec.workId) || {}).cover : '';
        const posterOf = (shot) => (shot === coverShot && workCover) ? workCover : img(`${shot.prompt}, cinematic still`);
        const tasks = [];
        const ledger = [];
        let txSeq = 0;
        // 他人的项目不进「我的任务中心」与钱包账本，只作为广场成片的分镜来源
        const charge = (task) => {
            if (!mine) return;
            txSeq += 1;
            ledger.push({
                type: 'consume',
                amount: -task.cost,
                title: `${(TASK_TYPES[task.type] || {}).name || task.type} · ${task.title}`,
                refId: task.id,
                createdAt: task.createdAt
            });
        };

        // ① 长剧本解析：真实计费的独立任务，不是前端假动画
        const parseTask = {
            id: tid(0),
            type: 'script',
            title: `${spec.title} · 长剧本解析`,
            ownerId: spec.ownerId,
            status: 'succeeded',
            progress: 100,
            cost: parseCost,
            payload: { dramaId: spec.id, targetSec: spec.targetSec, script: spec.script, model: spec.model },
            outputs: [{ type: 'text', title: `分镜表 · ${sum.count} 个镜头 / ${sum.totalSec}s`, text: formatStoryboard({ shots }) }],
            logs: [{ t: clockOf(spec.createdAt), level: 'info', msg: `解析任务已排队（${spec.script.length} 字 · 目标 ${spec.targetSec}s · 预算 ${parseCost} 算力）` },
                ...timedLogs(buildParsePlan({ ...project, shots }), from, from + span * 0.14)],
            createdAt: spec.createdAt,
            startedAt: at(0.02),
            finishedAt: at(0.14),
            error: null,
            refId: spec.id
        };
        if (mine) {
            tasks.push(parseTask);
            charge(parseTask);
        }

        // ③ 片段生成：每镜头一条独立任务，单独计费、单独取消、单独重试
        if (finished) {
            const pStart = 0.18;
            const pEnd = 0.74;
            shots.forEach((shot, i) => {
                const s0 = pStart + (pEnd - pStart) * (i / shots.length);
                const s1 = pStart + (pEnd - pStart) * ((i + 1) / shots.length);
                const cost = videoCost(spec.model, shot.seconds);
                const still = posterOf(shot);
                shot.cost = cost;
                shot.status = 'succeeded';
                shot.taskId = mine ? tid(i + 1) : '';
                shot.output = { url: VIDEO_SRC, poster: still, seconds: shot.seconds, cost, no: shot.no };
                const task = {
                    id: shot.taskId || `${spec.id}_sh${shot.no}`,
                    type: 'video',
                    title: `${spec.title} · 镜头 ${pad2(shot.no)}（${shot.seconds}s）`,
                    ownerId: spec.ownerId,
                    status: 'succeeded',
                    progress: 100,
                    cost,
                    payload: {
                        dramaId: spec.id,
                        shotId: shot.id,
                        shotNo: shot.no,
                        prompt: shot.prompt,
                        negative: shot.negative,
                        model: spec.model,
                        duration: shot.seconds,
                        ratio: spec.ratio,
                        kind: 'video'
                    },
                    outputs: [{ type: 'video', url: VIDEO_SRC, poster: still, seconds: shot.seconds, title: `${shotLabel(shot)} 片段（${shot.seconds}s）` }],
                    logs: timedLogs(buildShotPlan(shot, spec.model, spec.tone), from + span * s0, from + span * s1),
                    createdAt: at(s0),
                    startedAt: at(s0 + 0.005),
                    finishedAt: at(s1),
                    error: null,
                    refId: spec.id
                };
                if (mine) {
                    tasks.push(task);
                    charge(task);
                }
            });
        }

        // ④ 片段合成：拼接成片 + 抽帧封面，产物直接落地为一条视频作品
        let composeTask = null;
        if (finished) {
            composeTask = {
                id: tid(shots.length + 1),
                type: 'compose',
                title: `${spec.title} · 片段合成（${sum.totalSec}s）`,
                ownerId: spec.ownerId,
                status: 'succeeded',
                progress: 100,
                cost: composePrice,
                payload: { dramaId: spec.id, totalSec: sum.totalSec, shotCount: sum.count, model: spec.model, tone: spec.tone, ratio: spec.ratio },
                outputs: [{ type: 'video', url: VIDEO_SRC, poster: workCover || posterOf(coverShot || shots[0] || {}), seconds: sum.totalSec, title: `${spec.title} 成片（${sum.totalSec}s）`, workId: spec.workId }],
                logs: timedLogs(buildComposePlan({ ...project, shots }), from + span * 0.76, to),
                createdAt: at(0.76),
                startedAt: at(0.77),
                finishedAt: spec.finishedAt,
                error: null,
                refId: spec.id
            };
            if (mine) {
                tasks.push(composeTask);
                charge(composeTask);
            }
        }

        const drama = {
            ...project,
            subtype: spec.subtype || 'story',
            status: spec.status,
            shots,
            parseTaskId: mine ? parseTask.id : '',
            composeTaskId: mine && composeTask ? composeTask.id : '',
            workId: spec.workId || null,
            cover: finished ? (workCover || posterOf(coverShot || shots[0] || {})) : '',
            parseCost,
            composeCost: finished ? composePrice : 0,
            totalCost: parseCost + (finished ? sum.cost + composePrice : 0),
            confirmedAt: finished ? at(0.16) : null,
            createdAt: spec.createdAt,
            updatedAt: finished ? spec.finishedAt : at(0.14)
        };
        return { drama, tasks, ledger };
    }

    const dramaFixtures = [
        dramaFixture({
            id: 'dr_001',
            ownerId: 'u_suwan',
            title: '星际信使 第01集',
            targetSec: 90,
            model: 'kling-v',
            tone: 'cold',
            ratio: '9:16',
            subtype: 'technology',
            workId: 'w_006',
            status: 'done',
            createdAt: daysAgo(2, 2),
            finishedAt: daysAgo(1),
            assetRefs: { character: ['w_001', 'w_015'], prop: ['w_004'], scenic: ['w_003'] },
            script: '信使在废弃空间站的休眠舱里醒来。舱壁的警报灯仍在闪烁。'
                + '他读到自己脑中一段不该存在的记忆。记忆属于三年前失踪的领航员。'
                + '走廊空无一人，只剩冷光。他沿着通道走向舰桥。舱门外是静止的行星环。'
                + '舰桥终端自动回放了最后的求救信号。信号坐标指向他自己的飞船。'
                + '他握紧了口袋里的数据钥匙。空间站开始坠入大气层。他按下跳跃键，画面留在燃烧的舱影。'
        }),
        dramaFixture({
            id: 'dr_002',
            ownerId: ME,
            title: '需虹夜行',
            targetSec: 60,
            model: 'kling-v',
            tone: 'neon',
            ratio: '9:16',
            subtype: 'story',
            status: 'storyboard',
            createdAt: daysAgo(1, 6),
            finishedAt: daysAgo(1, 5),
            taskIds: ['t_017'],
            assetRefs: { character: ['m_001'], prop: [], scenic: ['m_007'] },
            script: '暴雨刚停，需虹灯牌在积水里碎成一片。少女从后巷走出来，压低帽檐。'
                + '她要在天亮前送完最后一只包裹。街口传来追逐的引擎声。'
                + '她拐进一间还亮着灯的修车铺。老板认出了包裹上的封条。'
                + '两人隔着雨棚对话，谁都没有动手。远处传来警笛，她转身消失在巷尾。'
        }),
        dramaFixture({
            id: 'dr_003',
            ownerId: ME,
            title: '老城巷口',
            targetSec: 30,
            model: 'kling-v',
            tone: 'warm',
            ratio: '16:9',
            subtype: 'travel',
            workId: 'm_009',
            status: 'done',
            createdAt: daysAgo(3, 10),
            finishedAt: daysAgo(3, 1),
            taskIds: ['t_010', 't_011', 't_012', 't_013', 't_014', 't_015', 't_016'],
            assetRefs: { character: [], prop: [], scenic: [] },
            script: '清晨的老城巷口，石板路还带着昨夜的湿意。一辆自行车斜靠在斑驳的门框边。'
                + '店主推开木门，门轴发出一声轻响。阳光顺着屋檐滑下来，落在热气腾腾的豆浆碗上。'
                + '巷子尽头有人转身，镜头留在空荡的石板路上。'
        })
    ];

    const dramas = dramaFixtures.map((f) => f.drama);
    const dramaTasks = dramaFixtures.flatMap((f) => f.tasks);
    const dramaLedger = dramaFixtures.flatMap((f) => f.ledger);
    const filmDone = dramas.find((d) => d.id === 'dr_003');
    const filmReview = dramas.find((d) => d.id === 'dr_002');

    const tasks = [
        {
            id: 't_run',
            type: 'image',
            title: '夜市小摊 · 封面图',
            ownerId: ME,
            status: 'running',
            progress: 42,
            cost: 6,
            payload: { prompt: '夜市烧烤摊，暖色灯光与烟火气，竖屏构图', model: 'lingxi-xl', ratio: '9:16', kind: 'video' },
            outputs: [],
            logs: [
                { t: hhmm(3), level: 'info', msg: '任务已进入标准队列，等待 GPU 分配' },
                { t: hhmm(2), level: 'info', msg: '已分配节点 gpu-a100-07，开始加载模型 lingxi-xl' },
                { t: hhmm(2), level: 'info', msg: '采样进度 12/28，预计剩余 18 秒' }
            ],
            createdAt: new Date(Date.now() - 3 * 60000).toISOString(),
            startedAt: new Date(Date.now() - 2 * 60000).toISOString(),
            finishedAt: null,
            error: null,
            refId: ''
        },
        {
            id: 't_001',
            type: 'image',
            title: '赛博少女·零 三视图',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 8,
            payload: { prompt: 'cyberpunk white haired girl, holographic jacket, character turnaround sheet', model: 'flux-dev', ratio: '4:3' },
            outputs: [
                { type: 'image', url: works.find((w) => w.id === 'm_001').cover, title: '三视图 v3' },
                { type: 'image', url: img('cyberpunk girl close up portrait, white hair, neon reflections'), title: '面部特写' }
            ],
            logs: [
                { t: '14:02:11', level: 'info', msg: '任务进入高优先级队列' },
                { t: '14:02:13', level: 'info', msg: '加载 FLUX.1 dev 权重完成' },
                { t: '14:02:19', level: 'ok', msg: '采样完成，生成 2 张结果' }
            ],
            createdAt: daysAgo(2, 6),
            startedAt: daysAgo(2, 6),
            finishedAt: daysAgo(2, 6),
            error: null,
            refId: ''
        },
        {
            id: 't_002',
            type: 'video',
            title: '星际信使 · 第 1 集预览',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 30,
            payload: { prompt: 'sci-fi vertical short film, abandoned space station, blue light', model: 'kling-v', duration: 5 },
            outputs: [{ type: 'video', url: works.find((w) => w.id === 'm_009').cover, title: '预览片段（5s）' }],
            logs: [
                { t: '09:41:02', level: 'info', msg: '开始视频生成，时长 5s / 720p' },
                { t: '09:43:50', level: 'ok', msg: '渲染完成，已生成预览片段' }
            ],
            createdAt: daysAgo(4, 8),
            startedAt: daysAgo(4, 8),
            finishedAt: daysAgo(4, 8),
            error: null,
            refId: ''
        },
        {
            id: 't_003',
            type: 'train',
            title: '灵犀人像 LoRA 训练',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 120,
            payload: { datasetId: 'ds_001', trainingId: 'tr_001', base: 'SDXL 1.0', rank: 32, steps: trainings[0].config.steps, lr: trainings[0].config.lr },
            outputs: [{ type: 'model', url: '', title: '灵犀人像 LoRA', workId: 'm_008' }],
            logs: trainingTaskLogs.t_003,
            createdAt: daysAgo(20, 5),
            startedAt: daysAgo(20, 5),
            finishedAt: daysAgo(20, 1),
            error: null,
            refId: 'tr_001'
        },
        {
            id: 't_004',
            type: 'app',
            title: '短剧分镜工坊 · 8 镜头',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 15,
            payload: { appId: 'app_003', inputs: { story: '快递员在末日城市送最后一单', shots: '8', tone: 'tense' } },
            outputs: [{ type: 'text', url: '', title: '分镜脚本（8 镜头）' }],
            logs: [
                { t: '11:20:05', level: 'info', msg: '应用 app_003 开始运行' },
                { t: '11:20:31', level: 'ok', msg: '生成完成，共 8 个镜头' }
            ],
            createdAt: daysAgo(9, 2),
            startedAt: daysAgo(9, 2),
            finishedAt: daysAgo(9, 2),
            error: null,
            refId: 'app_003'
        },
        {
            id: 't_005',
            type: 'image',
            title: '雨林遗迹 · 场景探索',
            ownerId: ME,
            status: 'failed',
            progress: 100,
            cost: 6,
            // 失败全额退还，与下面的退款流水成对（净额 0）
            refund: 6,
            payload: { prompt: 'ancient ruins in tropical rainforest, god rays', model: 'lingxi-xl' },
            outputs: [],
            logs: [
                { t: '16:05:01', level: 'info', msg: '任务开始' },
                { t: '16:05:14', level: 'err', msg: '内容安全检查未通过：疑似包含真实文物保护单位地标' }
            ],
            createdAt: daysAgo(15, 6),
            startedAt: daysAgo(15, 6),
            finishedAt: daysAgo(15, 6),
            error: '内容安全检查未通过，积分已自动退还',
            refId: ''
        },
        {
            id: 't_006',
            type: 'workflow',
            title: '文生图标准流 · 4 张',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 18,
            payload: { workflowId: 'wf_001', count: 4 },
            outputs: [
                { type: 'image', url: img('rainy cyberpunk street, white haired girl with umbrella, cinematic'), title: 'output_0001.png' },
                { type: 'image', url: img('rainy cyberpunk street, neon reflection, cinematic wide shot'), title: 'output_0002.png' }
            ],
            logs: [
                { t: '22:10:00', label: '', level: 'info', msg: '工作流 wf_001 开始执行（6 个节点）' },
                { t: '22:10:12', level: 'ok', msg: '全部节点执行完成，产物 4 个' }
            ],
            createdAt: daysAgo(11, 2),
            startedAt: daysAgo(11, 2),
            finishedAt: daysAgo(11, 2),
            error: null,
            refId: 'wf_001'
        },
        {
            id: 't_007',
            type: 'image',
            title: '星河少女 · 概念图',
            ownerId: ME,
            status: 'canceled',
            progress: 68,
            cost: 6,
            // 非训练任务取消为全额退还，与下面的退款流水一出一进对齐
            refund: 6,
            payload: { prompt: 'girl among stars, concept art', model: 'sd15' },
            outputs: [],
            logs: [
                { t: '10:02:01', level: 'info', msg: '任务开始' },
                { t: '10:02:48', level: 'warn', msg: '用户主动取消任务' }
            ],
            createdAt: daysAgo(6, 7),
            startedAt: daysAgo(6, 7),
            finishedAt: daysAgo(6, 7),
            error: null,
            refId: ''
        },
        {
            id: 't_008',
            type: 'train',
            title: '赛博街景 LoRA 训练',
            ownerId: ME,
            status: 'failed',
            progress: 36,
            cost: 120,
            refund: 120,
            payload: { datasetId: 'ds_002', trainingId: 'tr_002', base: 'SD 1.5', rank: 16, steps: trainings[1].config.steps, lr: trainings[1].config.lr },
            outputs: [],
            logs: [...trainingTaskLogs.t_008, { t: clockOf(daysAgo(7, 2)), level: 'err', msg: 'CUDA out of memory，训练中断' }],
            createdAt: daysAgo(7, 3),
            startedAt: daysAgo(7, 3),
            finishedAt: daysAgo(7, 2),
            error: '显存不足，任务失败，积分已自动退还',
            refId: 'tr_002'
        },
        {
            id: 't_009',
            type: 'app',
            title: '电商主图生成 · 运行',
            ownerId: ME,
            status: 'succeeded',
            progress: 100,
            cost: 8,
            payload: { appId: 'app_004', appName: '电商主图生成', inputs: { product: '磨砂银蓝牙耳机', scene: 'studio' } },
            outputs: [{ type: 'image', url: img('ecommerce product banner, frosted silver bluetooth earphone, studio light'), title: 'main_0001.png' }],
            logs: [
                { t: '13:41:02', level: 'info', msg: '应用 app_004 开始运行' },
                { t: '13:41:19', level: 'ok', msg: '生成完成，产物 1 个' }
            ],
            createdAt: daysAgo(2, 5),
            startedAt: daysAgo(2, 5),
            finishedAt: daysAgo(2, 5),
            error: null,
            refId: 'app_004'
        }
    ];

    /*
     * 账本由任务表反推：每一笔 consume / refund 都对应一条真实任务，
     * 金额取 task.cost、退还取 task.refund、时刻取任务创建 / 完成时间，
     * 不会再出现「流水有笔扣费但找不到对应任务」的演示派生数据不同步。
     */
    const taskLedger = tasks
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .flatMap((t) => {
            const rows = [];
            if (t.ownerId === ME && t.cost > 0) {
                rows.push({
                    type: 'consume',
                    amount: -t.cost,
                    title: `${(TASK_TYPES[t.type] || {}).name || t.type} · ${t.title}`,
                    refId: t.id,
                    createdAt: t.createdAt
                });
            }
            // 失败 / 取消任务把「扣除」与「退还」都入账，钱包里能看到完整计费链路（一出一进，净额不变）
            if (t.ownerId === ME && t.refund > 0) {
                rows.push({
                    type: 'refund',
                    amount: t.refund,
                    title: `${t.status === 'canceled' ? '任务取消退款' : '任务失败退款'} · ${t.title}`,
                    refId: t.id,
                    createdAt: t.finishedAt || t.createdAt
                });
            }
            return rows;
        });

    const transactions = buildLedger([
        { type: 'bonus', amount: 200, title: '新用户算力礼包', refId: '', createdAt: daysAgo(430) },
        { type: 'recharge', amount: 1200, title: '充值 1200 算力积分', refId: 'pkg_1200', createdAt: daysAgo(120, 3) },
        ...taskLedger,
        // 短剧流水线（>15 秒）：解析 / 逐镜头 / 合成，每一笔都是真任务真扣费
        ...dramaLedger.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    ]);

    const account = accountOf(transactions);
    const users = buildUsers(works, account);

    // 平台历史任务与「我的」任务合并后按时间倒序，与真实后端的任务表行为一致
    const allTasks = [...tasks, ...dramaTasks, ...buildPlatformTasks(users)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const notifications = [
        { id: 'n_001', userId: ME, type: 'review', tone: 'ok', title: '作品审核通过', body: '「赛博少女·零」已通过审核并发布到作品广场。', link: 'assets/character-detail.html?id=m_001', read: false, createdAt: daysAgo(1, 4) },
        { id: 'n_002', userId: ME, type: 'review', tone: 'danger', title: '作品未通过审核', body: '「雨林遗迹」疑似包含真实文保地标，请调整提示词后重新提交。', link: 'assets/scenic-detail.html?id=m_007', read: false, createdAt: daysAgo(14) },
        { id: 'n_003', userId: ME, type: 'task', tone: 'ok', title: 'LoRA 训练完成', body: `「灵犀人像 LoRA」跑完 ${trainings[0].config.epochs} epoch / ${trainings[0].config.steps} 步，最终 loss ${trainings[0].loss[trainings[0].loss.length - 1].loss}，已生成模型资产。`, link: 'lora-train.html?training=tr_001', read: false, createdAt: daysAgo(20, 1) },
        { id: 'n_004', userId: ME, type: 'social', tone: 'brand', title: '沈知夏 赞了你的作品', body: '「赛博少女·零」收到 1 个新点赞。', link: 'assets/character-detail.html?id=m_001', read: true, createdAt: daysAgo(1, 5) },
        { id: 'n_005', userId: ME, type: 'social', tone: 'brand', title: '白露 关注了你', body: '你们都喜欢「亲子」「绘本」相关内容。', link: 'profile.html?uid=u_bailu', read: true, createdAt: daysAgo(30) },
        { id: 'n_006', userId: ME, type: 'billing', tone: 'warn', title: '算力积分到账', body: `专业版月度 3000 积分将于 12 天后重置，当前余额 ${account.credits}。`, link: 'wallet.html', read: true, createdAt: daysAgo(18) },
        { id: 'n_007', userId: ME, type: 'system', tone: 'brand', title: '平台公告：工作流 v2 上线', body: '新增节点级重试与产物对比，历史工作流自动升级。', link: 'ai-workflow-execute.html?workflow=wf_001', read: true, createdAt: daysAgo(9) },
        { id: 'n_008', userId: ME, type: 'task', tone: 'ok', title: '短剧合成完成', body: `「${filmDone.title}」已拼接为 ${summaryOf(filmDone.shots, { model: filmDone.model }).totalSec}s 成片（${filmDone.shots.length} 个镜头），封面取第 3 秒，确认后可提交发布。`, link: `assets/create-video.html?drama=${filmDone.id}&long=1`, read: false, createdAt: daysAgo(3, 1) },
        { id: 'n_009', userId: ME, type: 'task', tone: 'warn', title: '剧本解析完成', body: `「${filmReview.title}」已拆出 ${filmReview.shots.length} 个镜头（合计 ${summaryOf(filmReview.shots, { model: filmReview.model, targetSec: filmReview.targetSec }).totalSec}s），请在工作台审核分镜后再生成片段。`, link: `assets/create-video.html?drama=${filmReview.id}&long=1`, read: false, createdAt: daysAgo(1, 5) }
    ];

    return {
        version: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        users,
        works,
        apps: APPS,
        workflows: WORKFLOWS,
        datasets: DATASETS,
        trainings,
        dramas,
        tasks: allTasks,
        comments,
        reactions,
        follows,
        transactions,
        notifications,
        meta: {
            product: '灵犀 AIGC',
            demoUser: ME,
            seededAt: new Date().toISOString(),
            note: '演示数据，支持在个人中心重置'
        }
    };
}
