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

          function clearRefs(scanTarget) {
            const all = scanTarget.querySelectorAll('*');
            for (const el of all) {
              if (el.hasAttribute('data-ghost-ref')) el.removeAttribute('data-ghost-ref');
              if (el.shadowRoot) clearRefs(el.shadowRoot);
            }
          }

          clearRefs(document);
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

        const frameNodes = targetElement.querySelectorAll('iframe');
        result.frames = Array.from(frameNodes).slice(0, 3).map((frame, index) => {
          let readable = 'in-page';
          // A source is only a bridge candidate; target availability is not known here.
          try {
            if (!frame.contentDocument) readable = frame.src ? 'via-bridge' : 'no';
          } catch (_) { readable = frame.src ? 'via-bridge' : 'no'; }
          return { index, title: (frame.getAttribute('title') || '').slice(0, 80), readable };
        });
        result.iframeCount = frameNodes.length;
        result.framesOmitted = Math.max(0, frameNodes.length - result.frames.length);
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

  // Both reads use one page evaluation; a text failure does not discard the summary.
  function buildInspectWithTextExpression(options) {
    const inspect = buildInspectPageExpression(options)
    if (!options.includeText) return inspect
    const text = buildPageContentExpression({ mode: 'text', selector: options.selector,
      maxLength: options.textMaxLength, offset: 0, includeMetadata: false })
    return `(()=>{const snapshot=${inspect};if(!snapshot.error)snapshot.text=${text};return snapshot;})()`
  }

  function buildPageContentExpression({ mode, selector, maxLength, offset = 0, includeMetadata }) {
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
        const offset = ${offset};
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

        const targetElement = resolveTargetElement();
        if (targetElement?.error) return targetElement;

        if (includeMetadata) {
          result.metadata = getMetadata();
        }

        if (mode === 'text') {
          // 递归收集同源 iframe 内的文本：跨域 iframe 访问 contentDocument 会抛错，跳过即可。
          // 大量文档类页面（钉钉文档、italent 等）正文都在 iframe 里，不递归会拿到空文本，
          // 迫使模型退化为整页截图读文档——那是长会话里最昂贵的 token 开销
          function collectText(el) {
            const collected = {
              text: el.innerText || el.textContent || '',
              iframeCount: 0,
              readableIframeCount: 0,
              crossOriginSkipped: 0
            };
            try {
              var frames = el.querySelectorAll('iframe');
              for (var i = 0; i < frames.length; i++) {
                collected.iframeCount++;
                try {
                  var doc = frames[i].contentDocument;
                  if (doc && doc.body) {
                    const nested = collectText(doc.body);
                    collected.readableIframeCount++;
                    collected.text += '\\n\\n' + nested.text;
                    collected.iframeCount += nested.iframeCount;
                    collected.readableIframeCount += nested.readableIframeCount;
                    collected.crossOriginSkipped += nested.crossOriginSkipped;
                  } else {
                    collected.crossOriginSkipped++;
                  }
                } catch (e) {
                  collected.crossOriginSkipped++;
                }
              }
            } catch (e) {}
            return collected;
          }
          const collected = collectText(targetElement);
          let text = collected.text;
          text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
          result.contentLength = text.length;
          result.iframeCount = collected.iframeCount;
          result.readableIframeCount = collected.readableIframeCount;
          result.crossOriginSkipped = collected.crossOriginSkipped;
          result.includesIframes = collected.readableIframeCount > 0;
          result.offset = offset;
          result.content = text.slice(offset, offset + maxLength);
          result.truncated = offset > 0 || text.length > offset + maxLength;
          result.hasMore = text.length > offset + maxLength;
        } else if (mode === 'html') {
          let html = targetElement.outerHTML || '';
          result.contentLength = html.length;
          result.offset = offset;
          result.content = html.slice(offset, offset + maxLength);
          result.truncated = offset > 0 || html.length > offset + maxLength;
          result.hasMore = html.length > offset + maxLength;
          if (result.truncated) result.note = 'HTML 分页片段可能不是完整标签';
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

        function clearRefs(scanTarget) {
          const all = scanTarget.querySelectorAll('*');
          for (const el of all) {
            if (el.hasAttribute('data-ghost-ref')) el.removeAttribute('data-ghost-ref');
            if (el.shadowRoot) clearRefs(el.shadowRoot);
          }
        }

        clearRefs(document);

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

  // This runtime is serialized into Runtime.evaluate expressions. Keep it self-contained:
  // it intentionally depends only on the supplied page window and standard DOM APIs.
  function createLocatorRuntime(rootWindow) {
    const STORE_KEY = '__ghostActionElements'

    function normalize(value) {
      return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    }

    function matches(actual, expected, mode) {
      const left = normalize(actual)
      const right = normalize(expected)
      if (!right) return false
      return mode === 'contains' ? left.includes(right) : left === right
    }

    function elementWindow(element) {
      return element?.ownerDocument?.defaultView || rootWindow
    }

    function styleOf(element) {
      try {
        return elementWindow(element).getComputedStyle(element)
      } catch (_) {
        return null
      }
    }

    function isVisible(element) {
      if (!element || element.isConnected === false || element.hidden) return false
      if (element.getAttribute?.('aria-hidden') === 'true') return false
      const style = styleOf(element)
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false
      const rect = element.getBoundingClientRect?.()
      return Boolean(rect && (rect.width > 0 || rect.height > 0))
    }

    function isDisabled(element) {
      if (!element) return true
      if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') return true
      try {
        return Boolean(element.closest?.('fieldset[disabled]'))
      } catch (_) {
        return false
      }
    }

    function elementText(element) {
      return normalize(element?.innerText || element?.textContent || '')
    }

    function rootById(element, id) {
      const root = element?.getRootNode?.()
      if (root?.getElementById) return root.getElementById(id)
      if (root?.querySelector) {
        try {
          return root.querySelector(`[id="${String(id).replace(/["\\]/g, '\\$&')}"]`)
        } catch (_) {}
      }
      return element?.ownerDocument?.getElementById?.(id) || null
    }

    function labelText(element) {
      const parts = []
      try {
        if (element.labels) {
          for (const label of element.labels) parts.push(elementText(label))
        }
      } catch (_) {}
      if (!parts.length) {
        const wrapped = element.closest?.('label')
        if (wrapped) parts.push(elementText(wrapped))
      }
      if (!parts.length && element.id && element.ownerDocument?.querySelectorAll) {
        try {
          for (const label of element.ownerDocument.querySelectorAll('label')) {
            if (label.htmlFor === element.id || label.getAttribute?.('for') === element.id) parts.push(elementText(label))
          }
        } catch (_) {}
      }
      return normalize(parts.filter(Boolean).join(' '))
    }

    function accessibleName(element) {
      const ariaLabel = normalize(element.getAttribute?.('aria-label'))
      if (ariaLabel) return ariaLabel

      const labelledBy = normalize(element.getAttribute?.('aria-labelledby'))
      if (labelledBy) {
        const text = labelledBy.split(' ').map((id) => elementText(rootById(element, id))).filter(Boolean).join(' ')
        if (text) return normalize(text)
      }

      const label = labelText(element)
      if (label) return label
      const alt = normalize(element.getAttribute?.('alt'))
      if (alt) return alt
      const tag = String(element.tagName || '').toLowerCase()
      const type = String(element.type || '').toLowerCase()
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
        const value = normalize(element.value)
        if (value) return value
      }
      return elementText(element)
    }

    function implicitRole(element) {
      const explicit = normalize(element.getAttribute?.('role')).toLowerCase()
      if (explicit) return explicit.split(' ')[0]
      const tag = String(element.tagName || '').toLowerCase()
      const type = String(element.type || '').toLowerCase()
      if (tag === 'button') return 'button'
      if (tag === 'a' && element.getAttribute?.('href')) return 'link'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'select') return element.multiple ? 'listbox' : 'combobox'
      if (tag === 'img') return 'img'
      if (/^h[1-6]$/.test(tag)) return 'heading'
      if (tag === 'input') {
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'range') return 'slider'
        if (type === 'number') return 'spinbutton'
        if (!['hidden', 'color', 'file'].includes(type)) return type === 'search' ? 'searchbox' : 'textbox'
      }
      return ''
    }

    function collectContexts() {
      const contexts = []
      const seenRoots = new Set()

      function visit(root, frames) {
        if (!root || seenRoots.has(root)) return
        seenRoots.add(root)
        contexts.push({ root, frames })
        let elements = []
        try { elements = Array.from(root.querySelectorAll('*')) } catch (_) {}
        for (const element of elements) {
          if (element.shadowRoot) visit(element.shadowRoot, frames)
          if (String(element.tagName || '').toLowerCase() === 'iframe') {
            try {
              const frameDocument = element.contentDocument
              if (frameDocument?.documentElement) visit(frameDocument, frames.concat(element))
            } catch (_) {}
          }
        }
      }

      visit(rootWindow.document, [])
      return contexts
    }

    function semanticMatch(element, locator, mode) {
      if (locator.testId !== undefined && !matches(element.getAttribute?.('data-testid'), locator.testId, mode)) return false
      if (locator.role !== undefined && normalize(implicitRole(element)).toLowerCase() !== normalize(locator.role).toLowerCase()) return false
      if (locator.name !== undefined && !matches(accessibleName(element), locator.name, mode)) return false
      if (locator.label !== undefined) {
        const tag = String(element.tagName || '').toLowerCase()
        if (!['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(tag)) return false
        if (!matches(labelText(element) || accessibleName(element), locator.label, mode)) return false
      }
      if (locator.placeholder !== undefined && !matches(element.getAttribute?.('placeholder') || element.placeholder, locator.placeholder, mode)) return false
      if (locator.text !== undefined) {
        if (!matches(elementText(element), locator.text, mode)) return false
        try {
          const childMatches = Array.from(element.querySelectorAll('*')).some((child) => matches(elementText(child), locator.text, mode))
          if (childMatches) return false
        } catch (_) {}
      }
      return true
    }

    function find(locator = {}, { visibleOnly = false } = {}) {
      if (!locator || typeof locator !== 'object') return { error: 'locator 必须是对象' }
      const keys = ['css', 'testId', 'role', 'name', 'label', 'placeholder', 'text']
      if (!keys.some((key) => locator[key] !== undefined && locator[key] !== '')) {
        return { error: 'locator 至少需要 css/testId/role/name/label/placeholder/text 之一' }
      }
      if (locator.match && !['exact', 'contains'].includes(locator.match)) return { error: 'locator.match 仅支持 exact 或 contains' }
      if (locator.nth !== undefined && (!Number.isInteger(locator.nth) || locator.nth < 0)) return { error: 'locator.nth 必须是从 0 开始的整数' }

      const mode = locator.match || 'exact'
      const found = []
      const seen = new Set()
      for (const context of collectContexts()) {
        let elements = []
        try {
          elements = Array.from(context.root.querySelectorAll(locator.css || '*'))
        } catch (error) {
          return { error: `无效的 CSS 选择器: ${error.message}` }
        }
        for (const element of elements) {
          if (seen.has(element)) continue
          seen.add(element)
          if (!semanticMatch(element, locator, mode)) continue
          if (visibleOnly && !isVisible(element)) continue
          found.push({ element, frames: context.frames })
        }
      }
      return { found }
    }

    function summary(item, index) {
      const element = item.element
      const result = {
        nth: index,
        tag: String(element.tagName || '').toLowerCase(),
        role: implicitRole(element) || undefined,
        name: accessibleName(element).slice(0, 100) || undefined,
        text: elementText(element).slice(0, 100) || undefined,
        placeholder: normalize(element.getAttribute?.('placeholder') || element.placeholder).slice(0, 80) || undefined,
        testId: normalize(element.getAttribute?.('data-testid')).slice(0, 80) || undefined,
        disabled: isDisabled(element) || undefined,
      }
      return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== ''))
    }

    function selectOne(locator, options) {
      const result = find(locator, options)
      if (result.error) return result
      const matches = result.found
      if (!matches.length) return { error: 'locator 未匹配到元素', locator }
      if (locator.nth !== undefined) {
        if (!matches[locator.nth]) return { error: `locator.nth=${locator.nth} 超出匹配范围（共 ${matches.length} 个）`, locator }
        return { selected: matches[locator.nth], count: matches.length }
      }
      if (matches.length > 1) {
        return {
          error: `locator 匹配到 ${matches.length} 个元素，请增加条件或指定 nth`,
          ambiguous: true,
          matchCount: matches.length,
          candidates: matches.slice(0, 5).map(summary),
        }
      }
      return { selected: matches[0], count: 1 }
    }

    function scrollAndMeasure(item) {
      for (const frame of item.frames) frame.scrollIntoView?.({ block: 'center', inline: 'center' })
      item.element.scrollIntoView?.({ block: 'center', inline: 'center' })
      const rect = item.element.getBoundingClientRect()
      let left = rect.left
      let top = rect.top
      for (const frame of item.frames) {
        const frameRect = frame.getBoundingClientRect()
        left += frameRect.left + (frame.clientLeft || 0)
        top += frameRect.top + (frame.clientTop || 0)
      }
      return {
        cx: Math.round(left + rect.width / 2),
        cy: Math.round(top + rect.height / 2),
      }
    }

    function locate(locator, actionId) {
      const result = selectOne(locator, { visibleOnly: true })
      if (result.error) return result
      const item = result.selected
      const position = scrollAndMeasure(item)
      if (!isVisible(item.element)) return { error: '元素滚动后仍不可见', locator }
      if (!rootWindow[STORE_KEY]) rootWindow[STORE_KEY] = Object.create(null)
      rootWindow[STORE_KEY][actionId] = item
      return {
        found: true,
        ...summary(item, locator.nth || 0),
        ...position,
        matchCount: result.count,
      }
    }

    function probe(locator, state) {
      const result = find(locator, { visibleOnly: false })
      if (result.error) return result
      const all = result.found
      const selected = locator.nth === undefined ? all : (all[locator.nth] ? [all[locator.nth]] : [])
      const visible = selected.filter((item) => isVisible(item.element))
      const enabled = visible.filter((item) => !isDisabled(item.element))
      let satisfied = false
      if (state === 'attached') satisfied = selected.length > 0
      else if (state === 'detached') satisfied = selected.length === 0
      else if (state === 'hidden') satisfied = visible.length === 0
      else if (state === 'enabled') satisfied = enabled.length > 0
      else satisfied = visible.length > 0
      return {
        satisfied,
        state,
        matchCount: all.length,
        visibleCount: visible.length,
        enabledCount: enabled.length,
        candidates: satisfied ? undefined : all.slice(0, 3).map(summary),
      }
    }

    function use(actionId, command, payload = {}) {
      const store = rootWindow[STORE_KEY]
      const item = store?.[actionId]
      const element = item?.element
      if (!element || element.isConnected === false) return { error: '动作执行前元素已从页面移除' }
      if (command === 'focus') element.focus?.()
      else if (command === 'prepareFill') {
        element.focus?.()
        element.select?.()
      } else if (command === 'dispatchInput') {
        element.dispatchEvent(new (elementWindow(element).Event)('input', { bubbles: true }))
        element.dispatchEvent(new (elementWindow(element).Event)('change', { bubbles: true }))
      } else if (command === 'select') {
        if (String(element.tagName || '').toLowerCase() !== 'select') return { error: 'select 动作只能用于 <select> 元素' }
        const values = Array.from(element.options || []).map((option) => String(option.value))
        if (!values.includes(String(payload.value))) return { error: `下拉框不存在值 "${String(payload.value)}"` }
        element.value = String(payload.value)
        element.dispatchEvent(new (elementWindow(element).Event)('input', { bubbles: true }))
        element.dispatchEvent(new (elementWindow(element).Event)('change', { bubbles: true }))
      }
      return { success: true }
    }

    function cleanup(actionId) {
      if (rootWindow[STORE_KEY]) delete rootWindow[STORE_KEY][actionId]
      return true
    }

    return { version: 1, locate, probe, use, cleanup }
  }

  const locatorRuntimeSource = () => `(${createLocatorRuntime.toString()})(window)`

  function buildInstallLocatorRuntimeExpression() {
    return `(function(){window.__ghostLocatorRuntime=${locatorRuntimeSource()};return true;})()`
  }

  function buildLocateElementExpression({ locator, ref, selector, actionId }) {
    const semanticLocator = locator || { css: ref ? `[data-ghost-ref="${String(ref).replace(/["\\]/g, '\\$&')}"]` : String(selector || '') }
    return `(function(){try{return window.__ghostLocatorRuntime.locate(${JSON.stringify(semanticLocator)},${JSON.stringify(actionId)});}catch(e){return {error:e.message};}})()`
  }

  function buildElementCommandExpression({ actionId, command, payload }) {
    return `(function(){try{return window.__ghostLocatorRuntime.use(${JSON.stringify(actionId)},${JSON.stringify(command)},${JSON.stringify(payload || {})});}catch(e){return {error:e.message};}})()`
  }

  function buildCleanupElementExpression(actionId) {
    return `(function(){return window.__ghostLocatorRuntime ? window.__ghostLocatorRuntime.cleanup(${JSON.stringify(actionId)}) : true;})()`
  }

  function buildLocatorProbeExpression({ locator, state }) {
    return `(function(){try{return window.__ghostLocatorRuntime.probe(${JSON.stringify(locator)},${JSON.stringify(state)});}catch(e){return {error:e.message};}})()`
  }

  global.GhostBridgeDom = {
    buildInspectPageExpression,
    buildInspectWithTextExpression,
    buildPageContentExpression,
    buildInteractiveSnapshotExpression,
    buildInstallLocatorRuntimeExpression,
    buildLocateElementExpression,
    buildElementCommandExpression,
    buildCleanupElementExpression,
    buildLocatorProbeExpression,
    createLocatorRuntime,
  }
})(self)
