/**
 * LoRA 训练领域逻辑
 * ------------------------------------------------------------------
 * 参数选项、预设、归一化与派生估算（步数 / 算力 / 时长 / 显存 / 吞吐）集中在此，
 * 供 api.js（下单校验与扣费）、engine.js（训练过程推进）、lora.js（表单与实时预估）共用，
 * 保证三端口径完全一致——避免出现「页面显示 3600 步、引擎按 2400 步跑」这类假系统常见破绽。
 */

/** 底模档案：步速（samples/s）、单份参数量（M）、显存基数（GB）、成本系数 */
export const BASE_PROFILES = {
    'SDXL 1.0': { stepRate: 0.92, paramsPerSample: 41, vramBase: 5.2, cost: 1 },
    'SD 1.5': { stepRate: 1.9, paramsPerSample: 17, vramBase: 3.6, cost: 0.7 },
    'FLUX.1 dev': { stepRate: 0.42, paramsPerSample: 52, vramBase: 8.5, cost: 1.6 },
    'SDXL Turbo': { stepRate: 1.6, paramsPerSample: 41, vramBase: 6, cost: 0.85 }
};

export const OPTIMIZERS = [
    { id: 'AdamW8bit', note: '显存友好，默认选择' },
    { id: 'AdamW', note: '更稳，显存约 +30%' },
    { id: 'Lion', note: '收敛快，对学习率敏感' },
    { id: 'Prodigy', note: '自动学习率，免去调参' }
];

export const SCHEDULERS = [
    { id: 'cosine', note: '余弦退火，常用' },
    { id: 'cosine_with_restarts', note: '周期重启，有助跳出局部最优' },
    { id: 'linear', note: '线性衰减，曲线更平滑' },
    { id: 'constant', note: '恒定学习率，适合调试' }
];

export const RANKS = [4, 8, 16, 32, 48, 64, 96, 128];
export const LRS = [0.00003, 0.00005, 0.00008, 0.0001, 0.00015, 0.0002, 0.0003, 0.0005];
export const BATCHES = [1, 2, 4, 8];
export const RESOLUTIONS = ['512', '768', '1024', '1216'];
export const GRAD_ACCUMS = [1, 2, 4, 8];
export const CLIP_SKIPS = [1, 2];

/** 训练模式预设：以「推荐总步数」驱动轮数推算，而非直接填步数（更接近真实训练台） */
export const MODE_PRESETS = {
    quick: { name: '快速', rank: 16, alphaRatio: 0.5, lr: 0.0002, batch: 4, gradAccum: 1, resolution: '768', noiseOffset: false, optimizer: 'AdamW8bit', scheduler: 'cosine', targetEpochSteps: 1200, hint: '先验证数据集与触发词是否可行，便宜但特征偏弱' },
    standard: { name: '标准', rank: 32, alphaRatio: 0.5, lr: 0.0001, batch: 2, gradAccum: 2, resolution: '1024', noiseOffset: true, optimizer: 'AdamW8bit', scheduler: 'cosine', targetEpochSteps: 2400, hint: '多数风格 / 角色模型的推荐配置' },
    fine: { name: '精细', rank: 64, alphaRatio: 0.5, lr: 0.00008, batch: 1, gradAccum: 4, resolution: '1024', noiseOffset: true, optimizer: 'AdamW', scheduler: 'cosine_with_restarts', targetEpochSteps: 4500, hint: '人物一致性要求高、样本质量整齐时使用' }
};

/** 数据集样本数 → 每轮重复次数（小数据集需要更多 repeat 才能喂饱一个 epoch） */
export const repeatsFor = (count) => (count <= 15 ? 10 : count <= 30 ? 8 : count <= 60 ? 6 : 4);

/** 按底模与分辨率给出显存安全上限（近似真实训练的 OOM 边界） */
export const vramLimit = (resolution) => (Number(resolution) >= 1024 ? 20 : 24);

