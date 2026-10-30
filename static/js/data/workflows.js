import { daysAgo, img } from './media.js';

/** 工作流模板：节点按顺序执行，前端据此渲染画布与执行动画 */
export const WORKFLOWS = [
    {
        id: 'wf_001',
        name: '文生图标准流',
        desc: '提示词 → 底模 → 采样 → 放大 → 保存，最常用的出图链路。',
        ownerId: 'u_me',
        template: true,
        version: 'v1.4',
        runs: 8620,
        updatedAt: daysAgo(3),
        nodes: [
            { id: 'n1', type: 'prompt', title: '提示词编码', params: { positive: '雨夜赛博城市，白发少女撑伞', negative: 'low quality, watermark, deformed hands' } },
            { id: 'n2', type: 'model', title: '加载底模', params: { model: '灵犀 XL Turbo', vae: 'automatic' } },
            { id: 'n3', type: 'lora', title: '叠加 LoRA', params: { lora: '灵犀人像 LoRA', strength: 0.7 } },
            { id: 'n4', type: 'sampler', title: 'K 采样器', params: { steps: 28, cfg: 6.5, sampler: 'DPM++ 2M Karras', seed: 882134 } },
            { id: 'n5', type: 'upscale', title: '潜空间放大', params: { scale: 1.5, denoise: 0.4 } },
            { id: 'n6', type: 'save', title: '保存图像', params: { format: 'PNG', prefix: 'linche' } }
        ]
    },
    {
        id: 'wf_002',
        name: '高清放大与修复',
        desc: '低分辨率素材放大 2 倍并补全细节，适合老素材复用。',
        ownerId: 'u_me',
        template: true,
        version: 'v1.1',
        runs: 2140,
        updatedAt: daysAgo(8),
        nodes: [
            { id: 'n1', type: 'load', title: '载入图像', params: { source: '上传素材' } },
            { id: 'n2', type: 'upscale', title: '分块放大', params: { scale: 2, tile: 1024, denoise: 0.35 } },
            { id: 'n3', type: 'sampler', title: '细节修复', params: { steps: 20, cfg: 5.5, sampler: 'UniPC' } },
            { id: 'n4', type: 'save', title: '保存图像', params: { format: 'PNG' } }
        ]
    },
    {
        id: 'wf_003',
        name: '短剧分镜出图',
        desc: '读取分镜脚本，逐镜生成关键帧，保持角色与场景一致。',
        ownerId: 'u_me',
        template: true,
        version: 'v2.0',
        runs: 640,
        updatedAt: daysAgo(1),
        nodes: [
            { id: 'n1', type: 'prompt', title: '剧情节點', params: { script: '信使在废弃空间站醒来' } },
            { id: 'n2', type: 'model', title: '加载底模', params: { model: 'FLUX.1 dev' } },
            { id: 'n3', type: 'lora', title: '角色一致性', params: { lora: '赛博少女·零', strength: 0.85 } },
            { id: 'n4', type: 'sampler', title: '逐镜采样', params: { steps: 32, cfg: 7, shots: 8 } },
            { id: 'n5', type: 'video', title: '图生视频', params: { model: 'Kling Video', duration: 5 } },
            { id: 'n6', type: 'save', title: '输出分镜包', params: { format: 'ZIP' } }
        ]
    },
    {
        id: 'wf_004',
        name: '角色三视图',
        desc: '固定角色设定，输出正 / 侧 / 背三视图并统一背景。',
        ownerId: 'u_zhixia',
        template: true,
        version: 'v1.6',
        runs: 3280,
        updatedAt: daysAgo(6),
        nodes: [
            { id: 'n1', type: 'prompt', title: '角色设定', params: { positive: '白发少女，全息夹克，机械右臂', negative: 'extra limbs, bad anatomy' } },
            { id: 'n2', type: 'model', title: '加载底模', params: { model: 'FLUX.1 dev' } },
            { id: 'n3', type: 'controlnet', title: '姿态控制', params: { pose: 'turnaround', strength: 0.9 } },
            { id: 'n4', type: 'sampler', title: '三视图采样', params: { steps: 30, cfg: 7, batch: 3 } },
            { id: 'n5', type: 'save', title: '保存三视图', params: { format: 'PNG' } }
        ]
    }
];

/** LoRA 训练数据集 */
export const DATASETS = [
    {
        id: 'ds_101',
        name: '官方·人像光影基础集',
        ownerId: 'platform',
        desc: '平台整理的 60 张光影样张，覆盖逆光/柔光/侧光，适合新手首次训练风格 LoRA。',
        count: 60,
        tagged: 60,
        resolution: '1024 × 1024',
        createdAt: daysAgo(120),
        thumbs: Array.from({ length: 8 }, (_, i) =>
            img(`portrait lighting study, backlight soft key ${i + 1}, 85mm`, 'square')
        ),
        tags: ['官方', '人像', '光影']
    },
    {
        id: 'ds_102',
        name: '官方·场景建筑参考集',
        ownerId: 'platform',
        desc: '54 张建筑与城市场景，含多时段光照，适用于场景类 LoRA 与工作流测试。',
        count: 54,
        tagged: 48,
        resolution: '1344 × 768',
        createdAt: daysAgo(96),
        thumbs: Array.from({ length: 8 }, (_, i) =>
            img(`architecture and city scene reference ${i + 1}, golden hour`, 'square')
        ),
        tags: ['官方', '场景', '建筑']
    },
    {
        id: 'ds_001',
        name: '人像精选集',
        ownerId: 'u_me',
        desc: '42 张精选人像，统一柔光与自然光比，已人工打标。',
        count: 42,
        tagged: 42,
        resolution: '1024 × 1024',
        createdAt: daysAgo(24),
        thumbs: Array.from({ length: 8 }, (_, i) =>
            img(`soft portrait photography, natural window light, subject ${i + 1}, 85mm`, 'square')
        ),
        tags: ['人像', '柔光', '自然光']
    },
    {
        id: 'ds_002',
        name: '赛博街景',
        ownerId: 'u_me',
        desc: '28 张雨夜霓虹街景，含不同招牌与视角，用于场景 LoRA。',
        count: 28,
        tagged: 21,
        resolution: '1344 × 768',
        createdAt: daysAgo(12),
        thumbs: Array.from({ length: 8 }, (_, i) =>
            img(`cyberpunk rainy neon street at night, angle ${i + 1}, cinematic`, 'square')
        ),
        tags: ['赛博朋克', '夜景', '场景']
    },
    {
        id: 'ds_003',
        name: '国风素材',
        ownerId: 'u_me',
        desc: '36 张国风建筑与服饰参考，尚未完成打标。',
        count: 36,
        tagged: 12,
        resolution: '1152 × 864',
        createdAt: daysAgo(5),
        thumbs: Array.from({ length: 8 }, (_, i) =>
            img(`traditional chinese architecture detail ${i + 1}, ink painting mood`, 'square')
        ),
        tags: ['国风', '建筑', '服饰']
    }
];
