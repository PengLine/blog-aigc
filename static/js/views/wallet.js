import { getAccount, recharge, subscribePlan, toggleAutoRecharge } from '../core/api.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, confirmDialog, emptyState } from '../core/ui.js';
import { escapeHtml, num, fmtDate } from '../core/format.js';

const TX_META = {
    consume: { name: '消费', tone: 'danger', sign: '' },
    recharge: { name: '充值', tone: 'ok', sign: '+' },
    refund: { name: '退款', tone: 'ok', sign: '+' },
    subscribe: { name: '订阅赠送', tone: 'brand', sign: '+' },
    license: { name: '授权购买', tone: 'danger', sign: '' }
};

export async function render(host, ctx) {
    setPageTitle('钱包与订阅');
    let account = await getAccount();
    const state = { tab: ctx.query.tab === 'plans' ? 'plans' : 'recharge', filter: 'all' };

    draw();

    function draw() {
        const plan = account.plans.find((p) => p.id === account.plan) || account.plans[0];
        host.innerHTML = `
            <div class="page-head">
                <div class="page-head-main">
                    <h1 class="page-title">钱包与订阅</h1>
                    <div class="page-sub">算力积分用于图片、视频、训练与工作流；订阅套餐每月自动发放额度</div>
                </div>
                <div class="page-actions">
                    <a class="btn btn-outline" href="${url('tasks.html')}">${icon('clock', 15)}消费明细</a>
                    <a class="btn btn-primary" href="${url('assets/create-character.html')}">${icon('sparkles', 15)}去创作</a>
                </div>
            </div>

            <div class="balance-hero" style="margin-bottom:16px">
                <div class="row wrap between" style="gap:20px;position:relative;z-index:1;align-items:flex-end">
                    <div>
                        <div class="label" style="color:rgba(255,255,255,.72)">可用算力</div>
                        <div class="amount">${num(account.credits)}</div>
                        <div class="small" style="color:rgba(255,255,255,.72);margin-top:4px">
                            ${escapeHtml(plan.name)} · 每月 ${num(plan.credits)} 算力 · 下次发放 ${fmtDate(account.resetAt)}
                        </div>
                    </div>
                    <div style="min-width:230px;flex:1;max-width:340px">
                        <div class="row between small" style="color:rgba(255,255,255,.78);margin-bottom:6px">
                            <span>本期已用 ${num(account.used)}</span><span>${account.usedPercent}%</span>
                        </div>
                        <div class="credit-bar" style="height:8px;background:rgba(255,255,255,.22)">
                            <i style="width:${account.usedPercent}%;background:#fff"></i>
                        </div>
                        <div class="row between small" style="color:rgba(255,255,255,.72);margin-top:10px">
                            <span>${icon('refresh', 12)} 自动充值</span>
                            <span class="switch ${account.autoRecharge ? 'on' : ''}" id="autoRecharge" style="background:rgba(255,255,255,.28)"></span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="tabs" id="walletTabs" style="margin-bottom:14px">
                <button class="tab ${state.tab === 'recharge' ? 'active' : ''}" data-tab="recharge">充值算力</button>
                <button class="tab ${state.tab === 'plans' ? 'active' : ''}" data-tab="plans">订阅套餐</button>
                <button class="tab ${state.tab === 'bills' ? 'active' : ''}" data-tab="bills">消费流水</button>
            </div>
            <div id="walletBody"></div>`;

        host.querySelector('#autoRecharge')?.addEventListener('click', async (e) => {
            const el = e.currentTarget;
            el.classList.toggle('on');
            try {
                const enabled = await toggleAutoRecharge(el.classList.contains('on'));
                account.autoRecharge = enabled;
                toast(enabled ? '已开启自动充值：余额低于 200 时自动补充 500' : '已关闭自动充值', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        host.querySelector('#walletTabs')?.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-tab]');
            if (!tab) return;
            state.tab = tab.dataset.tab;
            host.querySelectorAll('#walletTabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
            drawBody();
        });

        drawBody();
    }

    function drawBody() {
        const body = host.querySelector('#walletBody');
        if (state.tab === 'recharge') {
            body.innerHTML = `
                <div class="package-grid">
                    ${account.packages.map((p, i) => `<button class="package ${p.best ? 'best' : ''}" data-pack="${i}">
                        ${p.best ? '<span class="badge badge-brand" style="position:absolute;top:10px;right:10px">最划算</span>' : ''}
                        <div class="p-amount">${num(p.credits)}<small> 算力</small></div>
                        ${p.bonus ? `<div class="p-bonus">赠送 ${num(p.bonus)}</div>` : '<div class="p-bonus">&nbsp;</div>'}
                        <div class="p-price">¥ ${p.price}</div>
                    </button>`).join('')}
                </div>
                <div class="card" style="margin-top:16px">
                    <div class="card-head"><div class="card-title">充能说明</div></div>
                    <div class="card-body small" style="color:var(--text-2);line-height:1.9">
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>算力积分永久有效，不随订阅周期清零。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>任务失败或取消会自动退还算力，可在流水里核对。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>企业采购与私有化部署可通过工作室版联系商务。</span></div>
                    </div>
                </div>`;
            body.querySelectorAll('[data-pack]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const pack = account.packages[Number(btn.dataset.pack)];
                    const ok = await confirmDialog({
                        title: '确认充值',
                        message: `支付 ¥${pack.price} 购买 ${num(pack.credits + pack.bonus)} 算力（含赠送 ${num(pack.bonus)}），演示环境不会真实扣款。`,
                        confirmText: '确认支付'
                    });
                    if (!ok) return;
                    btn.classList.add('loading');
                    try {
                        const res = await recharge(Number(btn.dataset.pack));
                        toast(`充值成功，到账 ${num(res.added)} 算力`, 'success');
                        account = await getAccount();
                        draw();
                    } catch (err) {
                        toast(err.message, 'error');
                        btn.classList.remove('loading');
                    }
                });
            });
            return;
        }

        if (state.tab === 'plans') {
            body.innerHTML = `<div class="grid cols-3" style="gap:16px">
                ${account.plans.map((p) => `<div class="plan-card ${p.id === account.plan ? 'current' : ''}">
                    <div class="row between">
                        <b style="font-size:15px">${escapeHtml(p.name)}</b>
                        ${p.id === account.plan ? '<span class="badge badge-brand">当前套餐</span>' : ''}
                    </div>
                    <div style="margin:10px 0 4px;font-size:24px;font-weight:700">¥${p.price}<span class="small muted" style="font-weight:400"> / 月</span></div>
                    <div class="small muted">每月发放 ${num(p.credits)} 算力 · 并发 ${p.limits.concurrency}</div>
                    <ul>
                        ${p.features.map((f) => `<li>${icon('check', 13)}<span>${escapeHtml(f)}</span></li>`).join('')}
                    </ul>
                    <button class="btn ${p.id === account.plan ? 'btn-outline' : 'btn-primary'} btn-block" data-plan="${p.id}" ${p.id === account.plan ? 'disabled' : ''}>
                        ${p.id === account.plan ? '当前套餐' : p.price === 0 ? '切换到体验版' : `订阅 ${p.name}`}
                    </button>
                </div>`).join('')}
            </div>
            <div class="card" style="margin-top:16px">
                <div class="card-head"><div class="card-title">套餐对比</div></div>
                <div class="card-body" style="padding-top:0">
                    <div class="table-wrap">
                        <table class="table">
                            <thead><tr><th>权益</th>${account.plans.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('')}</tr></thead>
                            <tbody>
                                <tr><td>每月算力</td>${account.plans.map((p) => `<td>${num(p.credits)}</td>`).join('')}</tr>
                                <tr><td>并发任务</td>${account.plans.map((p) => `<td>${p.limits.concurrency}</td>`).join('')}</tr>
                                <tr><td>资产上限</td>${account.plans.map((p) => `<td>${p.limits.assets === Infinity ? '无限' : p.limits.assets}</td>`).join('')}</tr>
                                <tr><td>商用授权</td>${account.plans.map((p) => `<td>${p.id === 'free' ? '—' : '支持'}</td>`).join('')}</tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>`;
            body.querySelectorAll('[data-plan]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.plan;
                    const plan = account.plans.find((p) => p.id === id);
                    const ok = await confirmDialog({
                        title: `订阅${plan.name}`,
                        message: `订阅后将立即发放 ${num(plan.credits)} 算力，演示环境不会真实扣款。`,
                        confirmText: '确认订阅'
                    });
                    if (!ok) return;
                    btn.classList.add('loading');
                    try {
                        await subscribePlan(id);
                        toast(`已切换到${plan.name}`, 'success');
                        account = await getAccount();
                        draw();
                    } catch (err) {
                        toast(err.message, 'error');
                        btn.classList.remove('loading');
                    }
                });
            });
            return;
        }

        // 流水
        const list = account.transactions;
        if (!list.length) {
            body.innerHTML = emptyState({ title: '暂无流水记录', desc: '充值、消费与退款都会记录在这里。' });
            return;
        }
        const consume = list.filter((t) => t.type === 'consume').reduce((s, t) => s + Math.abs(t.amount), 0);
        const income = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
        body.innerHTML = `
            <div class="grid cols-3" style="margin-bottom:16px">
                ${miniStat('累计消费', num(consume), '近 30 条流水', 'zap')}
                ${miniStat('累计充值', num(income), '含赠送与订阅', 'credit')}
                ${miniStat('退款笔数', String(list.filter((t) => t.type === 'refund').length), '任务失败自动退还', 'refresh')}
            </div>
            <div class="card">
                <div class="card-head">
                    <div class="card-title">消费流水</div>
                    <div class="spacer"></div>
                    <span class="small muted">共 ${list.length} 条</span>
                </div>
                <div class="card-body" style="padding-top:0">
                    <div class="table-wrap">
                        <table class="table">
                            <thead><tr><th>类型</th><th>说明</th><th>变动</th><th>余额</th><th>时间</th></tr></thead>
                            <tbody>
                                ${list.map((t) => {
            const meta = TX_META[t.type] || { name: t.type, tone: '', sign: '' };
            return `<tr>
                                        <td><span class="badge ${meta.tone ? `badge-${meta.tone}` : ''}">${meta.name}</span></td>
                                        <td>${escapeHtml(t.title)}</td>
                                        <td style="font-weight:600;color:${t.amount > 0 ? 'var(--ok)' : 'var(--text)'}">${t.amount > 0 ? '+' : ''}${num(t.amount)}</td>
                                        <td class="mono">${num(t.balanceAfter ?? 0)}</td>
                                        <td class="small muted">${fmtDate(t.createdAt, true)}</td>
                                    </tr>`;
        }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>`;
    }
}

function miniStat(label, value, sub, iconName) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value">${escapeHtml(String(value))}</div>
        <div class="metric-trend">${escapeHtml(sub)}</div>
    </div>`;
}
