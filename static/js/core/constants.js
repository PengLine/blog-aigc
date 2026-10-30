/**
 * 业务字典：资产类型、状态、模型、套餐、任务成本
 */

export const KINDS = {
    character: {
        id: 'character',
        name: '角色',
        plural: '角色',
        icon: 'user',
        tone: 'brand',
        desc: '可复用的角色形象、三视图与设定',
        detail: 'assets/character-detail.html',
        create: 'assets/create-character.html',
        mine: 'assets/my-assets-character.html'
    },
    prop: {
        id: 'prop',
        name: '道具',
        plural: '道具',
        icon: 'box',
        tone: 'violet',
        desc: '武器、饰品、载具等可复用物件',
        detail: 'assets/prop-detail.html',
        create: 'assets/create-prop.html',
        mine: 'assets/my-assets-prop.html'
    },
    scenic: {
        id: 'scenic',
        name: '景点',
        plural: '景点',
        icon: 'map',
        tone: 'cyan',
        desc: '场景、环境与可复用背景',
        detail: 'assets/scenic-detail.html',
        create: 'assets/create-scenic.html',
        mine: 'assets/my-assets-scenic.html'
    },
    video: {
        id: 'video',
        name: '短剧',
        plural: '短剧',
        icon: 'video',
        tone: 'rose',
        desc: '由角色、道具、景点组合而成的成片',
        detail: 'assets/video-detail.html',
        create: 'assets/create-video.html',
        mine: 'assets/my-assets-video.html'
    },
    model: {
        id: 'model',
        name: '模型',
        plural: '模型',
        icon: 'cpu',
        tone: 'amber',
        desc: 'LoRA / 风格模型与训练产物',
        detail: 'assets/model-detail.html',
        create: 'assets/create-model.html',
        mine: 'assets/my-assets-model.html'
    },
    app: {
        id: 'app',
        name: '应用',
        plural: '应用',
        icon: 'sparkles',
        tone: 'violet',
        desc: '封装好的可交付 AI 应用',
        detail: 'app/ai-app-detail.html',
        create: 'app/ai-app-create.html',
        mine: 'assets/my-assets-app.html'
    }
};

export const KIND_LIST = Object.values(KINDS);

export const SUBTYPES = [
    { id: 'parent-child', name: '亲子' },
    { id: 'couple', name: '情侣' },
    { id: 'campus', name: '校园' },
    { id: 'dance', name: '舞蹈' },
    { id: 'travel', name: '旅行' },
    { id: 'food', name: '美食' },
    { id: 'anime', name: '二次元' },
    { id: 'sport', name: '运动' },
    { id: 'technology', name: '技术' },
    { id: 'esport', name: '电竞' },
    { id: 'art', name: '艺术' },
    { id: 'story', name: '故事' },
    { id: 'music', name: '音乐' },
    { id: 'game', name: '游戏' },
    { id: 'other', name: '其他' }
];

export const SUBTYPE_MAP = Object.fromEntries(SUBTYPES.map((s) => [s.id, s.name]));

export const STATUS = {
    draft: { label: '草稿', tone: '' },
    pending: { label: '审核中', tone: 'warn' },
    published: { label: '已发布', tone: 'ok' },
    rejected: { label: '未通过', tone: 'danger' },
    private: { label: '仅自己', tone: '' },
    queued: { label: '排队中', tone: 'warn' },
    running: { label: '运行中', tone: 'brand' },
    succeeded: { label: '已完成', tone: 'ok' },
    failed: { label: '已失败', tone: 'danger' },
    canceled: { label: '已取消', tone: '' }
};

