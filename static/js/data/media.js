/**
 * 演示媒体资源工具
 * 说明：图片来自演示用文生图接口，加载失败时由 UI 层自动降级为本地占位图。
 */
export const DAY = 86400000;
const T0 = Date.now();

export const daysAgo = (days, hours = 0) => new Date(T0 - days * DAY - hours * 3600000).toISOString();

export const img = (prompt, size = 'landscape_16_9') =>
    `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;

export const avatar = (prompt) => img(prompt, 'square');

export const VIDEO_SRC = 'https://www.w3schools.com/html/mov_bbb.mp4';

export const poster = (prompt) => img(prompt, 'landscape_16_9');

export const threeViews = (prompt) => img(`${prompt}, character turnaround sheet, front side back view, white background`, 'landscape_16_9');
