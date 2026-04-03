/**
 * KaiOS WebActivity Tester
 * ════════════════════════
 * index.html এ যোগ করো:
 *   <script src="activity-tester.js"></script>
 *
 * sw.js এ message bridge যোগ করো:
 *   self.addEventListener('message', e => {
 *     if (e.data.type !== 'activity') return;
 *     const { name, payload, port } = e.data;
 *     // তোমার handler logic এখানে
 *     port.postMessage({ type: 'activity-result', result: { ok: true } });
 *     // অথবা error:
 *     port.postMessage({ type: 'activity-error', error: 'কারণ' });
 *   });
 */
(function (G) {
  'use strict';

  /* ─── internal state ─── */
  const _pending   = new Map();
  const _callbacks = new Map();
  const _handlers  = new Map();
  let   _seq = 0, _ui = null;

  function _id() { return 'act-' + (++_seq) + '-' + Math.random().toString(36).slice(2,6); }
  function _str(v) { try { return v === undefined ? '' : JSON.stringify(v); } catch { return String(v); } }

  /* ─── filter engine (KaiOS ActivitiesServiceFilter port) ─── */
  function _mv(v, f, o) {
    if (f !== null && f !== undefined) {
      if (typeof f === 'boolean') return v === f;
      if (typeof f === 'number')  return Number(v) === f;
      if (typeof f === 'string')  return f.endsWith('/*') ? String(v).startsWith(f.slice(0,-1)) : String(v) === f;
      return false;
    }
    if (o && 'pattern' in o) return new RegExp('^(?:'+o.pattern+')$', o.patternFlags||'').test(v);
    if (o && ('min' in o || 'max' in o)) {
      if ('min' in o && o.min > v) return false;
      if ('max' in o && o.max < v) return false;
    }
    return true;
  }
  function _mo(val, fObj) {
    const vs = Array.isArray(val) ? val : [val];
    const fs = 'value' in fObj ? (Array.isArray(fObj.value) ? fObj.value : [fObj.value]) : [null];
    for (const f of fs) for (const v of vs) if (_mv(v,f,fObj)) return true;
    return false;
  }
  function _fm(data, filters) {
    if (!filters) return true;
    const map = new Map();
    for (const k in filters) {
      let f = filters[k];
      if (Array.isArray(f) || typeof f !== 'object') f = { required:false, value:f };
      map.set(k, { filter:f, found:false });
    }
    for (const p in data) {
      if (!map.has(p)) continue;
      const v = data[p];
      if (Array.isArray(v) && !v.length) continue;
      if (!_mo(v, map.get(p).filter)) return false;
      map.get(p).found = true;
    }
    for (const e of map.values()) if (e.filter.required && !e.found) return false;
    return true;
  }
  function _findH(opts) {
    return (_handlers.get(opts.name)||[]).filter(h => _fm(opts.data, (h.description||{}).filters));
  }

  /* ─── WebActivityRequestHandler ─── */
  class WebActivityRequestHandler {
    #id; #done = false;
    constructor(id, opts) { this.#id = id; this.source = { name: opts.name, data: opts.data||{} }; }
    postResult(r) { if (this.#done) return; this.#done = true; _settle(this.#id, 'ok', r); }
    postError(e)  { if (this.#done) return; this.#done = true; _settle(this.#id, 'err', e); }
  }

  function _settle(id, type, payload) {
    const p = _pending.get(id); if (!p) return;
    _pending.delete(id);
    if (type === 'ok') { p.resolve(payload); _ui && _ui.done('ok', payload); }
    else               { p.reject(new DOMException(String(payload),'ActivityError')); _ui && _ui.done('err', payload); }
  }

  /* ─── WebActivity ─── */
  class WebActivity {
    #id; #opts; #started = false;
    constructor(name, data) {
      if (!name || typeof name !== 'string') throw new TypeError('name must be string');
      this.#id = _id(); this.#opts = { name, data: data||{} };
      _ui && _ui.log('INFO', `new WebActivity("${name}")`);
    }
    start() {
      if (this.#started) return Promise.reject(new DOMException('Already started','InvalidStateError'));
      this.#started = true;
      _ui && _ui.log('INFO', `start() → "${this.#opts.name}"  data: ${_str(this.#opts.data)}`);
      return new Promise((res, rej) => {
        _pending.set(this.#id, { resolve:res, reject:rej, opts:this.#opts });
        _dispatch(this.#id, this.#opts);
      });
    }
    cancel() {
      const p = _pending.get(this.#id);
      if (p) { _pending.delete(this.#id); p.reject(new DOMException('ACTIVITY_CANCELED','AbortError')); }
      _ui && _ui.done('cancel', 'ACTIVITY_CANCELED');
    }
  }

  /* ─── dispatch ─── */
  function _dispatch(id, opts) {
    const matches = _findH(opts);
    _ui && _ui.log('SYS', `handler lookup "${opts.name}" → ${matches.length} registered match(es)`);
    _fire(id, opts, matches[0] || null);
  }

  function _fire(id, opts, handler) {
    const rh = new WebActivityRequestHandler(id, opts);

    /* 1 — JS mock callback */
    if (_callbacks.has(opts.name)) {
      _ui && _ui.log('SYS', 'using JS mock handler (MockActivitiesRegistry.onActivity)');
      try { _callbacks.get(opts.name)(rh); } catch(e) { _ui && _ui.log('ERR','mock threw: '+e.message); }
      return;
    }

    /* 2 — real ServiceWorker */
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      _ui && _ui.log('SYS', 'SW active — posting message to sw.js…');
      const ch = new MessageChannel();
      ch.port1.onmessage = e => {
        const d = e.data || {};
        if (d.type === 'activity-result') rh.postResult(d.result);
        if (d.type === 'activity-error')  rh.postError(d.error);
      };
      navigator.serviceWorker.controller.postMessage(
        { type:'activity', name: opts.name, payload: opts.data, port: ch.port2 },
        [ch.port2]
      );
      setTimeout(() => {
        if (_pending.has(id)) {
          _ui && _ui.log('WARN','8s timeout — sw.js এ postResult/postError হয়নি');
          _ui && _ui.done('timeout','SW_TIMEOUT — sw.js handler সাড়া দেয়নি');
        }
      }, 8000);
      return;
    }

    /* 3 — window fallback */
    _ui && _ui.log('WARN','SW নেই — window এ systemmessage event পাঠাচ্ছি');
    window.dispatchEvent(new CustomEvent('systemmessage', {
      detail: { name:'activity', data:{ webActivityRequestHandler: () => rh } }
    }));
    setTimeout(() => {
      if (_pending.has(id)) {
        _ui && _ui.log('WARN','5s timeout — window এ কেউ সাড়া দেয়নি');
        _ui && _ui.done('timeout','NO_HANDLER_RESPONSE');
      }
    }, 5000);
  }

  /* ─── public API ─── */
  const MockActivitiesRegistry = {
    register(acts, manifest) {
      manifest = manifest || location.origin + '/manifest.webmanifest';
      (Array.isArray(acts)?acts:[acts]).forEach(a => {
        const l = _handlers.get(a.name)||[]; l.push({ manifest, description: a.description||{} });
        _handlers.set(a.name, l);
        _ui && _ui.log('SYS', `handler registered: "${a.name}"`);
      });
    },
    onActivity(name, cb) { _callbacks.set(name, cb); _ui && _ui.log('SYS',`mock set: "${name}"`); },
  };

  G.WebActivity               = WebActivity;
  G.MozActivity               = WebActivity;
  G.WebActivityRequestHandler = WebActivityRequestHandler;
  G.MockActivitiesRegistry    = MockActivitiesRegistry;

  /* ═══════════════════════════════════════════════════════════
     UI
  ═══════════════════════════════════════════════════════════ */
  function build() {
    const S = document.createElement('style');
    S.textContent = `
      #_T{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
          font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #_T *{box-sizing:border-box}
      #_Tb{background:#111;border-top:1px solid #222;padding:8px 12px;
           display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      #_Tbadge{background:#534AB7;color:#fff;font-size:10px;font-weight:700;
               padding:3px 8px;border-radius:5px;letter-spacing:.04em;flex-shrink:0}
      #_Tsw{font-size:10px;padding:3px 9px;border-radius:10px;font-weight:600;flex-shrink:0}
      #_Tsw.ok{background:#0a2e20;color:#5DCAA5}
      #_Tsw.no{background:#1c1b1a;color:#555;border:1px solid #2a2928}
      .Tbtn{border:none;border-radius:6px;font-size:12px;font-weight:700;
            padding:6px 16px;cursor:pointer;letter-spacing:.02em;flex-shrink:0}
      .Tbtn:active{opacity:.7;transform:scale(.95)}
      #_Bopen {background:#1D9E75;color:#fff}
      #_Bshare{background:#534AB7;color:#fff}
      #_Bpick {background:#BA7517;color:#fff}
      #_Tdata{flex:1;min-width:160px;background:#1c1b1a;border:1px solid #2a2928;
              border-radius:5px;color:#d4d0c8;font-size:11px;padding:5px 8px;
              outline:none;font-family:monospace}
      #_Tdata:focus{border-color:#7F77DD}
      #_Tdata::placeholder{color:#444}
      #_Ttog{background:none;color:#555;border:1px solid #2a2928;
             border-radius:5px;font-size:11px;padding:5px 8px;cursor:pointer;margin-left:auto}
      #_Ttog:hover{color:#d4d0c8}
      #_Tp{background:#0d0d0c;border-top:1px solid #1e1e1e;display:none;flex-direction:column;height:200px}
      #_Tp.open{display:flex}
      #_Tph{display:flex;align-items:center;padding:5px 12px;gap:8px;
            border-bottom:1px solid #1a1a1a;flex-shrink:0}
      #_Tph span{font-size:10px;color:#333;flex:1;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
      #_Tph button{background:none;border:none;color:#333;font-size:10px;cursor:pointer;padding:2px 6px}
      #_Tph button:hover{color:#888}
      #_Tlog{flex:1;overflow-y:auto;padding:5px 10px;
             font:11px/1.9 "SFMono-Regular",Consolas,monospace}
      ._Tl{display:flex;gap:6px}
      ._Tts{color:#2a2928;flex-shrink:0}
      ._Ttag{flex-shrink:0;font-size:9px;font-weight:700;padding:1px 5px;
             border-radius:3px;margin-top:3.5px;height:fit-content}
      ._Ttag.S{background:#2a1a4a;color:#AFA9EC}
      ._Ttag.I{background:#1a3a5c;color:#85B7EB}
      ._Ttag.O{background:#0a2e20;color:#5DCAA5}
      ._Ttag.E{background:#3a1010;color:#F09595}
      ._Ttag.W{background:#2e1d00;color:#EF9F27}
      ._Tmsg{color:#9b9a95;word-break:break-all}
      #_Tres{flex-shrink:0;padding:5px 12px;border-top:1px solid #1a1a1a;
             font:11px "SFMono-Regular",Consolas,monospace;display:none}
      #_Tres.ok     {color:#5DCAA5}
      #_Tres.err    {color:#F09595}
      #_Tres.cancel {color:#EF9F27}
      #_Tres.timeout{color:#EF9F27}
      #_Tres pre{margin-top:3px;white-space:pre-wrap;word-break:break-all;
                 font-size:10px;opacity:.7;max-height:56px;overflow-y:auto}
    `;
    document.head.appendChild(S);

    const W = document.createElement('div'); W.id = '_T';
    W.innerHTML = `
      <div id="_Tp">
        <div id="_Tph">
          <span>Activity Log</span>
          <button id="_Tclr">clear</button>
        </div>
        <div id="_Tlog"></div>
        <div id="_Tres"></div>
      </div>
      <div id="_Tb">
        <span id="_Tbadge">⚡ Activity</span>
        <span id="_Tsw" class="no">SW –</span>
        <button class="Tbtn" id="_Bopen">open</button>
        <button class="Tbtn" id="_Bshare">share</button>
        <button class="Tbtn" id="_Bpick">pick</button>
        <input id="_Tdata" placeholder='data JSON — {"type":"video/mp4","url":"file.mp4"}'>
        <button id="_Ttog">▲</button>
      </div>
    `;
    document.body.appendChild(W);

    const tog   = document.getElementById('_Ttog');
    const panel = document.getElementById('_Tp');
    const log   = document.getElementById('_Tlog');
    const res   = document.getElementById('_Tres');
    const swBdg = document.getElementById('_Tsw');
    let   open  = false;

    tog.onclick = () => { open=!open; panel.classList.toggle('open',open); tog.textContent=open?'▼':'▲'; };
    document.getElementById('_Tclr').onclick = () => { log.innerHTML=''; res.style.display='none'; };

    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function addLog(type, msg) {
      const k = {SYS:'S',INFO:'I',OK:'O',ERR:'E',WARN:'W'}[type]||'I';
      const ts = new Date().toISOString().slice(11,19);
      const d  = document.createElement('div'); d.className='_Tl';
      d.innerHTML=`<span class="_Tts">${ts}</span><span class="_Ttag ${k}">${type}</span><span class="_Tmsg">${esc(msg)}</span>`;
      log.appendChild(d); log.scrollTop=log.scrollHeight;
      if (!open) { open=true; panel.classList.add('open'); tog.textContent='▼'; }
    }

    function showDone(type, payload) {
      const icons={ok:'✓',err:'✕',cancel:'⊘',timeout:'⏱'};
      const str=typeof payload==='object'?JSON.stringify(payload,null,2):String(payload);
      res.className=type; res.style.display='block';
      res.innerHTML=`${icons[type]||'?'} <b>${type.toUpperCase()}</b><pre>${esc(str)}</pre>`;
    }

    function fire(name) {
      let data={};
      const raw=document.getElementById('_Tdata').value.trim();
      if (raw) { try { data=JSON.parse(raw); } catch(e){ addLog('ERR','JSON invalid: '+e.message); return; } }
      res.style.display='none';
      addLog('INFO', `▶ activity "${name}"  data: ${_str(data)||'{}'}`);
      const act = new WebActivity(name, data);
      act.start()
        .then(r  => { addLog('OK',  '✓ postResult: '+_str(r));   showDone('ok',r); })
        .catch(e => { addLog('ERR', '✕ rejected: '+e.message);   showDone('err',e.message); });
    }

    document.getElementById('_Bopen').onclick  = () => fire('open');
    document.getElementById('_Bshare').onclick = () => fire('share');
    document.getElementById('_Bpick').onclick  = () => fire('pick');

    /* SW check */
    function checkSW() {
      if (!('serviceWorker' in navigator)) { swBdg.textContent='SW N/A'; swBdg.className='_Tsw no'; return; }
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg && reg.active) {
          swBdg.textContent='SW ✓'; swBdg.className='_Tsw ok';
          addLog('SYS','ServiceWorker active — activity sw.js এ যাবে');
        } else {
          swBdg.textContent='SW ✗'; swBdg.className='_Tsw no';
          addLog('WARN','ServiceWorker নেই — window fallback ব্যবহার হবে');
        }
      });
    }
    setTimeout(checkSW, 600);
    navigator.serviceWorker && navigator.serviceWorker.addEventListener('controllerchange', checkSW);

    _ui = { log: addLog, done: showDone };
    addLog('SYS','Activity Tester ready');
    addLog('SYS','open / share / pick চাপো — sw.js handler ধরলে result আসবে');
  }

  document.readyState==='loading'
    ? document.addEventListener('DOMContentLoaded', build)
    : build();

})(window);