export const lrLabel = (v) => {
    const n = Number(v) || 0;
    if (n >= 0.001) return n.toFixed(4);
    if (n >= 0.0001) return n.toFixed(5).replace(/0$/, '');
    return n.toFixed(6).replace(/0$/, '');
};

/**
 * 前端表单收集 → 领域 config（传入 dataset 才能按推荐步数反推轮数）
 * alphaAuto = true 时 alpha 取 rank × alphaRatio（业界常用的 lr 比例）。
 */
export function pickConfig(input = {}, dataset = {}) {
    const preset = MODE_PRESETS[input.mode] || MODE_PRESETS.standard;
    const raw = {
        base: input.base || 'SDXL 1.0',
        mode: input.mode || 'standard',
        rank: Number(input.rank) || preset.rank,
        alpha: input.alphaAuto === false ? Number(input.alpha) : Math.max(1, Math.round((Number(input.rank) || preset.rank) * (preset.alphaRatio || 0.5))),
        lr: Number(input.lr) || preset.lr,
        batch: Number(input.batch) || preset.batch,
        gradAccum: Number(input.gradAccum) || preset.gradAccum,
        resolution: input.resolution || preset.resolution,
        optimizer: input.optimizer || preset.optimizer,
        scheduler: input.scheduler || preset.scheduler,
        epochs: Number(input.epochs) || suggestEpochs({ mode: input.mode, batch: Number(input.batch) || preset.batch, gradAccum: Number(input.gradAccum) || preset.gradAccum }, dataset),
        dropout: Number.isFinite(Number(input.dropout)) ? Number(input.dropout) : 0.1,
        precision: input.precision || 'bf16',
        seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : -1,
        clipSkip: Number(input.clipSkip) || 2,
        noiseOffset: input.noiseOffset === undefined ? !!preset.noiseOffset : !!input.noiseOffset,
        savePerEpoch: Number(input.savePerEpoch) || 3,
        trainTextEncoder: !!input.trainTextEncoder
    };
    return normalizeConfig(raw, dataset);
}

/**
 * 归一化 + 派生：
 * steps = ceil(样本数 × repeat × epochs / (batch × gradAccum))，
 * 用户在表单里看到的步数就是引擎实际会跑的步数（单一事实来源）。
 */
export function normalizeConfig(raw = {}, dataset = { count: 42 }) {
    const cfg = { ...raw };
    if (cfg.alpha == null || Number(cfg.alpha) <= 0) cfg.alpha = Math.max(1, Math.round(Number(cfg.rank || 32) / 2));
    if (!Number.isFinite(cfg.dropout)) cfg.dropout = 0.1;
    if (!Number.isFinite(cfg.lr)) cfg.lr = 0.0001;
    if (!Number.isFinite(cfg.batch)) cfg.batch = 2;
    if (!Number.isFinite(cfg.gradAccum)) cfg.gradAccum = 1;
    if (!Number.isFinite(cfg.clipSkip)) cfg.clipSkip = 2;
    cfg.alpha = Math.min(128, Math.max(1, Math.round(Number(cfg.alpha))));
    cfg.dropout = Math.min(0.5, Math.max(0, Number(cfg.dropout)));
    cfg.batch = Math.max(1, Math.min(8, Math.round(Number(cfg.batch))));
    cfg.gradAccum = Math.max(1, Math.min(8, Math.round(Number(cfg.gradAccum))));

    const count = Math.max(1, Number(dataset.count) || 1);
    cfg.datasetCount = count;
    cfg.repeat = repeatsFor(count);
    cfg.epochs = Math.max(1, Math.min(120, Math.round(Number(cfg.epochs) || 12)));
    cfg.perEpochRows = count * cfg.repeat;
    cfg.stepsPerEpoch = Math.max(1, Math.ceil(cfg.perEpochRows / (cfg.batch * cfg.gradAccum)));
    cfg.steps = Math.max(100, cfg.stepsPerEpoch * cfg.epochs);
    cfg.savePerEpoch = Math.max(1, Math.min(cfg.epochs, Math.round(Number(cfg.savePerEpoch) || 3)));

    cfg.vramGb = estimateVramGb(cfg);
    cfg.vramLimitGb = vramLimit(cfg.resolution);
    cfg.warmupSteps = Math.max(10, Math.round(cfg.steps * 0.05));
    cfg.lossPoints = Math.max(12, Math.min(40, Math.round(cfg.steps / 90)));
    cfg.estimateCost = estimateCost(cfg);
    cfg.estimateMin = estimateDurationMin(cfg);
    cfg.samplesPerSec = samplesPerSec(cfg);
    cfg.weightMb = weightMb(cfg);
    return cfg;
}

