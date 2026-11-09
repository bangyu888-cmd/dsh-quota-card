/**
 * dsh-quota-card — client half (browser bundle, loaded through the
 * dsh.client module loader).
 *
 * Renders a full-width card into `sidebar.footer.action`, directly above the
 * settings seat (settings trigger + account/login row) at the sidebar foot.
 *
 * Data comes from the Host half over the `/dsh-quota-card` Connection RPC
 * channel: one `fetch-all` call returns normalized rows (usage windows with
 * reset timestamps, or a monetary balance). Credentials never reach the
 * browser. A local 1 s ticker redraws only the reset countdowns; polling
 * follows the host-supplied refreshMs and pauses while the page is hidden.
 *
 * Styling uses Harness theme tokens (--dsw-alias-*) only, so the card
 * follows the product theme (light/dark) and ships no palette of its own.
 * Provider monograms are original letter chips, not brand logos.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'quota-card';
    const CHANNEL = '/dsh-quota-card';
    const DEFAULT_REFRESH_MS = 60000;

    const DICT = {
      zh: {
        cardLabel: '账户额度',
        title: '额度',
        refresh: '刷新',
        offline: '离线',
        loading: '读取中',
        notLoggedIn: '未登录',
        unknown: '—',
        pending: '下一阶段接入',
        remaining: '剩 {pct}%',
        bonusIncluded: '含赠送 ¥{amount}',
        plan: '套餐：{plan}',
        resetShort: '重置 {cd}',
        resetIn: '{cd}后重置',
        needLogin: '需登录',
        setupShort: '待登录',
        pendingShort: '待接入',
        failedShort: '获取失败',
        resetSoon: '即将重置',
        cdDays: '{d}天{h}时',
        cdHours: '{h}时{m}分',
        cdMinutes: '{m}分',
        winRolling: '5 小时',
        winWeekly: '每周',
        winMonthly: '月度',
        updatedAt: '更新于 {time}',
        loadFailed: '额度读取失败',
        fetchFailed: '额度获取失败',
        railLabel: '账户额度状态',
        settings: '设置',
        close: '关闭',
        showSection: '显示',
        refreshSection: '刷新间隔',
        seconds: '{n} 秒',
        thresholdSection: '剩余比例告警',
        percentWarn: '黄色（≤）',
        percentCrit: '红色（≤）',
        balanceSection: '余额告警（元）',
        balanceWarn: '黄色（≤）',
        balanceCrit: '红色（≤）',
        proxySection: 'HTTP 代理',
        proxyGlobal: '全局',
        proxyHint: '留空 = 直连；仅当目标连不上时填写，如 http://127.0.0.1:7890',
        restore: '恢复默认',
        allHidden: '所有 provider 已隐藏',
      },
      en: {
        cardLabel: 'Account quota',
        title: 'Quota',
        refresh: 'Refresh',
        offline: 'Offline',
        loading: 'Loading',
        notLoggedIn: 'Not signed in',
        unknown: '—',
        pending: 'Wired next phase',
        remaining: '{pct}% left',
        bonusIncluded: 'incl. ¥{amount} bonus',
        plan: 'Plan: {plan}',
        resetShort: 'reset {cd}',
        resetIn: 'resets in {cd}',
        needLogin: 'sign in',
        setupShort: 'set up',
        pendingShort: 'pending',
        failedShort: 'failed',
        resetSoon: 'resetting',
        cdDays: '{d}d {h}h',
        cdHours: '{h}h {m}m',
        cdMinutes: '{m}m',
        winRolling: '5h',
        winWeekly: 'Weekly',
        winMonthly: 'Monthly',
        updatedAt: 'Updated {time}',
        loadFailed: 'Could not read quota',
        fetchFailed: 'Quota request failed',
        railLabel: 'Account quota status',
        settings: 'Settings',
        close: 'Close',
        showSection: 'Show',
        refreshSection: 'Refresh every',
        seconds: '{n}s',
        thresholdSection: 'Remaining alerts',
        percentWarn: 'Warn (≤)',
        percentCrit: 'Critical (≤)',
        balanceSection: 'Balance alerts (CNY)',
        balanceWarn: 'Warn (≤)',
        balanceCrit: 'Critical (≤)',
        proxySection: 'HTTP proxy',
        proxyGlobal: 'Global',
        proxyHint: 'Empty = direct; set only when a target is unreachable, e.g. http://127.0.0.1:7890',
        restore: 'Restore defaults',
        allHidden: 'All providers are hidden',
      },
    };

    const STORAGE_KEY = 'dsh-quota-card:settings';
    const REFRESH_OPTIONS = [30000, 60000, 120000, 300000];

    /** Defaults are derived from ORDER, so a new provider needs no settings edit. */
    function defaultSettings() {
      const show = {};
      const proxy = {};
      for (const id of ORDER) {
        show[id] = true;
        proxy[id] = '';
      }
      return {
        refreshMs: 60000,
        show,
        warnPct: 30,
        critPct: 10,
        balanceWarn: 10,
        balanceCrit: 3,
        proxyGlobal: '',
        proxy,
      };
    }

    function clampNumber(value, min, max, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    }

    function readSettings() {
      const fallback = defaultSettings();
      try {
        const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return fallback;
        const next = { ...fallback, ...raw };
        next.show = { ...fallback.show, ...(raw.show && typeof raw.show === 'object' ? raw.show : {}) };
        next.proxy = { ...fallback.proxy, ...(raw.proxy && typeof raw.proxy === 'object' ? raw.proxy : {}) };
        next.refreshMs = REFRESH_OPTIONS.includes(Number(next.refreshMs)) ? Number(next.refreshMs) : fallback.refreshMs;
        next.warnPct = clampNumber(next.warnPct, 5, 80, fallback.warnPct);
        next.critPct = clampNumber(next.critPct, 1, Math.max(1, next.warnPct - 1), fallback.critPct);
        next.balanceWarn = clampNumber(next.balanceWarn, 0, 1000, fallback.balanceWarn);
        next.balanceCrit = clampNumber(next.balanceCrit, 0, Math.max(0, next.balanceWarn - 0.01), fallback.balanceCrit);
        next.proxyGlobal = typeof next.proxyGlobal === 'string' ? next.proxyGlobal : '';
        for (const id of ORDER) next.proxy[id] = typeof next.proxy[id] === 'string' ? next.proxy[id] : '';
        return next;
      } catch {
        return fallback;
      }
    }

    function writeSettings(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        /* storage unavailable */
      }
    }

    const PROVIDERS = {
      chatgpt: { name: 'ChatGPT', tile: '#F7F7F8', ink: '#0E0F12', light: true },
      gemini: { name: 'Gemini', tile: '#0B0B0D', ink: '#FFFFFF' },
      grok: { name: 'Grok Bot', tile: '#000000', ink: '#FFFFFF' },
      deepseek: { name: 'DeepSeek', tile: '#F7F7F8', ink: '#15171C', light: true },
    };

    /** Official brand glyphs (Simple Icons, CC0; trademarks belong to their owners). */
    const ICON_PATHS = {
      chatgpt: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
      gemini: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
      deepseek: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
    };
    /** Grok Bot app mark (white robot head), used on the dark brand chip. */
    const GROK_ICON = 'data:image/png;base64,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';

    function ProviderGlyph({ id }) {
      if (id === 'grok') {
        return h('img', { src: GROK_ICON, width: 12, height: 12, alt: '', 'aria-hidden': true });
      }
      const d = ICON_PATHS[id];
      if (id === 'gemini' && d) {
        const gradId = 'qc-gemini-gradient';
        return h('svg', { viewBox: '0 0 24 24', width: 12, height: 12, 'aria-hidden': true },
          h('defs', null,
            h('linearGradient', { id: gradId, x1: '0%', y1: '100%', x2: '100%', y2: '0%' },
              h('stop', { offset: '0%', stopColor: '#4285F4' }),
              h('stop', { offset: '35%', stopColor: '#34A853' }),
              h('stop', { offset: '62%', stopColor: '#FBBC05' }),
              h('stop', { offset: '100%', stopColor: '#EA4335' }))),
          h('path', { d, fill: 'url(#' + gradId + ')' }));
      }
      if (d) {
        return h('svg', { viewBox: '0 0 24 24', width: 11, height: 11, 'aria-hidden': true },
          h('path', { d, fill: 'currentColor' }));
      }
      const provider = PROVIDERS[id];
      const letter = provider && typeof provider.letter === 'string'
        ? provider.letter
        : (provider && provider.name ? provider.name.slice(0, 1).toUpperCase() : '?');
      return h('span', { className: 'qc-badge-letter' }, letter);
    }
    /** Display order = registry insertion order. Adding a provider here is the only client registration. */
    const ORDER = Object.keys(PROVIDERS);

    const DEFAULT_SETTINGS = defaultSettings();

    const CSS = [
      '.qc-root{position:relative;box-sizing:border-box;flex:1 1 0%;min-width:0;margin:0 6px 8px 8px;padding:8px 10px 6px;border-radius:var(--dsw-radius-md,10px);border:1px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-layer-2,transparent);font-family:inherit}',
      '.qc-head{display:flex;align-items:center;justify-content:space-between;height:18px;margin-bottom:2px}',
      '.qc-title{font-size:11px;font-weight:500;letter-spacing:.04em;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.qc-head-right{display:flex;align-items:center;gap:6px}',
      '.qc-tag{font-size:10px;line-height:14px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,transparent);color:var(--dsw-alias-label-secondary)}',
      '.qc-tag.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.qc-refresh{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.65}',
      '.qc-refresh:hover:not(:disabled){opacity:1;background:var(--dsw-alias-interactive-bg-hover,transparent)}',
      '.qc-refresh:disabled{opacity:.35;cursor:default}',
      '.qc-refresh:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.qc-refresh svg{display:block;transition:transform .25s ease}',
      '.qc-refresh.is-busy svg{animation:qc-spin 1s linear infinite}',
      '@keyframes qc-spin{to{transform:rotate(360deg)}}',
      '.qc-row{padding:2px 0 4px;display:flex;flex-direction:column;gap:3px}',
      '.qc-line{display:flex;align-items:center;gap:6px;height:20px}',
      '.qc-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;color:#fff}',
      '.qc-badge svg,.qc-badge img{display:block}',
      '.qc-badge-letter{font-size:9px;font-weight:700;line-height:1}',
      '.qc-name{flex:1;min-width:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qc-value{flex:none;font-size:12.5px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.qc-value.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.qc-value.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.qc-value.is-muted{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.qc-meter{display:flex;align-items:center;gap:8px;height:18px}',
      '.qc-meter .qc-bar{flex:1;min-width:0;height:2px}',
      '.qc-meter .qc-value{line-height:18px}',
      '.qc-bar{height:2px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-border-l1,transparent);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}',
      '.qc-bar>span{display:block;height:100%;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent)}',
      '.qc-bar>span.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.qc-bar>span.is-error{background:var(--dsw-alias-state-error-primary)}',
      '.qc-aux{flex:none;font-size:10px;line-height:20px;font-weight:400;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);opacity:.9;white-space:nowrap}',
      '.qc-aux.is-warn{color:var(--dsw-alias-state-warn-primary);opacity:1}',
      '.qc-aux.is-error{color:var(--dsw-alias-state-error-primary);opacity:1}',
      '.qc-rail{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px 2px;box-sizing:border-box}',
      '.qc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}',
      '.qc-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.qc-dot.is-error{background:var(--dsw-alias-state-error-primary)}',
      '.qc-dot.is-muted{background:var(--dsw-alias-label-secondary);opacity:.45}',
      '.qc-refresh.is-on{opacity:1;background:var(--dsw-alias-interactive-bg-hover,transparent)}',
      '.qc-pop{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:30;box-sizing:border-box;max-height:min(70vh,460px);overflow:auto;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,transparent);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#1b1d21));box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}',
      '.qc-pop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}',
      '.qc-pop-title{font-size:12px;font-weight:600}',
      '.qc-sec{margin-top:8px}',
      '.qc-sec-title{font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin-bottom:3px}',
      '.qc-opt{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;font-size:12px}',
      '.qc-check{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);margin:0}',
      '.qc-segs{display:flex;gap:4px}',
      '.qc-seg{flex:1;padding:3px 0;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,transparent);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer}',
      '.qc-seg.is-on{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,transparent))}',
      '.qc-num{width:56px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;text-align:right}',
      '.qc-hint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.qc-proxy-row{display:flex;align-items:center;gap:6px;margin-top:4px}',
      '.qc-proxy-label{flex:none;width:62px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.qc-input{flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:11px}',
      '.qc-input:focus-visible,.qc-num:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.qc-reset{margin-top:10px;width:100%;padding:4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,transparent);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}',
      '.qc-reset:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
      '.qc-empty{font-size:11px;line-height:18px;padding:6px 0 2px;color:var(--dsw-alias-label-secondary)}',
      '@media (prefers-reduced-motion:reduce){.qc-refresh svg{transition:none}.qc-refresh.is-busy svg{animation:none}}',
    ].join('\n');

    function RefreshGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: '14', height: '14',
        fill: 'none', stroke: 'currentColor', strokeWidth: '1.5',
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-2.03-4.2' }),
        h('polyline', { points: '13.5 1.5 13.5 5 10 5' }));
    }

    function primaryWindow(row) {
      if (!row || !row.windows) return null;
      for (const lane of ['weekly', 'rolling', 'monthly']) {
        const win = row.windows[lane];
        if (win && Number.isFinite(win.remaining)) return { lane, ...win };
      }
      return null;
    }

    /** warn/error tier for the row; undefined statuses stay neutral. */
    function tierOf(row, settings) {
      const opts = settings || DEFAULT_SETTINGS;
      if (!row) return '';
      if (row.status === 'error') return 'error';
      if (row.status !== 'ok') return '';
      if (row.kind === 'usage') {
        const win = primaryWindow(row);
        if (!win) return '';
        if (win.remaining <= opts.critPct) return 'error';
        if (win.remaining <= opts.warnPct) return 'warn';
        return '';
      }
      if (row.kind === 'balance' && Number.isFinite(row.amount)) {
        if (row.amount <= opts.balanceCrit) return 'error';
        if (row.amount <= opts.balanceWarn) return 'warn';
      }
      return '';
    }

    function windowLabel(lane, t) {
      if (lane === 'rolling') return t('winRolling');
      if (lane === 'weekly') return t('winWeekly');
      if (lane === 'monthly') return t('winMonthly');
      return lane;
    }

    function countdownText(resetsAt, now, t) {
      const at = Date.parse(resetsAt || '');
      if (!Number.isFinite(at)) return null;
      const ms = at - now;
      if (ms <= 0) return t('resetSoon');
      const minutes = Math.floor(ms / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const mins = minutes % 60;
      if (days > 0) return t('cdDays', { d: days, h: hours });
      if (hours > 0) return t('cdHours', { h: hours, m: mins });
      return t('cdMinutes', { m: Math.max(mins, 1) });
    }

    function formatMoney(amount) {
      return '¥ ' + Number(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function detailOf(row, now, t) {
      const parts = [];
      if (row.plan) parts.push(t('plan', { plan: row.plan }));
      if (row.windows) {
        for (const lane of ['weekly', 'rolling', 'monthly']) {
          const win = row.windows[lane];
          if (!win || !Number.isFinite(win.remaining)) continue;
          const cd = countdownText(win.resetsAt, now, t);
          parts.push(windowLabel(lane, t) + ' · ' + t('remaining', { pct: win.remaining }) + (cd ? ' · ' + t('resetIn', { cd }) : ''));
        }
      }
      if (row.kind === 'balance' && Number.isFinite(row.amount)) {
        parts.push(formatMoney(row.amount) + (row.bonus ? ' · ' + t('bonusIncluded', { amount: Number(row.bonus).toFixed(2) }) : ''));
      }
      if (row.error && row.error.message) parts.push(row.error.message);
      if (row.updatedAt) {
        parts.push(t('updatedAt', { time: new Date(row.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
      }
      return parts.join('\n');
    }

    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [active]);
      return now;
    }

    function GearGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('circle', { cx: '8', cy: '8', r: '2.2' }),
        h('path', { d: 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1' }));
    }

    function SettingsPanel({ settings, update, reset, onClose, t }) {
      const toggleShow = (id) => update((prev) => ({ ...prev, show: { ...prev.show, [id]: !prev.show[id] } }));
      const setRefresh = (ms) => update((prev) => ({ ...prev, refreshMs: ms }));
      const num = (key, min, max) => (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        update((prev) => {
          const next = { ...prev, [key]: Math.min(Math.max(value, min), max) };
          if (next.critPct >= next.warnPct) next.critPct = Math.max(1, next.warnPct - 1);
          if (next.balanceCrit >= next.balanceWarn) next.balanceCrit = Math.max(0, Number((next.balanceWarn - 0.1).toFixed(2)));
          return next;
        });
      };
      const setProxy = (key) => (event) => {
        const value = event.target.value;
        update((prev) => (key === 'global'
          ? { ...prev, proxyGlobal: value }
          : { ...prev, proxy: { ...prev.proxy, [key]: value } }));
      };
      const numberInput = (key, min, max) => h('input', {
        className: 'qc-num', type: 'number', min, max, value: settings[key],
        onChange: num(key, min, max), 'aria-label': key,
      });

      return h('div', { className: 'qc-pop', role: 'dialog', 'aria-label': t('settings') },
        h('div', { className: 'qc-pop-head' },
          h('span', { className: 'qc-pop-title' }, t('settings')),
          h('button', { className: 'qc-refresh', type: 'button', 'aria-label': t('close'), title: t('close'), onClick: onClose }, '\u2715')),
        h('div', { className: 'qc-sec' },
          h('div', { className: 'qc-sec-title' }, t('showSection')),
          ORDER.map((id) => h('div', { className: 'qc-opt', key: id },
            h('span', null, (PROVIDERS[id] || { name: id }).name),
            h('input', {
              className: 'qc-check', type: 'checkbox', checked: settings.show[id] !== false,
              onChange: () => toggleShow(id), 'aria-label': (PROVIDERS[id] || { name: id }).name,
            })))),
        h('div', { className: 'qc-sec' },
          h('div', { className: 'qc-sec-title' }, t('refreshSection')),
          h('div', { className: 'qc-segs' }, REFRESH_OPTIONS.map((ms) => h('button', {
            key: ms, type: 'button',
            className: 'qc-seg' + (settings.refreshMs === ms ? ' is-on' : ''),
            onClick: () => setRefresh(ms),
          }, t('seconds', { n: Math.round(ms / 1000) }))))),
        h('div', { className: 'qc-sec' },
          h('div', { className: 'qc-sec-title' }, t('thresholdSection')),
          h('div', { className: 'qc-opt' }, h('span', null, t('percentWarn')), numberInput('warnPct', 5, 80)),
          h('div', { className: 'qc-opt' }, h('span', null, t('percentCrit')), numberInput('critPct', 1, 79))),
        h('div', { className: 'qc-sec' },
          h('div', { className: 'qc-sec-title' }, t('balanceSection')),
          h('div', { className: 'qc-opt' }, h('span', null, t('balanceWarn')), numberInput('balanceWarn', 0, 1000)),
          h('div', { className: 'qc-opt' }, h('span', null, t('balanceCrit')), numberInput('balanceCrit', 0, 1000))),
        h('div', { className: 'qc-sec' },
          h('div', { className: 'qc-sec-title' }, t('proxySection')),
          h('div', { className: 'qc-hint' }, t('proxyHint')),
          h('div', { className: 'qc-proxy-row' },
            h('span', { className: 'qc-proxy-label' }, t('proxyGlobal')),
            h('input', {
              className: 'qc-input', type: 'text', placeholder: 'http://127.0.0.1:7890',
              value: settings.proxyGlobal, onChange: setProxy('global'), 'aria-label': t('proxyGlobal'),
            })),
          ORDER.map((id) => h('div', { className: 'qc-proxy-row', key: id },
            h('span', { className: 'qc-proxy-label' }, (PROVIDERS[id] || { name: id }).name),
            h('input', {
              className: 'qc-input', type: 'text', placeholder: t('proxyGlobal'),
              value: settings.proxy[id] || '', onChange: setProxy(id),
              'aria-label': (PROVIDERS[id] || { name: id }).name,
            })))),
        h('button', { className: 'qc-reset', type: 'button', onClick: reset }, t('restore')));
    }

    function ProviderRow({ row, now, t, settings }) {
      const provider = PROVIDERS[row.id] || { name: row.id, letter: '?', badge: '#8a8f98' };
      const tier = tierOf(row, settings);
      const tierClass = tier ? ' is-' + tier : '';
      const primary = primaryWindow(row);
      let value;
      let aux = null;
      let auxTier = '';
      let bar = null;

      if (row.status === 'ok' && row.kind === 'usage' && primary) {
        value = h('span', { className: 'qc-value' + tierClass }, t('remaining', { pct: primary.remaining }));
        const cd = countdownText(primary.resetsAt, now, t);
        if (cd) aux = t('resetShort', { cd });
        bar = h('div', { className: 'qc-bar' },
          h('span', { className: tier, style: { width: Math.min(Math.max(primary.remaining, 0), 100) + '%' } }));
      } else if (row.status === 'ok' && row.kind === 'balance' && Number.isFinite(row.amount)) {
        value = h('span', { className: 'qc-value' + tierClass }, formatMoney(row.amount));
        if (row.bonus) aux = t('bonusIncluded', { amount: Number(row.bonus).toFixed(2) });
      } else if (row.status === 'auth') {
        value = h('span', { className: 'qc-value is-muted' }, t('notLoggedIn'));
        aux = t('needLogin');
        auxTier = ' is-warn';
      } else if (row.status === 'setup') {
        value = h('span', { className: 'qc-value is-muted' }, t('unknown'));
        aux = t('setupShort');
        auxTier = ' is-warn';
      } else if (row.status === 'pending') {
        value = h('span', { className: 'qc-value is-muted' }, t('unknown'));
        aux = t('pendingShort');
      } else if (row.status === 'loading' || !row.status) {
        value = h('span', { className: 'qc-value is-muted' }, t('loading'));
      } else {
        value = h('span', { className: 'qc-value is-muted' }, t('unknown'));
        aux = t('failedShort');
        auxTier = ' is-error';
      }

      const usageWithBar = row.status === 'ok' && row.kind === 'usage' && primary !== null;

      return h('div', { className: 'qc-row', title: detailOf(row, now, t) },
        h('div', { className: 'qc-line' },
          h('span', {
            className: 'qc-badge',
            'aria-hidden': true,
            style: {
              background: provider.tile || '#8a8f98',
              color: provider.ink || '#fff',
              boxShadow: provider.light
                ? 'inset 0 0 0 .5px rgba(0,0,0,.16)'
                : 'inset 0 0 0 .5px rgba(255,255,255,.14)',
            },
          }, h(ProviderGlyph, { id: row.id })),
          h('span', { className: 'qc-name' }, provider.name),
          aux ? h('span', { className: 'qc-aux' + auxTier }, aux) : null,
          usageWithBar ? null : value),
        usageWithBar ? h('div', { className: 'qc-meter' }, bar, value) : null);
    }

    function skeletonRows() {
      return ORDER.map((id) => ({ id, kind: id === 'deepseek' ? 'balance' : 'usage', status: 'loading' }));
    }

    function QuotaCard({ wide, t, ctx }) {
      const [rows, setRows] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);
      const [loadError, setLoadError] = React.useState(null);
      const [settings, setSettings] = React.useState(readSettings);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const settingsRef = React.useRef(settings);
      settingsRef.current = settings;
      const rootRef = React.useRef(null);
      const mounted = React.useRef(true);
      const now = useNow(wide !== false);
      const showKey = JSON.stringify(settings.show);
      const proxyKey = JSON.stringify(settings.proxy) + '|' + settings.proxyGlobal;

      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      const update = React.useCallback((patch) => {
        setSettings((prev) => {
          const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
          writeSettings(next);
          return next;
        });
      }, []);

      const reset = React.useCallback(() => {
        const next = defaultSettings();
        writeSettings(next);
        setSettings(next);
      }, []);

      const load = React.useCallback((force) => {
        const current = settingsRef.current;
        const providers = ORDER.filter((id) => current.show[id]);
        const proxy = { global: current.proxyGlobal, ...current.proxy };
        setRefreshing(true);
        return ctx.connection.rpc.call(CHANNEL, 'fetch-all', { force: !!force, providers, proxy })
          .then((result) => {
            if (!mounted.current) return;
            if (result && result.ok === true && result.value && Array.isArray(result.value.rows)) {
              setRows(result.value.rows);
              setLoadError(null);
            } else {
              setLoadError(result?.error?.message || t('loadFailed'));
            }
          })
          .catch((error) => {
            if (mounted.current) setLoadError(String(error?.message || error));
          })
          .then(() => {
            if (mounted.current) setRefreshing(false);
          });
      }, [t]);

      React.useEffect(() => {
        const timer = setTimeout(() => { load(false); }, 350);
        return () => clearTimeout(timer);
      }, [load, showKey, proxyKey]);

      React.useEffect(() => {
        const timer = setInterval(() => { if (!document.hidden) load(false); }, settings.refreshMs);
        const onVisible = () => { if (!document.hidden) load(false); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [load, settings.refreshMs]);

      React.useEffect(() => {
        if (!settingsOpen) return undefined;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setSettingsOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setSettingsOpen(false); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [settingsOpen]);

      const failedRows = ORDER.map((id) => ({
        id,
        kind: id === 'deepseek' ? 'balance' : 'usage',
        status: 'error',
        error: { message: loadError || t('fetchFailed') },
      })).filter((row) => settings.show[row.id] !== false);
      const visibleRows = (rows || (loadError ? failedRows : skeletonRows()))
        .filter((row) => settings.show[row.id] !== false);

      if (wide === false) {
        if (visibleRows.length === 0) return null;
        return h('div', {
          className: 'qc-rail',
          role: 'group',
          'aria-label': t('railLabel'),
          title: visibleRows.map((row) => {
            const provider = PROVIDERS[row.id] || { name: row.id };
            return provider.name + ' · ' + detailOf(row, now, t).replace(/\n/g, ' ');
          }).join('\n'),
        },
          visibleRows.map((row) => {
            const tier = tierOf(row, settings);
            const cls = tier ? ' is-' + tier : (row.status === 'ok' ? '' : ' is-muted');
            return h('span', {
              key: row.id,
              className: 'qc-dot' + cls,
              title: (PROVIDERS[row.id] || { name: row.id }).name,
            });
          }));
      }

      return h('div', { className: 'qc-root', role: 'group', 'aria-label': t('cardLabel'), ref: rootRef },
        h('div', { className: 'qc-head' },
          h('span', { className: 'qc-title' }, t('title')),
          h('div', { className: 'qc-head-right' },
            loadError ? h('span', { className: 'qc-tag is-warn', title: loadError }, t('offline')) : null,
            h('button', {
              className: 'qc-refresh' + (settingsOpen ? ' is-on' : ''),
              type: 'button',
              'aria-label': t('settings'),
              'aria-expanded': settingsOpen ? 'true' : 'false',
              title: t('settings'),
              onClick: () => setSettingsOpen((value) => !value),
            }, h(GearGlyph)),
            h('button', {
              className: 'qc-refresh' + (refreshing ? ' is-busy' : ''),
              type: 'button',
              disabled: refreshing,
              'aria-label': t('refresh'),
              title: t('refresh'),
              onClick: () => load(true),
            }, h(RefreshGlyph)))),
        settingsOpen ? h(SettingsPanel, {
          settings,
          update,
          reset,
          onClose: () => setSettingsOpen(false),
          t,
        }) : null,
        visibleRows.length === 0
          ? h('div', { className: 'qc-empty' }, t('allHidden'))
          : visibleRows.map((row) => h(ProviderRow, { key: row.id, row, now, t, settings })));
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-quota-card', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.locale.register(NS, DICT);
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'quota-card',
          order: -10,
          locale: NS,
          label: () => t('cardLabel'),
        }, (props) => h(QuotaCard, { ...props, t, ctx })));
      },
    };
  },
});
