(function () {
    'use strict';

    const form = document.getElementById('deviceLoginForm');
    const status = document.getElementById('loginStatus');
    const gatewayUrl = document.getElementById('gatewayUrl');
    const gatewayToken = document.getElementById('gatewayToken');
    const deviceCode = document.getElementById('deviceCode');
    let revision = 0;
    let busy = false;

    const suppliedGateway = new URLSearchParams(window.location.hash.slice(1)).get('gateway');
    if (suppliedGateway && window.CodexGateway) {
        try { gatewayUrl.value = CodexGateway.normalizeBaseUrl(suppliedGateway); } catch (_) {}
    }

    for (const input of [gatewayUrl, gatewayToken]) {
        input.addEventListener('input', () => {
            revision++;
            deviceCode.value = '';
            status.textContent = '';
        });
    }
    for (const input of [deviceCode, document.getElementById('authorizationUrl')]) {
        input.addEventListener('click', () => input.select());
    }
    for (const button of document.querySelectorAll('[data-copy]')) {
        button.addEventListener('click', async () => {
            const input = document.getElementById(button.dataset.copy);
            if (!input.value) return;
            try {
                await navigator.clipboard.writeText(input.value);
                status.textContent = '已复制。';
            } catch (_) {
                input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
                let copied = false;
                try { copied = document.execCommand('copy'); } catch (_) {}
                status.textContent = copied ? '已复制。' : '内容已选中，请长按或使用系统复制。';
            }
        });
    }

    function recovery(error) {
        if (error.code === 'codex_gateway_upgrade_required' || error.code === 'codex_login_unavailable') {
            return '请更新并重启网关：项目目录执行 git pull --ff-only，gateway 目录执行 npm ci，然后重启网关进程。网关电脑也可运行 npm run login 获取代码。';
        }
        if (error.code === 'codex_requests_active') return '请等待网关当前生成任务结束后，再切换账号。';
        if (error.code === 'unauthorized') return '请从应用或网关电脑重新复制网关访问令牌，然后再次获取代码。';
        if (error.code === 'codex_account_switching') return '网关正在退出账号，请完成后重试。';
        return '请核对 Gateway URL、访问令牌、VPN/Tailscale 和 HTTPS 转发，并确认网关已启动。';
    }

    async function run(action) {
        if (busy || !form.reportValidity()) return;
        busy = true;
        const currentRevision = ++revision;
        const config = { baseUrl: gatewayUrl.value.trim(), token: gatewayToken.value.trim() };
        const controls = [...form.querySelectorAll('button')];
        controls.forEach(button => { button.disabled = true; });
        if (action !== 'status') deviceCode.value = '';
        status.textContent = action === 'status' ? '正在核对连接和账号…' : '正在获取设备代码…';
        try {
            if (!window.CodexGateway) throw new Error('网关客户端未加载，请刷新本页。');
            if (action === 'switch') {
                status.textContent = '正在退出当前账号并获取新设备代码…';
                await CodexGateway.logout(config);
                if (currentRevision !== revision) return;
            }
            if (action === 'status') {
                const result = await CodexGateway.getStatus(config, { timeoutMs: 28_000 });
                if (currentRevision !== revision) return;
                const state = CodexGateway.connectionState(result);
                const account = result.auth?.email || (state.authType === 'none' ? '未登录' : '暂时无法确认邮箱');
                status.textContent = (state.ready ? 'Gateway 已就绪。' : 'Gateway 未就绪。') + '网关账号：' + account;
                return;
            }
            const result = await CodexGateway.startLogin(config);
            if (currentRevision !== revision) return;
            deviceCode.value = result.userCode;
            status.textContent = '设备代码已显示。请复制下方备用授权地址，在所选浏览器或无痕窗口完成授权。';
        } catch (error) {
            if (currentRevision === revision) status.textContent = (error.message || String(error)) + ' ' + recovery(error);
        } finally {
            busy = false;
            controls.forEach(button => { button.disabled = false; });
        }
    }

    form.addEventListener('submit', event => { event.preventDefault(); void run('login'); });
    document.getElementById('switchAccount').addEventListener('click', () => { void run('switch'); });
    document.getElementById('checkConnection').addEventListener('click', () => { void run('status'); });
})();
