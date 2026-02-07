const vscode = require('vscode');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * GLM Usage Monitor Extension 4.10.1
 * Feature: Chinese localization for Hover Dashboard
 */

function activate(context) {
    const service = new GLMUsageService(context);
    service.start();
}

function deactivate() { }

class GLMUsageService {
    constructor(context) {
        this.context = context;
        this.statusBarItem = null;
        this.cachedData = null;
        this.initStatusBar();
        this.registerCommands();
    }

    initStatusBar() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        this.statusBarItem.text = '$(pulse) GLM 初始化...';
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }

    registerCommands() {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('glm-usage.refresh', () => this.fetchUsageData(true)),
            vscode.commands.registerCommand('glm-usage.configure', () => this.configureToken())
        );
        this.statusBarItem.command = 'glm-usage.refresh';
    }

    async start() {
        await this.fetchUsageData();
        this.startPeriodicRefresh();
    }

    async configureToken() {
        const config = vscode.workspace.getConfiguration('glmUsage');
        const token = await vscode.window.showInputBox({
            prompt: '请输入智谱 API Token',
            password: true,
            value: config.get('authToken', '')
        });
        if (token) {
            await config.update('authToken', token, vscode.ConfigurationTarget.Global);
            this.fetchUsageData(true);
        }
    }

    async fetchUsageData(force = false) {
        try {
            const config = this.loadConfig();
            if (!config.authToken) {
                this.statusBarItem.text = '$(gear) 配置 GLM';
                return;
            }
            if (force) this.statusBarItem.text = '$(sync~spin) 刷新中...';

            const data = await this.fetchFromAPI(config);
            this.cachedData = data;
            this.updateStatusBar(data);
        } catch (e) {
            console.error(e);
            this.statusBarItem.text = '$(error) GLM 错误';
        }
    }

    loadConfig() {
        const config = vscode.workspace.getConfiguration('glmUsage');
        return {
            authToken: config.get('authToken') || process.env.ANTHROPIC_AUTH_TOKEN || '',
            baseUrl: config.get('baseUrl') || 'https://open.bigmodel.cn/api/anthropic',
            timeout: config.get('timeout', 30000)
        };
    }

    async request(url, config) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);

            // 获取代理设置：环境变量或VS Code配置
            let proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

            // 如果环境变量没有，尝试从VS Code代理设置获取
            if (!proxyUrl) {
                const vscodeProxy = vscode.workspace.getConfiguration('http').get('proxy');
                if (vscodeProxy) {
                    proxyUrl = vscodeProxy;
                }
            }

            const options = {
                hostname: parsedUrl.hostname,
                port: 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                rejectUnauthorized: false,
                timeout: config.timeout,
                headers: { 'Authorization': config.authToken, 'Content-Type': 'application/json' }
            };

            // 如果有代理，使用代理agent
            if (proxyUrl) {
                options.agent = new HttpsProxyAgent(proxyUrl);
            }

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    async fetchFromAPI(config) {
        const base = new URL(config.baseUrl);
        const domain = `${base.protocol}//${base.host}`;
        const platform = config.baseUrl.includes('z.ai') ? 'Z.AI' : '智谱AI';

        const now = new Date();
        const start = new Date(now); start.setDate(now.getDate() - 1); start.setMinutes(0);
        const end = new Date(now); end.setMinutes(59);
        const zFormat = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

        const q = `?startTime=${encodeURIComponent(zFormat(start))}&endTime=${encodeURIComponent(zFormat(end))}`;

        const [model, tool, quota] = await Promise.all([
            this.request(`${domain}/api/monitor/usage/model-usage${q}`, config),
            this.request(`${domain}/api/monitor/usage/tool-usage${q}`, config),
            this.request(`${domain}/api/monitor/usage/quota/limit`, config)
        ]);

        return this.processData({ model, tool, quota, platform, timestamp: now });
    }

    processData({ model, tool, quota, platform, timestamp }) {
        const mData = model.data || {};
        const qData = quota.data || {};

        let history = [];
        if (Array.isArray(mData.x_time)) {
            history = mData.x_time.map((time, i) => ({
                time: time.split(' ')[1] || time,
                calls: mData.modelCallCount?.[i] || 0
            }));
        }

        let quotas = { mcp: { used: 0, total: 0, pct: '0.00' }, token5h: { used: 0, total: 0, pct: '0.00' } };
        (qData.limits || []).forEach(l => {
            if (l.type === 'TIME_LIMIT') {
                const pct = l.usage > 0 ? (l.currentValue / l.usage) * 100 : 0;
                quotas.mcp = { used: l.currentValue, total: l.usage, pct: pct.toFixed(2) };
            }
            if (l.type === 'TOKENS_LIMIT') {
                const pct = l.usage > 0 ? (l.currentValue / l.usage) * 100 : 0;
                quotas.token5h = { used: l.currentValue, total: l.usage, pct: pct.toFixed(2) };
            }
        });

        return {
            platform, timestamp: timestamp.getTime(),
            totals: {
                calls: mData.totalUsage?.totalModelCallCount || 0,
                tokens: mData.totalUsage?.totalTokensUsage || 0
            },
            quotas, history
        };
    }

    updateStatusBar(data) {
        const mcp = data.quotas.mcp.pct;
        const t5h = data.quotas.token5h.pct;
        const calls = data.totals.calls.toLocaleString();
        const tokens = this.formatTokens(data.totals.tokens);

        this.statusBarItem.text = `$(graph) GLM: ${mcp}%(MCP) ${t5h}%(5h) | ${calls}次 ${tokens}`;
        this.statusBarItem.backgroundColor = (mcp > 80 || t5h > 80) ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
        this.statusBarItem.tooltip = this.buildDashboardTooltip(data);
    }

    buildDashboardTooltip(data) {
        const md = new vscode.MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;

        const dateStr = new Date(data.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
        const mcpColor = data.quotas.mcp.pct > 80 ? '#da3633' : '#58a6ff';
        const t5hColor = data.quotas.token5h.pct > 80 ? '#da3633' : '#238636';

        md.appendMarkdown(`### **GLM 数据看板** &nbsp; \`${data.platform}\`\n`);
        md.appendMarkdown(`<span style="color:#8b949e">更新时间: ${dateStr}</span>\n\n`);
        md.appendMarkdown(`---\n`);

        md.appendMarkdown(`| **Token 总量** | **今日调用 (24H)** |\n`);
        md.appendMarkdown(`| :--- | :--- |\n`);
        md.appendMarkdown(`| <span style="color:#d2a8ff;font-size:15px;font-weight:bold">${this.formatNumber(data.totals.tokens)}</span> | <span style="color:#79c0ff;font-size:15px;font-weight:bold">${this.formatNumber(data.totals.calls)}</span> |\n\n`);

        md.appendMarkdown(`**配额状态**\n\n`);

        const drawBar = (pct, color) => {
            let val = parseFloat(pct);
            if (isNaN(val)) val = 0;
            const filled = Math.max(0, Math.min(15, Math.round((val / 100) * 15)));
            return `<span style="color:${color}">${'█'.repeat(filled)}</span><span style="color:#484f58">${'░'.repeat(15 - filled)}</span>`;
        };

        md.appendMarkdown(`MCP 额度 (月) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;**${data.quotas.mcp.pct}%**\n\n`);
        md.appendMarkdown(`${drawBar(data.quotas.mcp.pct, mcpColor)} &nbsp; ${data.quotas.mcp.used}/${data.quotas.mcp.total}\n\n`);

        md.appendMarkdown(`Token 限流 (5小时) &nbsp;**${data.quotas.token5h.pct}%**\n\n`);
        md.appendMarkdown(`${drawBar(data.quotas.token5h.pct, t5hColor)} &nbsp; ${this.formatTokens(data.quotas.token5h.used || 0)}/${this.formatTokens(data.quotas.token5h.total || 0)}\n\n`);

        if (data.history.length > 0) {
            // Calculate peak from full history, filter out null/undefined calls
            const validHistory = data.history.filter(h => h.calls != null && h.calls !== undefined);
            if (validHistory.length > 0) {
                const peak = validHistory.reduce((a, b) => a.calls > b.calls ? a : b);
                const peakTime = peak.time.split(' ')[1] || peak.time;
                md.appendMarkdown(`**调用趋势 (24H)** &nbsp;&nbsp;&nbsp; <span style="color:#8b949e;font-size:12px">峰值: **${peak.calls}** (${peakTime})</span>\n\n`);
            }
            md.appendMarkdown(`![](${this.generateTrendSVG(data.history)})\n\n`);
        } else {
            md.appendMarkdown(`**调用趋势 (24H)**\n\n`);
        }

        md.appendMarkdown(`---\n`);
        md.appendMarkdown(`[$(refresh) **刷新数据**](command:glm-usage.refresh) &nbsp;&nbsp; [$(settings) **配置 Token**](command:glm-usage.configure)`);
        return md;
    }

    generateTrendSVG(history) {
        // Target: Fixed width to align with text above (~240px)
        const barWidth = 8;
        const gap = 2;
        const totalPoints = 24;
        const width = totalPoints * (barWidth + gap); // 240px
        const height = 60; // Fixed total height

        // 1. Prepare Data: Always 24 points. Pad left with 0 if needed.
        let points = history;
        if (points.length > totalPoints) {
            points = points.slice(points.length - totalPoints);
        }
        while (points.length < totalPoints) {
            points.unshift({ calls: 0, time: '' });
        }

        const maxCalls = Math.max(...points.map(h => h.calls || 0), 1);

        let rects = '';
        points.forEach((p, i) => {
            // Cap height at 45px max to reserve space for text
            const h = p.calls === 0 ? 2 : Math.max(Math.round((p.calls / maxCalls) * 45), 2);
            const x = i * (barWidth + gap);
            const y = 45 - h; // Base line at 45

            const isPeak = p.calls === maxCalls && maxCalls > 0;
            const color = isPeak ? '#d2a8ff' : '#58a6ff';
            const opacity = isPeak ? '1.0' : '0.8';
            rects += `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2" fill="${color}" fill-opacity="${opacity}" />`;
        });

        const timeLabel = (index) => {
            const t = points[index]?.time || '';
            // Format: "09" from "09:00", strict check
            return t ? t.split(':')[0] : '';
        };

        // Labels with fixed positions
        const texts = `
            <text x="0" y="58" font-family="sans-serif" font-size="9" fill="#8b949e" text-anchor="start">${timeLabel(0)}</text>
            <text x="${width / 2}" y="58" font-family="sans-serif" font-size="9" fill="#8b949e" text-anchor="middle">${timeLabel(12)}</text>
            <text x="${width - 2}" y="58" font-family="sans-serif" font-size="9" fill="#8b949e" text-anchor="end">${timeLabel(23)}</text>
        `;

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
            ${rects}
            ${texts}
        </svg>`;

        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    startPeriodicRefresh() { setInterval(() => this.fetchUsageData(), 60000); }

    formatTokens(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return String(num);
    }

    formatNumber(num) {
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
}
module.exports = { activate, deactivate };