/** 按预设推荐步数反推 epochs（表单在切换预设 / 数据集 / 批次时自动同步，用户仍可手改） */
export function suggestEpochs(raw = {}, dataset = {}) {
    const target = (MODE_PRESETS[raw.mode] || MODE_PRESETS.standard).targetEpochSteps;
    const count = Math.max(1, Number(dataset.count) || 1);
    const perEpochRows = count * repeatsFor(count);
    const batch = Math.max(1, Math.round(Number(raw.batch) || 2));
    const gradAccum = Math.max(1, Math.round(Number(raw.gradAccum) || 1));
    const perEpochSteps = Math.max(1, Math.ceil(perEpochRows / (batch * gradAccum)));
    return Math.max(1, Math.min(120, Math.round(target / perEpochSteps)));
}

/** 当前学习率（含 warmup 与调度器曲线），用于实时指标与日志 */
export function lrAt(cfg, p) {
    const peak = Number(cfg.lr) || 0.0001;
    const total = Math.max(1, cfg.steps || 1);
    const step = Math.max(0, Math.min(1, p)) * total;
    if (step < (cfg.warmupSteps || Math.round(total * 0.05))) {
        return Number((peak * 0.1 * (step / Math.max(1, cfg.warmupSteps || 1))).toFixed(8));
    }
    const t = (step - (cfg.warmupSteps || 0)) / Math.max(1, total - (cfg.warmupSteps || 0));
    const floor = peak * 0.1;
    if (cfg.scheduler === 'constant') return peak;
    if (cfg.scheduler === 'linear') return Number((peak - (peak - floor) * t).toFixed(8));
    if (cfg.scheduler === 'cosine_with_restarts') {
        const cycles = 3;
        const phase = (t % (1 / cycles)) * cycles;
        return Number((floor + (peak - floor) * Math.pow(0.5 + 0.5 * Math.cos(Math.PI * phase), 1.2)).toFixed(8));
    }
    return Number((floor + (peak - floor) * (0.5 + 0.5 * Math.cos(Math.PI * t))).toFixed(8));
}

export function samplesPerSec(cfg) {
    const profile = BASE_PROFILES[cfg.base] || BASE_PROFILES['SDXL 1.0'];
    const lrPenalty = 1 + (Number(cfg.lr) || 0.0001) * 220;
    const enc = cfg.trainTextEncoder ? 0.82 : 1;
    const precision = cfg.precision === 'fp16' ? 1.05 : cfg.precision === 'fp32' ? 0.55 : 1;
    const res = Number(cfg.resolution) >= 1024 ? 1 : Number(cfg.resolution) >= 768 ? 1.35 : 1.9;
    return Number((profile.stepRate * lrPenalty * enc * precision * res).toFixed(2));
}

export function estimateDurationMin(cfg) {
    return Math.max(4, Math.round(cfg.steps / Math.max(0.05, samplesPerSec(cfg)) / 60));
}

