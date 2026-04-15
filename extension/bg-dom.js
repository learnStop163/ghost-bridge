(function initGhostBridgeDomHelpers(global) {
  function buildInspectPageExpression({ selector, includeInteractive, maxElements }) {
    const selectorStr = selector ? JSON.stringify(selector) : 'null'

    return `(function() {
      try {
        if (document.readyState === 'loading') {
          return { error: '页面尚未加载完成，请稍后重试', readyState: document.readyState };
        }

        const includeInteractive = ${includeInteractive};
        const maxEls = ${maxElements};
        const selector = ${selectorStr};
        const result = {};
        let targetElement = document.body;

        function getMetadata() {
          return {
            title: document.title || '',
            url: window.location.href,
            description: document.querySelector('meta[name="description"]')?.content || '',
            keywords: document.querySelector('meta[name="keywords"]')?.content || '',
            charset: document.characterSet,
            language: document.documentElement.lang || '',
          };
        }

        function resolveTargetElement() {
          if (!selector) return document.body;
          try {
            const matched = document.querySelector(selector);
            if (!matched) {
              return { error: '选择器未匹配到任何元素', selector: selector, suggestion: '请检查选择器是否正确' };
            }
            result.selector = selector;
            result.matchedTag = matched.tagName.toLowerCase();
            return matched;
          } catch (e) {
            return { error: '无效的 CSS 选择器: ' + e.message, selector: selector };
          }
        }

        function buildStructuredContent(root) {
          const structured = {};
          const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
          structured.headings = Array.from(headings).slice(0, 50).map(h => ({
            level: parseInt(h.tagName[1]),
            text: h.innerText.trim().slice(0, 200)
          }));
          const links = root.querySelectorAll('a[href]');
          structured.links = Array.from(links).slice(0, 100).map(a => ({
            text: (a.innerText || '').trim().slice(0, 100),
            href: a.href
          })).filter(l => l.href && !l.href.startsWith('javascript:'));
          const buttons = root.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
          structured.buttons = Array.from(buttons).slice(0, 50).map(b => ({
            text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 100),
            type: b.type || 'button',
            disabled: b.disabled || false
          }));
          const forms = root.querySelectorAll('form');
          structured.forms = Array.from(forms).slice(0, 20).map(f => {
            const fields = Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 30);
            return {
              action: f.action || '',
              method: (f.method || 'GET').toUpperCase(),
              fieldCount: fields.length,
              fields: fields.map(field => ({
                tag: field.tagName.toLowerCase(),
                type: field.type || '',
                name: field.name || '',
                placeholder: field.placeholder || '',
                required: field.required || false
              }))
            };
          });
          const images = root.querySelectorAll('img');
          structured.images = Array.from(images).slice(0, 50).map(img => ({
            alt: img.alt || '',
            src: img.src ? img.src.slice(0, 200) : ''
          })).filter(img => img.src);
          const tables = root.querySelectorAll('table');
          structured.tables = Array.from(tables).slice(0, 10).map(table => {
            const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim().slice(0, 50));
            const rows = table.querySelectorAll('tr');
            return { headers: headers.slice(0, 20), rowCount: rows.length };
          });
          return structured;
        }

        function buildCounts(structured) {
          return {
            headings: structured.headings.length,
            links: structured.links.length,
            buttons: structured.buttons.length,
            forms: structured.forms.length,
            images: structured.images.length,
            tables: structured.tables.length
          };
        }

        function buildInteractiveSnapshot(root, includeText, maxEls) {
          let refCounter = 0;
          const elements = [];
          const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[onclick]';

          function isVisible(el) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return null;
            if (!el.offsetParent && el.tagName !== 'HTML' && el.tagName !== 'BODY' &&
                style.position !== 'fixed' && style.position !== 'sticky') return null;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null;
            return rect;
          }

          function buildEntry(el, rect) {
            refCounter++;
            const ref = 'e' + refCounter;
            el.setAttribute('data-ghost-ref', ref);
            const tag = el.tagName.toLowerCase();
            const entry = { ref, tag, cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2) };
            if (el.type) entry.type = el.type;
            if (el.name) entry.name = el.name;
            if (el.getAttribute('role')) entry.role = el.getAttribute('role');
            if (includeText) {
              if (el.placeholder) entry.placeholder = el.placeholder.slice(0, 80);
              if (el.value && tag !== 'textarea') entry.value = el.value.slice(0, 80);
              if (tag === 'a') entry.href = (el.href || '').slice(0, 150);
              if (tag === 'select') {
                entry.options = Array.from(el.options).slice(0, 10).map(o => ({
                  value: o.value, text: o.text.slice(0, 50), selected: o.selected
                }));
              }
              const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
              if (text && text.length <= 100) entry.text = text;
              else if (text) entry.text = text.slice(0, 97) + '...';
            }
            if (el.disabled) entry.disabled = true;
            return entry;
          }

          function scanRoot(scanTarget) {
            const candidates = scanTarget.querySelectorAll(INTERACTIVE_SELECTOR);
            for (let i = 0; i < candidates.length && elements.length < maxEls; i++) {
              const rect = isVisible(candidates[i]);
              if (rect) elements.push(buildEntry(candidates[i], rect));
            }
            if (elements.length < maxEls) {
              const all = scanTarget.querySelectorAll('*');
              for (let i = 0; i < all.length && elements.length < maxEls; i++) {
                const el = all[i];
                if (el.shadowRoot) scanRoot(el.shadowRoot);
                if (el.onclick && !el.hasAttribute('data-ghost-ref')) {
                  const rect = isVisible(el);
                  if (rect) elements.push(buildEntry(el, rect));
                }
              }
            }
          }

          document.querySelectorAll('[data-ghost-ref]').forEach(el => el.removeAttribute('data-ghost-ref'));
          scanRoot(root);

          return {
            url: window.location.href,
            title: document.title,
            elementCount: elements.length,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: Math.round(window.scrollX),
              scrollY: Math.round(window.scrollY),
            },
            elements
          };
        }

        targetElement = resolveTargetElement();
        if (targetElement?.error) return targetElement;

        result.metadata = getMetadata();
        const structured = buildStructuredContent(targetElement);

        result.page = {
          metadata: result.metadata,
          ...(result.selector ? { selector: result.selector, matchedTag: result.matchedTag } : {}),
          structured,
          counts: buildCounts(structured),
          mode: 'structured'
        };

        if (!includeInteractive) {
          result.interactive = null;
          return result;
        }

        result.interactive = buildInteractiveSnapshot(targetElement, true, maxEls);
        return result;
      } catch (e) {
        return { error: e.message };
      }
    })()`
  }

  function buildPageContentExpression({ mode, selector, maxLength, includeMetadata }) {
    const selectorStr = selector ? JSON.stringify(selector) : 'null'
    const modeStr = JSON.stringify(mode)

    return `(function() {
      try {
        const result = {};
        if (document.readyState === 'loading') {
          return { error: '页面尚未加载完成，请稍后重试', readyState: document.readyState };
        }

        const selector = ${selectorStr};
        const mode = ${modeStr};
        const maxLength = ${maxLength};
        const includeMetadata = ${includeMetadata};

        function getMetadata() {
          return {
            title: document.title || '',
            url: window.location.href,
            description: document.querySelector('meta[name="description"]')?.content || '',
            keywords: document.querySelector('meta[name="keywords"]')?.content || '',
            charset: document.characterSet,
            language: document.documentElement.lang || '',
          };
        }

        function resolveTargetElement() {
          if (!selector) return document.body;
          try {
            const matched = document.querySelector(selector);
            if (!matched) {
              return { error: '选择器未匹配到任何元素', selector: selector, suggestion: '请检查选择器是否正确' };
            }
            result.selector = selector;
            result.matchedTag = matched.tagName.toLowerCase();
            return matched;
          } catch (e) {
            return { error: '无效的 CSS 选择器: ' + e.message, selector: selector };
          }
        }

        function buildStructuredContent(root) {
          const structured = {};
          const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
          structured.headings = Array.from(headings).slice(0, 50).map(h => ({ level: parseInt(h.tagName[1]), text: h.innerText.trim().slice(0, 200) }));
          const links = root.querySelectorAll('a[href]');
          structured.links = Array.from(links).slice(0, 100).map(a => ({ text: (a.innerText || '').trim().slice(0, 100), href: a.href })).filter(l => l.href && !l.href.startsWith('javascript:'));
          const buttons = root.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
          structured.buttons = Array.from(buttons).slice(0, 50).map(b => ({ text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 100), type: b.type || 'button', disabled: b.disabled || false }));
          const forms = root.querySelectorAll('form');
          structured.forms = Array.from(forms).slice(0, 20).map(f => {
            const fields = Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 30);
            return { action: f.action || '', method: (f.method || 'GET').toUpperCase(), fieldCount: fields.length, fields: fields.map(field => ({ tag: field.tagName.toLowerCase(), type: field.type || '', name: field.name || '', placeholder: field.placeholder || '', required: field.required || false })) };
          });
          const images = root.querySelectorAll('img');
          structured.images = Array.from(images).slice(0, 50).map(img => ({ alt: img.alt || '', src: img.src ? img.src.slice(0, 200) : '' })).filter(img => img.src);
          const tables = root.querySelectorAll('table');
          structured.tables = Array.from(tables).slice(0, 10).map(table => {
            const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim().slice(0, 50));
            const rows = table.querySelectorAll('tr');
            return { headers: headers.slice(0, 20), rowCount: rows.length };
          });
          return structured;
        }

        function smartTruncateText(text, limit) {
          if (text.length <= limit) {
            return { content: text, truncated: false };
          }

          if (limit < 400) {
            return { content: text.slice(0, limit), truncated: true, note: '内容过长，已截断' };
          }

          const headLength = Math.max(200, Math.floor(limit * 0.8));
          const tailLength = Math.max(120, limit - headLength - 80);
          const head = text.slice(0, headLength).trimEnd();
          const tail = text.slice(-tailLength).trimStart();
          const omittedChars = Math.max(0, text.length - head.length - tail.length);

          return {
            content: head + '\\n\\n... [已省略 ' + omittedChars + ' 个字符] ...\\n\\n' + tail,
            truncated: true,
            note: '内容过长，已保留开头与结尾片段'
          };
        }

        const targetElement = resolveTargetElement();
        if (targetElement?.error) return targetElement;

        if (includeMetadata) {
          result.metadata = getMetadata();
        }

        if (mode === 'text') {
          let text = targetElement.innerText || targetElement.textContent || '';
          text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
          result.contentLength = text.length;
          const truncated = smartTruncateText(text, maxLength);
          result.content = truncated.content;
          result.truncated = truncated.truncated;
          if (truncated.note) result.note = truncated.note;
        } else if (mode === 'html') {
          let html = targetElement.outerHTML || '';
          result.contentLength = html.length;
          if (html.length > maxLength) {
            result.content = html.slice(0, maxLength);
            result.truncated = true;
            result.note = 'HTML 已截断，可能不完整';
          } else {
            result.content = html;
            result.truncated = false;
          }
        } else if (mode === 'structured') {
          const structured = buildStructuredContent(targetElement);
          result.structured = structured;
          result.counts = {
            headings: structured.headings.length,
            links: structured.links.length,
            buttons: structured.buttons.length,
            forms: structured.forms.length,
            images: structured.images.length,
            tables: structured.tables.length
          };
        }

        result.mode = mode;
        return result;
      } catch (e) {
        return { error: e.message };
      }
    })()`
  }

  function buildInteractiveSnapshotExpression({ selector, includeText, maxElements }) {
    const selectorStr = selector ? JSON.stringify(selector) : 'null'

    return `(function() {
      try {
        let refCounter = 0;
        const elements = [];
        const maxEls = ${maxElements};
        const includeText = ${includeText};
        const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[onclick]';

        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return null;
          if (!el.offsetParent && el.tagName !== 'HTML' && el.tagName !== 'BODY' &&
              style.position !== 'fixed' && style.position !== 'sticky') return null;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return null;
          return rect;
        }

        function buildEntry(el, rect) {
          refCounter++;
          const ref = 'e' + refCounter;
          el.setAttribute('data-ghost-ref', ref);
          const tag = el.tagName.toLowerCase();
          const entry = { ref, tag, cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2) };
          if (el.type) entry.type = el.type;
          if (el.name) entry.name = el.name;
          if (el.getAttribute('role')) entry.role = el.getAttribute('role');
          if (includeText) {
            if (el.placeholder) entry.placeholder = el.placeholder.slice(0, 80);
            if (el.value && tag !== 'textarea') entry.value = el.value.slice(0, 80);
            if (tag === 'a') entry.href = (el.href || '').slice(0, 150);
            if (tag === 'select') {
              entry.options = Array.from(el.options).slice(0, 10).map(o => ({
                value: o.value, text: o.text.slice(0, 50), selected: o.selected
              }));
            }
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
            if (text && text.length <= 100) entry.text = text;
            else if (text) entry.text = text.slice(0, 97) + '...';
          }
          if (el.disabled) entry.disabled = true;
          return entry;
        }

        function scanRoot(root) {
          const candidates = root.querySelectorAll(INTERACTIVE_SELECTOR);
          for (let i = 0; i < candidates.length && elements.length < maxEls; i++) {
            const rect = isVisible(candidates[i]);
            if (rect) elements.push(buildEntry(candidates[i], rect));
          }
          if (elements.length < maxEls) {
            const all = root.querySelectorAll('*');
            for (let i = 0; i < all.length && elements.length < maxEls; i++) {
              const el = all[i];
              if (el.shadowRoot) scanRoot(el.shadowRoot);
              if (el.onclick && !el.hasAttribute('data-ghost-ref')) {
                const rect = isVisible(el);
                if (rect) elements.push(buildEntry(el, rect));
              }
            }
          }
        }

        document.querySelectorAll('[data-ghost-ref]').forEach(el => el.removeAttribute('data-ghost-ref'));

        let rootEl = document.body;
        const sel = ${selectorStr};
        if (sel) {
          rootEl = document.querySelector(sel);
          if (!rootEl) return { error: '选择器未匹配到任何元素', selector: sel };
        }

        scanRoot(rootEl);

        return {
          url: window.location.href,
          title: document.title,
          elementCount: elements.length,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: Math.round(window.scrollX),
            scrollY: Math.round(window.scrollY),
          },
          elements
        };
      } catch (e) {
        return { error: e.message };
      }
    })()`
  }

  global.GhostBridgeDom = {
    buildInspectPageExpression,
    buildPageContentExpression,
    buildInteractiveSnapshotExpression,
  }
})(self)
