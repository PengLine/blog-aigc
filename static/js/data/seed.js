import { SCHEMA_VERSION } from '../core/storage.js';
import { USERS } from './users.js';
import { WORKS } from './works.js';
import { APPS } from './apps.js';
import { WORKFLOWS, DATASETS } from './workflows.js';
import { normalizeConfig, buildTrainPlan, lossAt, samplePrompt } from '../core/training.js';
import { daysAgo, img } from './media.js';

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

function buildUsers(works) {
    return USERS.map((u) => {
        const published = works.filter((w) => w.authorId === u.id && w.status === 'published');
        return {
            ...u,
            worksCount: published.length,
            likesReceived: published.reduce((sum, w) => sum + (w.stats?.likes || 0), 0)
        };
    });
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

    const users = buildUsers(works);

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
            payload: { datasetId: 'ds_002', trainingId: 'tr_002', base: 'SD 1.5', rank: 16, steps: trainings[1].config.steps, lr: trainings[1].config.lr },
            outputs: [],
            logs: [...trainingTaskLogs.t_008, { t: clockOf(daysAgo(7, 2)), level: 'err', msg: 'CUDA out of memory，训练中断' }],
            createdAt: daysAgo(7, 3),
            startedAt: daysAgo(7, 3),
            finishedAt: daysAgo(7, 2),
            error: '显存不足，任务失败，积分已自动退还',
            refId: 'tr_002'
        }
    ];

    // 平台历史任务与「我的」任务合并后按时间倒序，与真实后端的任务表行为一致
    const allTasks = [...tasks, ...buildPlatformTasks(users)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // 流水按时间倒序，balanceAfter 沿时间轴连续推演，末笔余额与账户 credits（1160）对齐
    // 失败训练把「扣除」与「退还」两笔都入账，钱包里能看到完整计费链路（一出一进，净额不变）
    const transactions = [
        { id: 'tx_010', userId: ME, type: 'consume', amount: -6, balanceAfter: 1160, title: '图片生成 · 夜市小摊封面图', refId: 't_run', createdAt: new Date(Date.now() - 3 * 60000).toISOString() },
        { id: 'tx_009', userId: ME, type: 'consume', amount: -9, balanceAfter: 1166, title: '应用运行 · 电商主图工坊', refId: 't_004', createdAt: daysAgo(2, 5) },
        { id: 'tx_008', userId: ME, type: 'consume', amount: -42, balanceAfter: 1175, title: '批量出图 · 分镜 4 张', refId: 't_006', createdAt: daysAgo(5, 2) },
        { id: 'tx_007', userId: ME, type: 'refund', amount: 120, balanceAfter: 1217, title: '训练失败退款 · 赛博街景 LoRA', refId: 't_008', createdAt: daysAgo(7, 2) },
        { id: 'tx_006b', userId: ME, type: 'consume', amount: -120, balanceAfter: 1097, title: 'LoRA 训练 · 赛博街景', refId: 't_008', createdAt: daysAgo(7, 3) },
        { id: 'tx_006', userId: ME, type: 'consume', amount: -15, balanceAfter: 1217, title: '应用运行 · 短剧分镜工坊', refId: 't_004', createdAt: daysAgo(9, 2) },
        { id: 'tx_005', userId: ME, type: 'consume', amount: -18, balanceAfter: 1232, title: '工作流 · 文生图标准流', refId: 't_006', createdAt: daysAgo(11, 2) },
        { id: 'tx_004', userId: ME, type: 'consume', amount: -120, balanceAfter: 1250, title: 'LoRA 训练 · 灵犀人像', refId: 't_003', createdAt: daysAgo(20, 5) },
        { id: 'tx_003', userId: ME, type: 'consume', amount: -30, balanceAfter: 1370, title: '视频生成 · 星际信使预览', refId: 't_002', createdAt: daysAgo(26, 8) },
        { id: 'tx_002', userId: ME, type: 'recharge', amount: 1200, balanceAfter: 1400, title: '充值 1200 算力积分', refId: 'pkg_1200', createdAt: daysAgo(120, 3) },
        { id: 'tx_001', userId: ME, type: 'bonus', amount: 200, balanceAfter: 200, title: '新用户算力礼包', refId: '', createdAt: daysAgo(430) }
    ];

    const notifications = [
        { id: 'n_001', userId: ME, type: 'review', tone: 'ok', title: '作品审核通过', body: '「赛博少女·零」已通过审核并发布到作品广场。', link: 'assets/character-detail.html?id=m_001', read: false, createdAt: daysAgo(1, 4) },
        { id: 'n_002', userId: ME, type: 'review', tone: 'danger', title: '作品未通过审核', body: '「雨林遗迹」疑似包含真实文保地标，请调整提示词后重新提交。', link: 'assets/scenic-detail.html?id=m_007', read: false, createdAt: daysAgo(14) },
        { id: 'n_003', userId: ME, type: 'task', tone: 'ok', title: 'LoRA 训练完成', body: `「灵犀人像 LoRA」跑完 ${trainings[0].config.epochs} epoch / ${trainings[0].config.steps} 步，最终 loss ${trainings[0].loss[trainings[0].loss.length - 1].loss}，已生成模型资产。`, link: 'lora-train.html?training=tr_001', read: false, createdAt: daysAgo(20, 1) },
        { id: 'n_004', userId: ME, type: 'social', tone: 'brand', title: '沈知夏 赞了你的作品', body: '「赛博少女·零」收到 1 个新点赞。', link: 'assets/character-detail.html?id=m_001', read: true, createdAt: daysAgo(1, 5) },
        { id: 'n_005', userId: ME, type: 'social', tone: 'brand', title: '白露 关注了你', body: '你们都喜欢「亲子」「绘本」相关内容。', link: 'profile.html?uid=u_bailu', read: true, createdAt: daysAgo(30) },
        { id: 'n_006', userId: ME, type: 'billing', tone: 'warn', title: '算力积分到账', body: '专业版月度 3000 积分将于 12 天后重置，当前余额 1160。', link: 'wallet.html', read: true, createdAt: daysAgo(18) },
        { id: 'n_007', userId: ME, type: 'system', tone: 'brand', title: '平台公告：工作流 v2 上线', body: '新增节点级重试与产物对比，历史工作流自动升级。', link: 'ai-workflow-execute.html?workflow=wf_001', read: true, createdAt: daysAgo(9) }
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