export function estimateCost(cfg) {
    const profile = BASE_PROFILES[cfg.base] || BASE_PROFILES['SDXL 1.0'];
    const rankFactor = 0.55 + Number(cfg.rank || 32) / 90;
    const stepFactor = Math.log2(Number(cfg.steps || 1500) / 1100 + 1);
    const batchFactor = 1 + (Number(cfg.batch || 1) - 1) * 0.05;
    const resFactor = Number(cfg.resolution) >= 1024 ? 1 : Number(cfg.resolution) >= 768 ? 0.8 : 0.62;
    const enc = cfg.trainTextEncoder ? 1.15 : 1;
    const value = 95 * profile.cost * rankFactor * stepFactor * batchFactor * resFactor * enc;
    return Math.max(30, Math.round(value / 5) * 5);
}

/** 显存估算：基数 + 权重 + 激活值（与 batch、分辨率、是否训文本编码器相关） */
export function estimateVramGb(cfg) {
    const profile = BASE_PROFILES[cfg.base] || BASE_PROFILES['SDXL 1.0'];
    const weightsGb = (Number(cfg.rank || 32) * profile.paramsPerSample) / 1024;
    const resScale = (Number(cfg.resolution) || 1024) / 1024;
    const activation = Number(cfg.batch || 1) * (cfg.precision === 'fp32' ? 10 : 5) * resScale * resScale;
    const textEnc = cfg.trainTextEncoder ? 2.6 : 0;
    const optimizer = cfg.optimizer === 'AdamW' ? 2.4 : 0;
    return Number((profile.vramBase + weightsGb + activation + textEnc + optimizer).toFixed(1));
}

/** LoRA 权重大小（近似：可训练参数 ≈ rank × 每样本参数 × 2 个低秩矩阵） */
export function weightMb(cfg) {
    const profile = BASE_PROFILES[cfg.base] || BASE_PROFILES['SDXL 1.0'];
    return Math.max(2, Math.round((Number(cfg.rank || 32) * profile.paramsPerSample * 2) / 128));
}

/**
 * 训练 loss：确定性（同一 step 反复查询结果一致，曲线不抖动）
 * 学习率越高噪声越大；线性/恒定调度不衰减到谷底，余弦重启会有周期性回升。
 */
export function lossAt(cfg, stepIndex, total) {
    const start = 0.24 + (Number(cfg.lr) || 0.0001) * 60;
    const p = Math.max(0.0001, Math.min(1, stepIndex / Math.max(1, total - 1)));
    const floor = 0.046 + (Number(cfg.rank) || 32) * 0.00012;
    const jitter = jitterAt(stepIndex) * (0.012 + (Number(cfg.lr) || 0.0001) * 70);
    if (cfg.scheduler === 'constant') return Number((start - (start - floor) * p * 0.75 + jitter).toFixed(4));
    if (cfg.scheduler === 'linear') return Number((start - (start - floor) * p + jitter).toFixed(4));
    if (cfg.scheduler === 'cosine_with_restarts') {
        const cycles = 3;
        const phase = (p % (1 / cycles)) * cycles;
        return Number((floor + (start - floor) * Math.pow(Math.sin(Math.PI * phase / 2), 0.7) + jitter).toFixed(4));
    }
    return Number((floor + (start - floor) * (0.5 + 0.5 * Math.cos(Math.PI * p)) + jitter).toFixed(4));
}

function jitterAt(i) {
    const x = Math.sin(i * 12.9898) * 43758.5453;
    return x - Math.floor(x) - 0.5;
}

/**
 * 训练阶段计划（按进度百分比排序）：
 * 前端用它渲染「流程清单」，引擎用它逐条推进日志、写 checkpoint 与样张，
 * 两端共用同一份计划，因此页面看到的过程与日志永远一致。
 */