export const MODELS = [
    { id: 'lingxi-xl', name: '灵犀 XL Turbo', kind: 'image', cost: 5, desc: '速度快，适合草稿与批量出图' },
    { id: 'flux-dev', name: 'FLUX.1 dev', kind: 'image', cost: 8, desc: '语义理解强，适合复杂提示词' },
    { id: 'sdxl', name: 'SDXL 1.0', kind: 'image', cost: 6, desc: '生态完善，LoRA 兼容性最好' },
    { id: 'sd15', name: 'SD 1.5', kind: 'image', cost: 3, desc: '轻量经济，适合风格化实验' },
    { id: 'kling-v', name: 'Kling Video', kind: 'video', cost: 30, desc: '图生视频，5 秒 / 720p' },
    { id: 'lingxi-v', name: '灵犀 Video', kind: 'video', cost: 26, desc: '文生视频，支持运镜控制' }
];

export const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.id, m]));

export const SAMPLERS = ['DPM++ 2M Karras', 'Euler a', 'DDIM', 'UniPC', 'DPM++ SDE'];

export const RATIOS = [
    { id: '1:1', label: '1:1', w: 1024, h: 1024 },
    { id: '4:3', label: '4:3', w: 1152, h: 864 },
    { id: '3:2', label: '3:2', w: 1216, h: 832 },
    { id: '16:9', label: '16:9', w: 1344, h: 768 },
    { id: '9:16', label: '9:16', w: 768, h: 1344 }
];

export const TASK_TYPES = {
    image: { name: '图片生成', icon: 'image', cost: 6 },
    video: { name: '视频生成', icon: 'video', cost: 30 },
    train: { name: 'LoRA 训练', icon: 'cpu', cost: 120 },
    workflow: { name: '工作流', icon: 'workflow', cost: 18 },
    app: { name: '应用运行', icon: 'sparkles', cost: 8 },
    review: { name: '内容审核', icon: 'shield', cost: 0 },
    upload: { name: '素材处理', icon: 'upload', cost: 0 }
};

export const PLANS = [
    {
        id: 'free',
        name: '体验版',
        price: 0,
        credits: 200,
        features: ['每月 200 算力积分', '标准队列优先级', '最多 20 个资产', '社区支持'],
        limits: { assets: 20, concurrency: 1 }
    },
    {
        id: 'pro',
        name: '专业版',
        price: 99,
        credits: 3000,
        features: ['每月 3000 算力积分', '高优先级队列', '无限资产', 'LoRA 训练 8 折', '商用授权'],
        limits: { assets: Infinity, concurrency: 3 }
    },
    {
        id: 'studio',
        name: '工作室版',
        price: 399,
        credits: 15000,
        features: ['每月 15000 算力积分', '专属算力通道', '无限资产与协作者', '私有模型托管', '专属技术支持'],
        limits: { assets: Infinity, concurrency: 8 }
    }
];

export const PLAN_MAP = Object.fromEntries(PLANS.map((p) => [p.id, p]));

export const RECHARGE_PACKAGES = [
    { credits: 500, price: 19, bonus: 0 },
    { credits: 1200, price: 39, bonus: 120, best: true },
    { credits: 3000, price: 89, bonus: 400 },
    { credits: 8000, price: 219, bonus: 1200 },
    { credits: 20000, price: 499, bonus: 4000 }
];

export const APP_CATEGORIES = [
    { id: 'all', name: '全部' },
    { id: 'image', name: '图像生成' },
    { id: 'video', name: '视频创作' },
    { id: 'writing', name: '文案脚本' },
    { id: 'design', name: '设计资产' },
    { id: 'audio', name: '音频配音' },
    { id: 'tool', name: '效率工具' }
];

export function taskCost(type, payload = {}) {
    if (type === 'app') return Number(payload.price || 8);
    if (type === 'image') {
        const model = MODEL_MAP[payload.model];
        return model ? model.cost : TASK_TYPES.image.cost;
    }
    if (type === 'video') return Number(payload.duration || 5) > 5 ? 45 : TASK_TYPES.video.cost;
    if (type === 'train') return TASK_TYPES.train.cost;
    if (type === 'workflow') return TASK_TYPES.workflow.cost;
    return 0;
}

export function kindMeta(kind) {
    return KINDS[kind] || KINDS.character;
}

export function statusMeta(status) {
    return STATUS[status] || { label: status || '未知', tone: '' };
}
