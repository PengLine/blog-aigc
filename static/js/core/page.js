import { renderShell, setPageTitle } from './shell.js';
import { startEngine } from './engine.js';
import { queryParams, escapeHtml } from './format.js';
import { icon } from './ui.js';

/**
 * 页面挂载器：渲染全局外壳 → 启动任务引擎 → 调用视图渲染函数
 * 视图签名：(contentEl, { query, setTitle }) => Promise<void>
 */
export async function mount({ nav = 'gallery', title = '工作台', params = {}, render }) {
    const { content } = renderShell({ nav, title });
    startEngine();

    const ctx = {
        query: queryParams(),
        params,
        setTitle: setPageTitle,
        navigate(path) {
            window.location.href = path;
        }
    };

    try {
        await render(content, ctx);
    } catch (err) {
        console.error('[page] 渲染失败', err);
        content.innerHTML = `<div class="card" style="margin-top:40px">
            <div class="empty">
                <div class="empty-icon">${icon('alert', 24)}</div>
                <h4>页面加载失败</h4>
                <p>${escapeHtml(err.message || '未知错误，请刷新重试')}</p>
                <button class="btn btn-primary" onclick="location.reload()">重新加载</button>
            </div>
        </div>`;
    }
}