export function buildTrainPlan(cfg, dataset = {}, trigger = 'lora') {
    const count = Math.max(1, Number(dataset.count) || Number(cfg.datasetCount) || 1);
    const tagged = Number.isFinite(Number(dataset.tagged)) ? Number(dataset.tagged) : count;
    const dup = Math.max(0, Math.round(count * 0.04));
    const blur = Math.max(0, Math.round(count * 0.02));
    const stepsPerEpoch = Math.max(1, cfg.stepsPerEpoch || Math.ceil((count * (cfg.repeat || 1)) / (cfg.batch || 1) / (cfg.gradAccum || 1)));
    const epochs = Math.max(1, cfg.epochs || 1);
    const points = cfg.lossPoints || 24;
    const plan = [];
    const push = (item) => plan.push(item);

    push({ at: 2, stage: 'data', label: '数据集校验', msg: `${count} 张样本 / 已打标 ${tagged}，目标分辨率 ${cfg.resolution}×${cfg.resolution}` });
    push({ at: 5, stage: 'data', label: '质量过滤', msg: `剔除 ${dup} 张近似重复、${blur} 张模糊样本，实际参与训练 ${count - dup - blur} 张`, level: dup + blur ? 'warn' : 'info' });
    push({ at: 9, stage: 'data', label: 'Caption 整理', msg: `以触发词「${trigger}」替换主体描述，生成 ${count} 条 txt 标注` });
    push({ at: 14, stage: 'cache', label: 'Latent 缓存', msg: `逐张 VAE 编码：${count} × repeat ${cfg.repeat || 1} = ${cfg.perEpochRows || count * (cfg.repeat || 1)} 条写入缓存` });
    push({ at: 19, stage: 'model', label: '模型装配', msg: `${cfg.base} 注入 LoRA：rank ${cfg.rank} / alpha ${cfg.alpha} / dropout ${cfg.dropout}${cfg.trainTextEncoder ? '，同时训练文本编码器' : '（仅 UNet）'} · ${cfg.precision}` });
    push({ at: 24, stage: 'train', label: '优化器就绪', msg: `${cfg.optimizer} · ${cfg.scheduler} · 峰值 lr ${lrLabel(cfg.lr)} · warmup ${cfg.warmupSteps || 0} 步 · batch ${cfg.batch}×${cfg.gradAccum || 1}` });

    const startAt = 28;
    const endAt = 85;
    const totalSteps = Math.max(1, Number(cfg.steps) || stepsPerEpoch * epochs);
    const save = Math.max(1, Number(cfg.savePerEpoch) || 3);
    // epoch 日志按里程碑抽样（最多约 30 条）：保留逐轮观感，又不让长训练把日志与存储撑爆
    const stride = Math.max(1, Math.ceil(epochs / 30));
    for (let e = 1; e <= epochs; e += 1) {
        const p = e / epochs;
        const at = Math.round(startAt + (endAt - startAt) * p);
        const step = Math.min(totalSteps, Math.round(totalSteps * p));
        const loss = lossAt(cfg, Math.round(p * (points - 1)), points);
        if (e === 1 || e % stride === 0 || e === epochs) {
            push({
                at,
                stage: 'train',
                kind: 'epoch',
                label: `Epoch ${e}/${epochs}`,
                epoch: e,
                step,
                loss,
                lr: lrAt(cfg, p),
                msg: `Epoch ${e}/${epochs} 完成 · step ${step} · avg loss ${loss} · lr ${lrAt(cfg, p).toExponential(1)}`
            });
        }
        // checkpoint 以实际累计步数命名，必然落在 0..totalSteps 内
        if (e % save === 0 || e === epochs) {
            const name = `checkpoint-${step}`;
            push({ at: Math.min(86, at + 1), stage: 'train', kind: 'ckpt', label: name, name, step, epoch: e, msg: `保存 ${name}.safetensors（${cfg.weightMb || 16} MB · epoch ${e}/${epochs} · avg loss ${loss}）` });
        }
        if (e === Math.max(1, Math.round(epochs * 0.35)) || e === Math.max(1, Math.round(epochs * 0.7))) {
            push({ at: Math.min(87, at + 2), stage: 'train', kind: 'sample', label: '验证样张', step, msg: `生成验证样张 @ step ${step}，用于人工检查过拟合与特征强度` });
        }
    }

    push({ at: 90, stage: 'export', kind: 'finalSample', label: '终版样张', msg: `使用 ${cfg.base} + 本次 LoRA（权重 1.0）生成终版对比样张` });
    push({ at: 94, stage: 'export', label: '收敛检测', msg: `末段 loss 变化 < 0.003，未检出过拟合，判定收敛通过` });
    push({ at: 97, stage: 'export', label: '导出权重', msg: `导出 LoRA 权重与元数据（触发词 / 底模 / rank / alpha / 训练步数）` });
    return plan.sort((a, b) => a.at - b.at);
}

