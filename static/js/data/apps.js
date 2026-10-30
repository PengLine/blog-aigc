import { daysAgo } from './media.js';

/**
 * AI 应用：由模型 / 工作流封装的可交付能力
 * inputs 为运行表单的 schema，工作台据此动态渲染参数面板。
 */
export const APPS = [
    {
        id: 'app_001',
        name: '幻境绘图',
        icon: '幻',
        iconTone: '',
        category: 'image',
        authorId: 'u_me',
        price: 6,
        runs: 128400,
        rating: 4.8,
        ratingCount: 3260,
        version: 'v2.3',
        updatedAt: daysAgo(3),
        status: 'published',
        desc: '一句话生成电影级画面，内置 12 种风格预设与负面词模板。',
        tags: ['文生图', '风格预设', '电影感'],
        model: 'lingxi-xl',
        workflowId: 'wf_001',
        inputs: [
            { key: 'prompt', label: '画面描述', type: 'textarea', required: true, default: '雨夜的赛博城市街头，霓虹灯反射在积水上，一位撑伞的白发少女', placeholder: '描述你想看到的画面，建议包含主体、环境、光线、风格', help: '支持中文，越具体效果越好' },
            { key: 'style', label: '风格预设', type: 'select', default: 'cinematic', options: [
                { value: 'cinematic', label: '电影感' },
                { value: 'anime', label: '日系动画' },
                { value: 'ink', label: '国风水墨' },
                { value: 'film', label: '复古胶片' },
                { value: '3d', label: '3D 渲染' }
            ] },
            { key: 'ratio', label: '画幅比例', type: 'select', default: '16:9', options: [
                { value: '1:1', label: '1:1 方图' },
                { value: '4:3', label: '4:3 横图' },
                { value: '16:9', label: '16:9 宽屏' },
                { value: '9:16', label: '9:16 竖屏' }
            ] },
            { key: 'steps', label: '精细度', type: 'range', default: 28, min: 8, max: 50, step: 1, help: '步数越高细节越丰富，耗时也更长' }
        ]
    },
    {
        id: 'app_002',
        name: '角色三视图生成器',
        icon: '角',
        iconTone: 'violet',
        category: 'design',
        authorId: 'u_zhixia',
        price: 12,
        runs: 42800,
        rating: 4.9,
        ratingCount: 1820,
        version: 'v1.8',
        updatedAt: daysAgo(6),
        status: 'published',
        desc: '输入角色设定，输出正面 / 侧面 / 背面三视图，保持形象一致性。',
        tags: ['角色设计', '三视图', '一致性'],
        model: 'flux-dev',
        workflowId: 'wf_004',
        inputs: [
            { key: 'prompt', label: '角色描述', type: 'textarea', required: true, default: '白发少女，全息夹克，机械右臂，赛博朋克风格', placeholder: '描述角色的外形、服装、标志性特征' },
            { key: 'gender', label: '性别', type: 'select', default: 'female', options: [
                { value: 'female', label: '女性' },
                { value: 'male', label: '男性' },
                { value: 'neutral', label: '中性' }
            ] },
            { key: 'background', label: '去掉背景', type: 'switch', default: true, help: '输出纯白背景，便于后期合成' }
        ]
    },
    {
        id: 'app_003',
        name: '短剧分镜工坊',
        icon: '分',
        iconTone: 'cyan',
        category: 'writing',
        authorId: 'u_suwan',
        price: 15,
        runs: 18600,
        rating: 4.7,
        ratingCount: 940,
        version: 'v3.1',
        updatedAt: daysAgo(2),
        status: 'published',
        desc: '把一句故事梗概拆成 8-12 个镜头，自动给出景别、运镜与画面提示词。',
        tags: ['分镜', '短剧', '脚本'],
        model: 'flux-dev',
        workflowId: null,
        inputs: [
            { key: 'story', label: '故事梗概', type: 'textarea', required: true, default: '一名快递员在末日城市里送最后一单，收件人是他自己。', placeholder: '用一两句话描述故事' },
            { key: 'shots', label: '镜头数量', type: 'select', default: '8', options: [
                { value: '6', label: '6 个镜头' },
                { value: '8', label: '8 个镜头' },
                { value: '12', label: '12 个镜头' }
            ] },
            { key: 'tone', label: '整体基调', type: 'select', default: 'tense', options: [
                { value: 'tense', label: '紧张' },
                { value: 'warm', label: '温暖' },
                { value: 'absurd', label: '荒诞' },
                { value: 'epic', label: '史诗' }
            ] }
        ]
    },
    {
        id: 'app_004',
        name: '电商主图生成',
        icon: '商',
        iconTone: 'amber',
        category: 'design',
        authorId: 'u_aji',
        price: 8,
        runs: 96400,
        rating: 4.6,
        ratingCount: 2140,
        version: 'v1.5',
        updatedAt: daysAgo(9),
        status: 'published',
        desc: '上传商品图，一键生成留白构图、带光影的电商主图。',
        tags: ['电商', '主图', '商品'],
        model: 'sdxl',
        workflowId: 'wf_002',
        inputs: [
            { key: 'product', label: '商品名称', type: 'text', required: true, default: '磨砂银蓝牙耳机', placeholder: '例如：磨砂银蓝牙耳机' },
            { key: 'scene', label: '场景', type: 'select', default: 'studio', options: [
                { value: 'studio', label: '纯色影棚' },
                { value: 'stone', label: '石材台面' },
                { value: 'water', label: '水面倒影' },
                { value: 'outdoor', label: '户外自然光' }
            ] },
            { key: 'ratio', label: '尺寸', type: 'select', default: '1:1', options: [
                { value: '1:1', label: '1:1 主图' },
                { value: '3:4', label: '3:4 详情页' }
            ] }
        ]
    },
    {
        id: 'app_005',
        name: '音色克隆配音',
        icon: '音',
        iconTone: 'rose',
        category: 'audio',
        authorId: 'u_zhou',
        price: 10,
        runs: 24800,
        rating: 4.5,
        ratingCount: 780,
        version: 'v2.0',
        updatedAt: daysAgo(12),
        status: 'published',
        desc: '30 秒样本即可克隆音色，支持情绪与语速控制，输出 mp3 与字幕时间轴。',
        tags: ['配音', '音色克隆', 'TTS'],
        model: 'lingxi-v',
        workflowId: null,
        inputs: [
            { key: 'text', label: '配音文本', type: 'textarea', required: true, default: '这是第 12 号实验体，我们已经等了很久。', placeholder: '输入需要配音的文本' },
            { key: 'voice', label: '音色', type: 'select', default: 'linche', options: [
                { value: 'linche', label: '林澈（低沉男声）' },
                { value: 'suwan', label: '苏晚（清冷女声）' },
                { value: 'custom', label: '我的克隆音色' }
            ] },
            { key: 'emotion', label: '情绪强度', type: 'range', default: 60, min: 0, max: 100, step: 5 }
        ]
    },
    {
        id: 'app_006',
        name: '视频口播生成',
        icon: '播',
        iconTone: 'violet',
        category: 'video',
        authorId: 'u_suwan',
        price: 25,
        runs: 7600,
        rating: 4.4,
        ratingCount: 320,
        version: 'v1.2',
        updatedAt: daysAgo(15),
        status: 'published',
        desc: '数字人口播视频，支持横竖屏、字幕与背景替换。',
        tags: ['数字人', '口播', '视频'],
        model: 'kling-v',
        workflowId: 'wf_003',
        inputs: [
            { key: 'script', label: '口播稿', type: 'textarea', required: true, default: '大家好，今天带你看三个提升效率的 AI 工作流。', placeholder: '输入口播稿件' },
            { key: 'avatar', label: '数字人形象', type: 'select', default: 'linche', options: [
                { value: 'linche', label: '林澈' },
                { value: 'bailu', label: '白露' },
                { value: 'none', label: '仅声音 + 空镜' }
            ] },
            { key: 'ratio', label: '画幅', type: 'select', default: '9:16', options: [
                { value: '9:16', label: '竖屏 9:16' },
                { value: '16:9', label: '横屏 16:9' }
            ] }
        ]
    },
    {
        id: 'app_007',
        name: '场景扩图修复',
        icon: '扩',
        iconTone: 'cyan',
        category: 'tool',
        authorId: 'u_jianshan',
        price: 4,
        runs: 58200,
        rating: 4.7,
        ratingCount: 1560,
        version: 'v1.4',
        updatedAt: daysAgo(5),
        status: 'published',
        desc: '智能识别画面边界，向外扩展场景并自动补全缺失内容。',
        tags: ['扩图', '修复', '后期'],
        model: 'sdxl',
        workflowId: 'wf_002',
        inputs: [
            { key: 'direction', label: '扩展方向', type: 'select', default: 'all', options: [
                { value: 'all', label: '四周等比' },
                { value: 'horizontal', label: '仅左右' },
                { value: 'vertical', label: '仅上下' }
            ] },
            { key: 'scale', label: '扩展比例', type: 'range', default: 30, min: 10, max: 100, step: 5, help: '相对原图边长的百分比' }
        ]
    },
    {
        id: 'app_008',
        name: '小红书文案助手',
        icon: '文',
        iconTone: 'rose',
        category: 'writing',
        authorId: 'u_bailu',
        price: 3,
        runs: 132000,
        rating: 4.3,
        ratingCount: 4120,
        version: 'v2.1',
        updatedAt: daysAgo(8),
        status: 'published',
        desc: '输入主题与人群，生成标题、正文与标签，支持多种语气。',
        tags: ['文案', '社交媒体', '标题'],
        model: 'flux-dev',
        workflowId: null,
        inputs: [
            { key: 'topic', label: '内容主题', type: 'text', required: true, default: '周末在家用 AI 做了一组赛博风头像', placeholder: '例如：周末在家用 AI 做了一组赛博风头像' },
            { key: 'audience', label: '目标人群', type: 'select', default: 'young', options: [
                { value: 'young', label: '年轻女性' },
                { value: 'student', label: '学生党' },
                { value: 'parent', label: '亲子家庭' },
                { value: 'pro', label: '职场人' }
            ] },
            { key: 'tone', label: '语气', type: 'select', default: 'casual', options: [
                { value: 'casual', label: '轻松种草' },
                { value: 'pro', label: '专业干货' },
                { value: 'story', label: '故事叙述' }
            ] }
        ]
    }
];
