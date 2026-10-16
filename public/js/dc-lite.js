/* dc-lite – a small runtime that runs the ReGo screens (*.dc.html from the design) unchanged in the browser.
 * Supports exactly what the screens use: {{path}}, <sc-if value>, <sc-for list as>, onClick/onInput,
 * class Component extends DCLogic { constructor, state, setState, renderVals }. */
(function () {
  const EVENTS = ['onclick', 'oninput', 'onchange', 'onkeydown', 'onfocus', 'onblur'];
  const HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(p) {
      this.state = Object.assign({}, this.state, typeof p === 'function' ? p(this.state) : p);
      if (this.__mount) this.__mount.update();
    }
  }
  window.DCLogic = DCLogic;

  const lookup = (path, scope) => {
    if (path === 'true') return true;
    if (path === 'false') return false;
    let v = scope;
    for (const k of path.split('.')) { if (v == null) return undefined; v = v[k]; }
    return v;
  };
  const text = (s, scope) => s.replace(HOLE, (_, p) => { const v = lookup(p, scope); return v == null || v === false ? '' : String(v); });
  const exact = (s) => { const m = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/.exec(s); return m ? m[1] : null; };

  /** Template node + scope -> list of fresh DOM nodes */
  function build(node, scope, out) {
    if (node.nodeType === 3) { out.push(document.createTextNode(node.nodeValue.includes('{{') ? text(node.nodeValue, scope) : node.nodeValue)); return; }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'sc-if') {
      const v = lookup(exact(node.getAttribute('value') || '') || 'false', scope);
      if (v) for (const c of node.childNodes) build(c, scope, out);
      return;
    }
    if (tag === 'sc-for') {
      const list = lookup(exact(node.getAttribute('list') || '') || '', scope) || [];
      const as = node.getAttribute('as') || 'item';
      list.forEach((item, i) => { const s = Object.create(scope); s[as] = item; s.index = i; for (const c of node.childNodes) build(c, s, out); });
      return;
    }
    const el = node.cloneNode(false);
    for (const a of Array.from(node.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('hint-')) { el.removeAttribute(a.name); continue; }
      if (EVENTS.includes(n)) { el.removeAttribute(a.name); const f = lookup(exact(a.value) || '', scope); if (typeof f === 'function') el[n] = f; continue; }
      if (a.value.includes('{{')) { const e = exact(a.value); const v = e ? lookup(e, scope) : null; el.setAttribute(a.name, e ? (v == null ? '' : String(v)) : text(a.value, scope)); }
    }
    // The browser rewrites inline styles to rgb(...); the dark-mode CSS of the screens relies on that.
    if (el.hasAttribute('style')) el.setAttribute('style', el.style.cssText);
    const kids = [];
    for (const c of node.childNodes) build(c, scope, kids);
    for (const k of kids) el.appendChild(k);
    out.push(el);
  }

  /** Very small DOM diff: focus, cursor and scroll are kept. */
  function morph(live, next) {
    const a = Array.from(live.childNodes), b = Array.from(next.childNodes);
    for (let i = 0; i < b.length; i++) {
      const l = a[i], n = b[i];
      if (!l) { live.appendChild(n); continue; }
      if (l.nodeType !== n.nodeType || l.nodeName !== n.nodeName) { live.replaceChild(n, l); continue; }
      if (n.nodeType === 3) { if (l.nodeValue !== n.nodeValue) l.nodeValue = n.nodeValue; continue; }
      for (const at of Array.from(l.attributes)) if (!n.hasAttribute(at.name)) l.removeAttribute(at.name);
      for (const at of Array.from(n.attributes)) if (l.getAttribute(at.name) !== at.value) l.setAttribute(at.name, at.value);
      for (const ev of EVENTS) l[ev] = n[ev] || null;
      if (l.localName === 'input' && l.value !== n.getAttribute('value') && document.activeElement !== l) l.value = n.getAttribute('value') || '';
      morph(l, n);
    }
    for (let i = a.length - 1; i >= b.length; i--) live.removeChild(a[i]);
  }

  const cache = new Map();
  async function loadScreen(name) {
    if (cache.has(name)) return cache.get(name);
    const res = await fetch(`/screens/${name}.dc.html`);
    if (!res.ok) throw new Error(`Screen ${name} nicht gefunden`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const dc = doc.querySelector('x-dc');
    const helmet = dc.querySelector('helmet');
    const css = Array.from(helmet ? helmet.querySelectorAll('style') : []).map((s) => s.textContent).join('\n');
    if (helmet) helmet.remove();
    const code = doc.querySelector('script[data-dc-script]').textContent;
    const Component = new Function('DCLogic', `${code}\nreturn Component;`)(DCLogic);
    const s = { css, template: dc, Component };
    cache.set(name, s);
    return s;
  }

  /** Mount a screen into `host`. Returns { update, destroy, instance }. */
  async function mount(name, host, styleEl) {
    const screen = await loadScreen(name);
    styleEl.textContent = screen.css;
    const instance = new screen.Component({});
    let dead = false;                                    // after destroy() draw nothing anymore (otherwise a straggler overwrites the new page)
    const m = {
      instance,
      update() {
        if (dead) return;
        const vals = instance.renderVals();
        const out = [];
        for (const c of screen.template.childNodes) build(c, vals, out);
        const frag = document.createElement('div');
        for (const n of out) frag.appendChild(n);
        morph(host, frag);
      },
      destroy() { if (dead) return; dead = true; clearTimeout(instance._tm); try { if (typeof instance.onDestroy === 'function') instance.onDestroy(); } catch (e) {} instance.__mount = null; },
    };
    instance.__mount = m;
    host.textContent = '';
    m.update();
    return m;
  }

  window.DC = { mount };
})();
