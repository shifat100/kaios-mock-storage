(function() {
  'use strict';

  const DB_NAME = 'KaiOS_DS_Polyfill_v2';
  const DB_VER  = 1;

  const DEVICES = [
    { name:'sdcard',  mount:'/storage/sdcard',  isDefault:true,  quota:200*1024*1024  },
    { name:'sdcard1', mount:'/storage/sdcard1', isDefault:false, quota:1024*1024*1024 },
  ];

  const AREAS   = ['sdcard','music','pictures','videos','apps'];
  const MIME_OK = { music:/^audio\//, pictures:/^image\//, videos:/^video\// };

  // All IDB stores: "sdcard__music", "sdcard1__pictures", …
  const ALL_STORES = [];
  DEVICES.forEach(d => AREAS.forEach(a => ALL_STORES.push(d.name+'__'+a)));

  let _db = null;
  let _defaultDev = 'sdcard';

  function openDB() {
    return new Promise((res,rej) => {
      if (_db) return res(_db);
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        ALL_STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'rel'}); });
      };
      r.onsuccess = e => { _db = e.target.result; res(_db); };
      r.onerror   = e => rej(e.target.error);
    });
  }

  /* ── DOMRequest ── */
  class DOMRequest {
    constructor(){ this.onsuccess=null;this.onerror=null;this.result=undefined;this.error=null;this.readyState='pending'; }
    _ok(v){ this.readyState='done';this.result=v; if(typeof this.onsuccess==='function') setTimeout(()=>this.onsuccess.call(this),0); }
    _err(e){ this.readyState='done';this.error=e; if(typeof this.onerror==='function') setTimeout(()=>this.onerror.call(this),0); }
  }

  /* ── DOMCursor ── */
  class DOMCursor extends DOMRequest {
    constructor(){ super();this._items=[];this._idx=-1;this.done=false; }
    _load(items){ this._items=items; this.continue(); }
    continue(){
      this._idx++;
      if(this._idx<this._items.length){ this.done=false; this._ok(this._items[this._idx]); }
      else { this.done=true; this.result=null; if(typeof this.onsuccess==='function') setTimeout(()=>this.onsuccess.call(this),0); }
    }
  }

  /* ── DeviceStorageChangeEvent ── */
  class DeviceStorageChangeEvent extends Event {
    constructor(reason,path){ super('change'); this.reason=reason; this.path=path; }
  }

  /* ── DeviceStorage ── */
  class DeviceStorage extends EventTarget {
    /**
     * @param {string} physDev  "sdcard" | "sdcard1"
     * @param {string} area     "sdcard" | "music" | "pictures" | "videos" | "apps"
     * @param {boolean} isDefault
     */
    constructor(physDev, area, isDefault) {
      super();
      this.storageName = physDev;   // physical device name (real KaiOS behaviour)
      this.mediaArea   = area;
      this.default     = isDefault;
      this._mount      = DEVICES.find(d=>d.name===physDev)?.mount || '/'+physDev;
      this._store      = physDev+'__'+area;
      this._onchange   = null;
    }

    get onchange(){ return this._onchange; }
    set onchange(fn){
      if(this._onchange) this.removeEventListener('change',this._onchange);
      this._onchange = fn;
      if(fn) this.addEventListener('change',fn);
    }

    // Full filesystem path: /sdcard/Music/song.mp3
    _fp(rel){ return '/'+this.storageName+'/'+rel; }

    _fire(reason,rel){ this.dispatchEvent(new DeviceStorageChangeEvent(reason, this._fp(rel))); }

    _chkMime(blob){
      const r=MIME_OK[this.mediaArea];
      return (r&&!r.test(blob.type)) ? `"${this.mediaArea}" only accepts ${this.mediaArea} MIME types (got "${blob.type}").` : null;
    }
    _chkPath(n){
      if(!n||typeof n!=='string') return 'File name must be a non-empty string.';
      if(n.startsWith('/')||n.startsWith('../')) return 'Path cannot start with "/" or "../".';
      return null;
    }
    _autoName(blob){ const ext=blob.type?'.'+blob.type.split('/')[1]:'.bin'; return Date.now()+'-'+Math.random().toString(36).slice(2,7)+ext; }

    /* add(blob) */
    add(blob){
      const req=new DOMRequest(), e=this._chkMime(blob);
      if(e){req._err(e);return req;}
      this._write(req,this._autoName(blob),blob,false);
      return req;
    }

    /* addNamed(blob, relativePath) */
    addNamed(blob,rel){
      const req=new DOMRequest();
      const me=this._chkMime(blob); if(me){req._err(me);return req;}
      const pe=this._chkPath(rel);  if(pe){req._err(pe);return req;}
      this._write(req,rel,blob,true);
      return req;
    }

    _write(req,rel,blob,errIfExists){
      openDB().then(db=>{
        const reader=new FileReader();
        reader.onload=e=>{
          const rec={
            rel,                         // IndexedDB key
            fullPath: this._fp(rel),     // /sdcard/Music/song.mp3
            type: blob.type||'application/octet-stream',
            size: blob.size,
            data: e.target.result,       // ArrayBuffer
            mtime: new Date().toISOString(),
          };
          const tx=db.transaction(this._store,'readwrite');
          const os=tx.objectStore(this._store);
          const chk=os.get(rel);
          chk.onsuccess=()=>{
            if(chk.result&&errIfExists){req._err(`"${rel}" already exists.`);return;}
            const reason=chk.result?'modified':'created';
            const put=os.put(rec);
            put.onsuccess=()=>{ req._ok(this._fp(rel)); this._fire(reason,rel); };
            put.onerror=()=>req._err(put.error?.message||'Write failed');
          };
          chk.onerror=()=>req._err(chk.error?.message);
        };
        reader.onerror=()=>req._err('FileReader error');
        reader.readAsArrayBuffer(blob);
      }).catch(e=>req._err(e.message));
    }

    /* get(rel) → File  (file.name = full path) */
    get(rel){
      const req=new DOMRequest(), pe=this._chkPath(rel);
      if(pe){req._err(pe);return req;}
      openDB().then(db=>{
        const g=db.transaction(this._store,'readonly').objectStore(this._store).get(rel);
        g.onsuccess=()=>{
          if(!g.result){req._err(`"${rel}" not found.`);return;}
          const r=g.result;
          req._ok(new File([r.data], r.fullPath, {type:r.type, lastModified:new Date(r.mtime).getTime()}));
        };
        g.onerror=()=>req._err(g.error?.message);
      }).catch(e=>req._err(e.message));
      return req;
    }

    /* getEditable(rel) → FileHandle-like */
    getEditable(rel){
      const req=new DOMRequest(), storage=this;
      const inner=this.get(rel);
      inner.onsuccess=function(){
        const file=this.result;
        req._ok({
          file, name:file.name,
          write(c){ const wr=new DOMRequest(); storage._write(wr,rel,c instanceof Blob?c:new Blob([c],{type:file.type}),false); return wr; },
          truncate(){ const tr=new DOMRequest(); storage._write(tr,rel,new Blob([],{type:file.type}),false); return tr; }
        });
      };
      inner.onerror=function(){req._err(this.error);};
      return req;
    }

    /* delete(rel) */
    delete(rel){
      const req=new DOMRequest(), pe=this._chkPath(rel);
      if(pe){req._err(pe);return req;}
      openDB().then(db=>{
        const tx=db.transaction(this._store,'readwrite'), os=tx.objectStore(this._store);
        const chk=os.get(rel);
        chk.onsuccess=()=>{
          if(!chk.result){req._err(`"${rel}" not found.`);return;}
          const del=os.delete(rel);
          del.onsuccess=()=>{ req._ok(this._fp(rel)); this._fire('deleted',rel); };
          del.onerror=()=>req._err(del.error?.message);
        };
      }).catch(e=>req._err(e.message));
      return req;
    }

    /* enumerate([subdir|opts], [opts]) → DOMCursor; file.name = full path */
    enumerate(subdirOrOpts, opts){
      const cur=new DOMCursor();
      let subdir=null, since=null;
      if(typeof subdirOrOpts==='string'){subdir=subdirOrOpts; since=opts?.since||null;}
      else if(subdirOrOpts?.since){since=subdirOrOpts.since;}

      openDB().then(db=>{
        const ga=db.transaction(this._store,'readonly').objectStore(this._store).getAll();
        ga.onsuccess=()=>{
          let recs=ga.result||[];
          if(subdir){ const p=subdir.endsWith('/')?subdir:subdir+'/'; recs=recs.filter(r=>r.rel.startsWith(p)||r.rel===subdir); }
          if(since instanceof Date) recs=recs.filter(r=>new Date(r.mtime)>=since);
          cur._load(recs.map(r=>new File([r.data],r.fullPath,{type:r.type,lastModified:new Date(r.mtime).getTime()})));
        };
        ga.onerror=()=>cur._err(ga.error?.message);
      }).catch(e=>cur._err(e.message));
      return cur;
    }

    /* enumerateEditable → FileHandle cursors */
    enumerateEditable(subdirOrOpts, opts){
      const outer=new DOMCursor(), storage=this, handles=[];
      const inner=this.enumerate(subdirOrOpts,opts);
      inner.onsuccess=function(){
        if(!this.done&&this.result){
          const file=this.result;
          const rel=file.name.replace(/^\/[^\/]+\//,'');
          handles.push({file,name:file.name,write(c){const wr=new DOMRequest();storage._write(wr,rel,c instanceof Blob?c:new Blob([c],{type:file.type}),false);return wr;}});
          this.continue();
        } else outer._load(handles);
      };
      inner.onerror=function(){outer._err(this.error);};
      return outer;
    }

    /* usedSpace() */
    usedSpace(){
      const req=new DOMRequest();
      openDB().then(db=>{
        const ga=db.transaction(this._store,'readonly').objectStore(this._store).getAll();
        ga.onsuccess=()=>req._ok((ga.result||[]).reduce((s,r)=>s+(r.size||0),0));
        ga.onerror=()=>req._err(ga.error?.message);
      }).catch(e=>req._err(e.message));
      return req;
    }

    /* freeSpace() */
    freeSpace(){
      const req=new DOMRequest();
      const quota=DEVICES.find(d=>d.name===this.storageName)?.quota||100*1024*1024;
      openDB().then(db=>{
        const ga=db.transaction(this._store,'readonly').objectStore(this._store).getAll();
        ga.onsuccess=()=>req._ok(quota-(ga.result||[]).reduce((s,r)=>s+(r.size||0),0));
        ga.onerror=()=>req._err(ga.error?.message);
      }).catch(e=>req._err(e.message));
      return req;
    }

    /* available() */
    available(){ const req=new DOMRequest(); setTimeout(()=>req._ok('available'),5); return req; }
  }

  /* ── Instance registry ── */
  const _inst = {};
  DEVICES.forEach(dev=>{ _inst[dev.name]={}; AREAS.forEach(a=>{ _inst[dev.name][a]=new DeviceStorage(dev.name,a,dev.isDefault); }); });

  /* ── navigator.getDeviceStorage(areaName) ──
     Returns the DEFAULT physical device's storage for this area */
  navigator.getDeviceStorage = function(area){
    if(!AREAS.includes(area)){ console.warn(`[Polyfill] Unknown area "${area}"`); area='sdcard'; }
    return _inst[_defaultDev][area];
  };

  /* ── navigator.getDeviceStorages(areaName) ──
     Returns ARRAY: [internal_storage, external_storage] */
  navigator.getDeviceStorages = function(area){
    if(!AREAS.includes(area)) return [];
    return DEVICES.map(d=>_inst[d.name][area]);
  };

  /* ── Internal UI helpers ── */
  window._ds = {
    get(physDev,area){ return _inst[physDev]?.[area]; },
    setDefault(physDev){
      _defaultDev=physDev;
      DEVICES.forEach(d=>AREAS.forEach(a=>{ _inst[d.name][a].default=(d.name===physDev); }));
    },
    getDefault(){ return _defaultDev; },
    DEVICES, AREAS,
    getQuota(physDev){ return DEVICES.find(d=>d.name===physDev)?.quota||0; }
  };

  console.log('[DeviceStorage Polyfill v2] ✅ Installed.');
  console.log('  Internal: navigator.getDeviceStorage("music") → sdcard/music, path /sdcard/<rel>');
  console.log('  External: navigator.getDeviceStorages("music")[1] → sdcard1/music, path /sdcard1/<rel>');
})();