/** 阶段展示顺序（流程清单固定五条主线，epoch 明细归入「迭代训练」） */
export const PLAN_STAGES = [
    { id: 'data', name: '数据准备' },
    { id: 'cache', name: 'Latent 缓存' },
    { id: 'model', name: '模型装配' },
    { id: 'train', name: '迭代训练' },
    { id: 'export', name: '导出权重' }
];

/** 过程样张提示词（真实系统会在里程碑步生成验证样张） */
export function samplePrompt(cfg, training, stage = 'epoch') {
    const trigger = training?.trigger || 'lora';
    const subject = cfg.mode === 'fine' ? 'character portrait, detailed face and fabric texture' : 'style reference scene, balanced composition';
    return `${trigger}, ${subject}, ${cfg.base}, ${stage} sample`;
}

/**
 * 可预判的训练故障（确定性，不随机）：
 * 真实平台上这两类配置几乎必然翻车，提前拦截并给出可执行的修正建议，
 * 比「随机失败再退款」更像可信的训练系统。
 */
export function predictFault(cfg) {
    if (cfg.precision === 'fp16' && cfg.trainTextEncoder) {
        return { at: 58, reason: 'NaN loss detected：fp16 下训练文本编码器发生数值溢出，请改用 bf16 或关闭文本编码器训练' };
    }
    if (Number(cfg.lr) >= 0.0003 && cfg.optimizer === 'Lion') {
        return { at: 41, reason: 'Loss 发散：Lion 优化器在 3e-4 学习率下不稳定，请降至 1e-4 以下或改用 AdamW8bit' };
    }
    return null;
}

/** 不阻断提交、但应在界面提示的配置风险 */
export function configWarnings(cfg, dataset) {
    const list = [];
    const count = Number(cfg.datasetCount) || Number(dataset?.count) || 0;
    if (Number(cfg.rank) >= 64 && count < 25) list.push(`Rank ${cfg.rank} 对 ${count} 张样本偏大，容易过拟合（建议 Rank ≤ 32 或补充样本）`);
    if (cfg.epochs > 24) list.push(`训练轮数 ${cfg.epochs} 偏高，请留意后期 loss 不再下降而样张开始失真`);
    if (Number(cfg.dropout) >= 0.3) list.push(`Dropout ${cfg.dropout} 偏大，特征收敛会明显变慢`);
    if (!cfg.noiseOffset && cfg.base === 'SDXL 1.0') list.push('SDXL 建议开启 noise offset，可改善暗部细节与对比度');
    if (Number(cfg.seed) < 0) list.push('随机种子为 -1（随机），需要复现相同效果时请固定种子');
    if (Number(cfg.alpha) > Number(cfg.rank)) list.push('Alpha 大于 Rank 会放大特征强度，容易烧过头（常用 alpha = rank / 2）');
    return list;
}

