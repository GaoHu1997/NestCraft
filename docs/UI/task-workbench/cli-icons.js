/* 本地CLI品牌标识资源；来源与MIT归属见assets/cli/NOTICE.md。无网络加载。 */
(function (root) {
  'use strict';
  const base = typeof document !== 'undefined' && document.currentScript ? new URL('.', document.currentScript.src).href : '';
  const names = Object.freeze({ codex: 'Codex CLI', claude: 'Claude CLI', grok: 'Grok CLI' });
  function key(cli) {
    const value = String(cli || '').toLowerCase();
    return ({ 'codex-cli': 'codex', 'claude-code': 'claude', 'claude-cli': 'claude', 'grok-cli': 'grok' })[value] || value;
  }
  function escape(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function label(cli) { return names[key(cli)] || '未知CLI'; }
  function render(cli, options = {}) {
    const normalized = key(cli), name = label(cli), size = Number.isInteger(options.size) ? Math.max(12, Math.min(48, options.size)) : 24;
    const className = String(options.className || '').replace(/[^a-zA-Z0-9_\- ]/g, '');
    const content = names[normalized] ? `<img src="${escape(base + 'assets/cli/' + normalized + '.svg')}" alt="" width="${size}" height="${size}" decoding="async">` : '<span aria-hidden="true">?</span>';
    return `<span class="cli-icon ${className}" data-cli="${escape(names[normalized] ? normalized : 'unknown')}" role="img" aria-label="${escape(name)}" title="${escape(name)}" style="width:${size}px;height:${size}px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${content}</span>`;
  }
  root.WorkbenchCliIcons = Object.freeze({ render, label, key });
})(typeof globalThis !== 'undefined' ? globalThis : this);
