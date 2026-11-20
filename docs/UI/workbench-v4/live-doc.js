/* UI-CR048-v2：仅设计内存；逐对象缓冲/保存队列。正式软件应采用成熟结构化编辑器。 */
(function () {
  'use strict';
  const { esc, icon } = UI;
  const models = new Map();
  let serial = 0;
  const safe = text => window.RequirementsWorkspace ? RequirementsWorkspace.safeMarkdown(text) : UI.md(text);
  const inline = node => {
    if (node.nodeType === 3) return node.textContent;
    const text = Array.from(node.childNodes).map(inline).join('');
    const tag = node.nodeName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return '**' + text + '**';
    if (tag === 'em' || tag === 'i') return '*' + text + '*';
    if (tag === 'code') return '`' + text + '`';
    if (tag === 'a') return '[' + text + '](' + (node.dataset.url || node.getAttribute('href') || '') + ')';
    return text;
  };
  function fromDOM(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.classList?.contains('live-chunk')) return Array.from(node.childNodes).map(fromDOM).join('');
    const tag = node.nodeName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inline(node) + '\n\n';
    if (tag === 'p' || tag === 'div') return inline(node) + '\n\n';
    if (tag === 'pre') return '```' + (node.dataset.language || '') + '\n' + node.textContent + '\n```\n\n';
    if (tag === 'blockquote') return inline(node).split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    if (tag === 'ul' || tag === 'ol') return Array.from(node.children).map((li, i) => (tag === 'ol' ? (i + 1) + '. ' : '- ') + inline(li)).join('\n') + '\n\n';
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map(row => '| ' + Array.from(row.children).map(inline).join(' | ') + ' |');
      rows.splice(1, 0, '| ' + Array.from(node.querySelector('tr')?.children || []).map(() => '---').join(' | ') + ' |');
      return rows.join('\n') + '\n\n';
    }
    if (tag === 'hr') return '---\n\n';
    return inline(node) + '\n\n';
  }
  // 每块保留原始Markdown和分隔字节；未改块不全量重序列化，避免仅打开/失焦丢格式。
  function fill(m) {
    m.originals = new Map();
    m.leading = '';
    m.editor.innerHTML = '';
    const rows = m.text.match(/[^\n]*\n|[^\n]+$/g) || [];
    let i = 0;
    while (i < rows.length) {
      if (!rows[i].trim()) { m.leading += rows[i++]; continue; }
      const start = i;
      const fence = /^\s*(```+|~~~+)(.*)/.exec(rows[i]);
      if (fence) {
        i++;
        while (i < rows.length && !rows[i].trim().startsWith(fence[1])) i++;
        if (i < rows.length) i++;
      } else if (/^#{1,6}\s/.test(rows[i])) i++;
      else { i++; while (i < rows.length && rows[i].trim() && !/^#{1,6}\s/.test(rows[i])) i++; }
      while (i < rows.length && !rows[i].trim()) i++;
      const raw = rows.slice(start, i).join('');
      const template = document.createElement('template');
      template.innerHTML = safe(raw);
      // 未支持语法保源，明确不编辑，不假装已支持复杂MD往返。
      if (!template.content.children.length) template.innerHTML = '<p>' + esc(raw.trimEnd()) + '</p>';
      const chunk = document.createElement('div');
      chunk.className = 'live-chunk'; chunk.dataset.liveBlock = String(++serial);
      const urls = Array.from(raw.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g));
      template.content.querySelectorAll('a').forEach((a,n)=>{a.dataset.url=urls[n]?.[2]||'';a.removeAttribute('href');});
      if(fence)template.content.querySelector('pre')?.setAttribute('data-language',fence[2].trim());
      chunk.append(template.content); m.editor.append(chunk);
      m.originals.set(chunk.dataset.liveBlock,{html:chunk.innerHTML,tag:chunk.tagName,raw});
    }
    if (!m.editor.children.length) m.editor.innerHTML = '<p><br></p>';
    m.editor.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el, n) => { el.id = 'live-heading-' + n; });
    m.editor.querySelectorAll('[data-live-block]').forEach(el => { const old=m.originals.get(el.dataset.liveBlock); if(old)old.html=el.innerHTML; });
    m.html = m.editor.innerHTML;
  }
  function textOf(m) {
    if (m.source) return m.editor.value;
    // 全文未改时返回完全一致的源，不触发任何保存。
    if (m.editor.innerHTML === m.html) return m.text;
    const children = Array.from(m.editor.childNodes), seen = new Set();
    return m.leading + children.map(node => {
      const id = node.dataset?.liveBlock, original = m.originals.get(id);
      if (original && !seen.has(id) && original.html === node.innerHTML && original.tag === node.tagName) {
        seen.add(id); return original.raw;
      }
      return fromDOM(node);
    }).join('');
  }
  function update(m) {
    m.node.querySelector('[data-live-status]').textContent = m.state;
    m.node.querySelector('[data-live-error]').textContent = m.error || '';
    m.node.querySelector('[data-live-retry]').hidden = !['保存失败 · 内容已保留', '保存冲突 · 内容已保留'].includes(m.state);
    m.editor.setAttribute(m.source ? 'readonly' : 'contenteditable', m.source ? '' : String(!m.readOnly));
    if (m.source) m.editor.readOnly = m.readOnly;
    m.node.querySelector('[data-live-tools]').hidden = m.readOnly || m.source;
    m.node.dataset.saveState = m.state;
  }
  function schedule(m) {
    clearTimeout(m.timer);
    if (m.readOnly || m.composing) return;
    m.text = textOf(m);
    m.html = m.editor.innerHTML;
    // 不更新原始块基线：后续更改依然只替换真正变化的块。
    m.state = m.text === m.saved ? '已自动保存' : '自动保存待处理';
    m.onChange?.(m.text);
    update(m);
    m.timer = setTimeout(() => save(m), 900);
  }
  function save(m) {
    clearTimeout(m.timer);
    if (m.composing || m.readOnly || m.text === m.saved) return;
    m.state = '正在自动保存…'; update(m);
    const snapshot = m.text;
    const result = m.write(snapshot, m.saved) || { ok: true };
    if (!result.ok) {
      m.error = result.error || '写入失败，完整内容已保留。';
      m.state = result.conflict ? '保存冲突 · 内容已保留' : '保存失败 · 内容已保留';
      update(m); return;
    }
    m.saved = snapshot; m.error = ''; m.state = '已自动保存'; update(m);
    m.onSaved?.(snapshot);
  }
  function create(id, text, options) {
    const m = { id, text, saved: text, state: '已自动保存', error: '', timer: null, undo: [], redo: [], ...options };
    m.node = document.createElement('div'); m.node.className = 'live-doc-host'; m.node.dataset.liveId = id;
    m.node.innerHTML = `<div class="live-doc-bar"><div data-live-tools class="live-doc-tools" role="toolbar" aria-label="文档格式">${[['bold','加粗','B'],['italic','斜体','I'],['h1','一级标题','H1'],['h2','二级标题','H2'],['p','正文','正文'],['list','项目列表','列表'],['code','代码块','代码'],['link','插入链接','链接']].map(([act,label,txt]) => `<button type="button" data-live-command="${act}" aria-label="${label}" title="${label}">${txt}</button>`).join('')}<button type="button" data-live-command="undo" aria-label="撤销">撤销</button><button type="button" data-live-command="redo" aria-label="重做">重做</button></div><span data-live-status role="status" aria-live="polite"></span><button type="button" data-live-retry hidden>重试</button></div><div data-live-error class="live-doc-error" role="alert"></div>`;
    m.editor = document.createElement(m.source ? 'textarea' : 'article');
    m.editor.className = m.source ? 'live-code' : 'live-doc doc-body';
    m.editor.setAttribute('aria-label', m.source ? '代码编辑器' : '文档正文');
    m.editor.setAttribute('role','textbox'); m.editor.setAttribute('aria-multiline','true'); m.editor.spellcheck = false;
    m.node.append(m.editor);
    if (m.source) m.editor.value = text; else fill(m);
    m.editor.addEventListener('beforeinput', e => {
      if (m.readOnly) { e.preventDefault(); return; }
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') { m.undo.push(m.text); m.redo = []; }
    });
    m.editor.addEventListener('input', () => schedule(m));
    m.editor.addEventListener('compositionstart', () => { m.composing = true; clearTimeout(m.timer); });
    m.editor.addEventListener('compositionend', () => { m.composing = false; schedule(m); });
    m.editor.addEventListener('paste', e => { if (m.readOnly || m.source) return; e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
    m.editor.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); schedule(m); save(m); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(m, e.shiftKey ? 'redo' : 'undo'); }
    });
    m.node.addEventListener('focusout', e => { if (!m.node.contains(e.relatedTarget)) save(m); });
    m.node.querySelectorAll('[data-live-command]').forEach(button => {
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', () => {
        if (m.readOnly) return;
        const action = button.dataset.liveCommand;
        if (['undo','redo'].includes(action)) { history(m, action); return; }
        m.undo.push(m.text); m.redo = []; m.editor.focus();
        if (action === 'link') {
          const selection=getSelection(), range=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;
          const dialog=document.createElement('dialog');dialog.className='live-link-dialog';dialog.innerHTML='<form method="dialog"><label>链接地址<input name="url" placeholder="https://example.invalid" required></label><div><button value="cancel">取消</button><button value="insert">插入链接</button></div><p>仅写入文档，不打开或访问链接。</p></form>';
          document.body.append(dialog);dialog.addEventListener('close',()=>{if(dialog.returnValue==='insert'){const url=dialog.querySelector('input').value.trim();if(!/^https?:\/\//i.test(url)){m.error='链接只允许http/https，不执行脚本地址。';update(m);}else{m.editor.focus();if(range){selection.removeAllRanges();selection.addRange(range);}document.execCommand('insertHTML',false,'<a data-url="'+esc(url)+'">'+esc(range?.toString()||'链接')+'</a>');schedule(m);}}dialog.remove();});dialog.showModal();return;
        }
        if (action === 'bold' || action === 'italic') document.execCommand(action);
        else if (action === 'list') document.execCommand('insertUnorderedList');
        else document.execCommand('formatBlock', false, action === 'code' ? 'pre' : action);
        schedule(m);
      });
    });
    m.node.querySelector('[data-live-retry]').addEventListener('click', () => save(m));
    update(m); models.set(id, m); return m;
  }
  function history(m, direction) {
    if (m.readOnly) return;
    const from = direction === 'undo' ? m.undo : m.redo, to = direction === 'undo' ? m.redo : m.undo;
    if (!from.length) return;
    to.push(m.text); m.text = from.pop();
    if (m.source) m.editor.value = m.text; else fill(m);
    schedule(m);
  }
  function render(id, text, options = {}) {
    const m = models.get(id) || create(id, text, options);
    Object.assign(m, options); update(m);
    return `<div data-live-slot="${esc(id)}"></div>`;
  }
  function hydrate() {
    document.querySelectorAll('[data-live-slot]').forEach(slot => { const m = models.get(slot.dataset.liveSlot); if (m) slot.replaceWith(m.node); });
  }
  window.LiveDoc = { version:'UI-CR048-v2', render, hydrate, get:id => models.get(id), flush:() => models.forEach(save), save:id => { const m=models.get(id); if(m) save(m); }, remove:id=>{ const m=models.get(id); if(m) clearTimeout(m.timer); models.delete(id); } };
  new MutationObserver(hydrate).observe(document.getElementById('app'), { childList:true, subtree:true });
  document.addEventListener('click', e => {
    if (e.target.closest('[data-act]') && !e.target.closest('.live-doc-host')) LiveDoc.flush();
    if(e.target.closest('[data-act^="office-"]')&&window.Office){const pid=Office.activeId();if(pid)for(const id of Office.model.dirtyFiles(pid))Office.model.save(pid,id);}
  }, true);
  window.addEventListener('pagehide', () => LiveDoc.flush());
})();