/** 失败后的修改重试建议：按错误关键词给出可直接下发的 overrides */
export function retrySuggestions(cfg = {}, error = '') {
    const text = String(error || '');
    const opts = [{ title: '原参数重试', desc: '适用于节点抖动、排队超时等临时性故障', overrides: {} }];
    if (/memory|显存|OOM/i.test(text)) {
        opts.push({
            title: '降低显存占用',
            desc: `batch ${cfg.batch} → 1，梯度累积 → ${Math.min(8, Math.max(1, (cfg.batch || 1) * (cfg.gradAccum || 1)))}，等效批大小与收敛效果不变`,
            overrides: { batch: 1, gradAccum: Math.min(8, Math.max(1, (cfg.batch || 1) * (cfg.gradAccum || 1))) }
        });
        opts.push({ title: '降低分辨率', desc: `${cfg.resolution} → 512，适合先跑通流程再拉高画质`, overrides: { resolution: '512' } });
    }
    if (/NaN|数值|fp16/i.test(text)) {
        opts.push({ title: '改用 bf16', desc: '避免半精度数值溢出，并关闭文本编码器训练', overrides: { precision: 'bf16', trainTextEncoder: false } });
    }
    if (/发散|Lion|diverge/i.test(text)) {
        opts.push({ title: '保守优化器组合', desc: '学习率降至 1e-4 并改用 AdamW8bit', overrides: { lr: 0.0001, optimizer: 'AdamW8bit' } });
    }
    if (/过拟合|epoch/i.test(text)) {
        opts.push({ title: '降低拟合能力', desc: 'Rank 减半、轮数减半，缓解过拟合与特征发烧', overrides: { rank: Math.max(4, Math.round((cfg.rank || 32) / 2)), epochs: Math.max(1, Math.round((cfg.epochs || 12) / 2)) } });
    }
    // 没有命中关键词时也给一条可执行的保守方案，避免只剩「原参数重试」
    if (opts.length === 1) {
        opts.push({
            title: '降一档保守配置',
            desc: `Rank ${cfg.rank || 32} → ${Math.max(8, Math.round((cfg.rank || 32) / 2))}，学习率不高于 1e-4，其余参数不变`,
            overrides: { rank: Math.max(8, Math.round((cfg.rank || 32) / 2)), lr: Math.min(Number(cfg.lr) || 0.0001, 0.0001) }
        });
    }
    return opts;
}

/** 导出与主流训练脚本同构的配置文本（可复制到自己环境跑） */
export function trainToml(training) {
    const c = training.config || {};
    return [
        '[dataset]',
        `train_data_dir   = "datasets/${training.datasetId || 'custom'}"`,
        `resolution       = ${c.resolution}`,
        `num_repeats      = ${c.repeat || 1}`,
        `cache_latents    = yes`,
        `caption_prefix   = "${training.trigger}"`,
        '',
        '[network]',
        `type             = "lora"`,
        `network_dim      = ${c.rank}`,
        `network_alpha    = ${c.alpha}`,
        `dropout_rate     = ${c.dropout}`,
        '',
        '[training]',
        `pretrained_model = "${c.base}"`,
        `max_train_epochs = ${c.epochs}`,
        `max_train_steps  = ${c.steps}`,
        `train_batch_size = ${c.batch}`,
        `grad_accumulation = ${c.gradAccum}`,
        `learning_rate    = ${c.lr}`,
        `lr_scheduler     = "${c.scheduler}"`,
        `optimizer_type   = "${c.optimizer}"`,
        `mixed_precision  = "${c.precision}"`,
        `noise_offset     = ${c.noiseOffset ? 0.05 : 0}`,
        `clip_skip        = ${c.clipSkip}`,
        `seed             = ${c.seed}`,
        `save_every_n_epochs = ${c.savePerEpoch}`,
        `train_text_encoder = ${c.trainTextEncoder ? 'yes' : 'no'}`,
        '',
        '[output]',
        `name             = "${training.name}"`,
        `weight_mb        = ${c.weightMb}`,
        `recommended_strength = ${Number(c.rank) >= 64 ? 0.7 : 0.8}`
    ].join('\n');
}
