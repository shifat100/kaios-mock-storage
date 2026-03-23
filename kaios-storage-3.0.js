/**
 * ============================================================================
 * KaiOS 3.0 DeviceStorage API Polyfill v3.1 (with built-in Explorer)
 * ============================================================================
 * Polyfills navigator.b2g.getDeviceStorage() for modern browsers using
 * IndexedDB as the persistent storage backend.
 *
 * NEW in v3.1:
 *   • Fixed StorageRequest .readyState (pending -> done).
 *   • Fixed EventTarget missing direct .onchange triggers.
 *   • Fixed getDeviceStorages() no-argument crash.
 *   • Added Built-in Visual File Explorer (?explorer in URL).
 *
 * Supported storage types: "sdcard", "sdcard1", "pictures", "videos", "music", "apps"
 *
 * Browser compatibility: Chrome 66+, Firefox 60+, Edge 79+, Safari 14+
 * (all ES2017+ async/await, IndexedDB v2, Symbol.asyncIterator required)
 * ============================================================================
 */

(function (global) {
  "use strict";

  // ── 0. Guard – real KaiOS 3: skip polyfill ─────────────────────────────────
  if (global.navigator && global.navigator.b2g &&
      typeof global.navigator.b2g.getDeviceStorage === 'function' &&
      /KAIOS|KaiOS/i.test(global.navigator.userAgent || '')) {
    console.log('[DeviceStorage] Real KaiOS 3 detected – native API active.');
    return;
  }

  // ── Constants ──────────────────────────────────────────────────────────────
  const DB_NAME = "KaiOSDeviceStorage_v1";
  const DB_VERSION = 1;

  const STORAGE_TYPES = ["sdcard", "sdcard1",
                         "pictures", "videos", "music", "apps",
                         "crashes", "apps-storage"];

  const SIMULATED_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

  // ── Database singleton ────────────────────────────────────────────────────
  let _db = null;

  function openDatabase() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        for (const type of STORAGE_TYPES) {
          if (!db.objectStoreNames.contains(type)) {
            db.createObjectStore(type, { keyPath: "name" });
          }
        }
      };

      req.onsuccess = (event) => {
        _db = event.target.result;
        _db.onversionchange = () => {
          console.warn("[DeviceStorage] DB version changed; closing connection.");
          _db.close();
          _db = null;
        };
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new DOMException("IndexedDB blocked", "UnknownError"));
    });
  }

  // ── Low-level IDB helpers ─────────────────────────────────────────────────
  function idbPromise(idbReq) {
    return new Promise((resolve, reject) => {
      idbReq.onsuccess = () => resolve(idbReq.result);
      idbReq.onerror  = () => reject(idbReq.error);
    });
  }

  function txStore(db, storeName, mode) {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { tx, store };
  }

  function basename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  // ── StorageRequest ─────────────────────────────────────────────────────────
  class StorageRequest {
    constructor() {
      this.result = undefined;
      this.error  = null;
      this.onsuccess = null;
      this.onerror   = null;
      this._promise  = null;
      this.readyState = "pending"; // Fix 1: Native property required by KaiOS apps
    }

    _resolve(result) {
      this.result = result;
      this.readyState = "done";
      if (typeof this.onsuccess === "function") {
        Promise.resolve().then(() => {
          this.onsuccess({ target: this, type: "success" });
        });
      }
    }

    _reject(errorOrName) {
      if (typeof errorOrName === "string") {
        this.error = new DOMException(errorOrName, errorOrName);
      } else {
        this.error = errorOrName;
      }
      this.readyState = "done";
      if (typeof this.onerror === "function") {
        Promise.resolve().then(() => {
          this.onerror({ target: this, type: "error" });
        });
      }
    }

    then(onFulfilled, onRejected) {
      if (!this._promise) {
        this._promise = Promise.reject(new DOMException(
          "StorageRequest has no attached operation", "UnknownError"));
      }
      return this._promise.then(onFulfilled, onRejected);
    }

    catch(onRejected) {
      return this.then(undefined, onRejected);
    }

    finally(onFinally) {
      return this.then(
        (v)  => { onFinally(); return v; },
        (e)  => { onFinally(); throw e; }
      );
    }
  }

  function makeRequest(asyncFn) {
    const req = new StorageRequest();
    req._promise = asyncFn().then(
      (result) => { req._resolve(result); return result; },
      (err)    => {
        const name = err && err.name ? err.name : "UnknownError";
        req._reject(new DOMException(err && err.message ? err.message : name, name));
        throw req.error;
      }
    );
    return req;
  }

  // ── Record schema ──────────────────────────────────────────────────────────
  function makeRecord(blob, name) {
    return {
      name,
      type:         blob.type || "application/octet-stream",
      size:         blob.size,
      lastModified: Date.now(),
      blob,
    };
  }

  function recordToFile(record, storageType) {
    let file;
    try {
      file = new File([record.blob], `/${storageType}/${record.name}`, {
        type:         record.type,
        lastModified: record.lastModified,
      });
    } catch(e) {
      file = new Blob([record.blob], { type: record.type });
    }
    
    // Safely bypass strict mode getters
    try { Object.defineProperty(file, 'name', { value: `/${storageType}/${record.name}`, enumerable: true }); } catch (ex) {}
    try { Object.defineProperty(file, 'lastModifiedDate', { value: new Date(record.lastModified), enumerable: true }); } catch (ex) {}
    try { Object.defineProperty(file, 'path', { value: `/${storageType}/${record.name}`, enumerable: true }); } catch (ex) {}
    return file;
  }

  // ── FileIterable ───────────────────────────────────────────────────────────
  class FileIterable {
    constructor(storageType, pathPrefix = "", since = 0) {
      this._storageType = storageType;
      this._pathPrefix  = pathPrefix;
      this._since       = since;
    }

    [Symbol.asyncIterator]() {
      return this.values();
    }

    values() {
      const storageType = this._storageType;
      const pathPrefix  = this._pathPrefix;
      const since       = this._since;

      let _records = [];
      let _done    = false;
      let _loadPromise = null;

      async function loadAll() {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
          const { tx, store } = txStore(db, storageType, "readonly");
          const request = store.openCursor();

          request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
              _done = true;
              resolve();
              return;
            }
            const record = cursor.value;
            const nameOk   = !pathPrefix || record.name.startsWith(pathPrefix);
            const sinceOk  = !since      || record.lastModified >= since;
            if (nameOk && sinceOk) _records.push(record);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
          tx.onerror      = () => reject(tx.error);
        });
      }

      return {
        next() {
          if (!_loadPromise) _loadPromise = loadAll();
          return _loadPromise.then(() => {
            if (_records.length === 0) return { done: true, value: undefined };
            const record = _records.shift();
            return { done: false, value: recordToFile(record, storageType) };
          });
        },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  // ── PseudoDirectory ────────────────────────────────────────────────────────
  class PseudoDirectory {
    constructor(storageType, virtualPath = "/") {
      this._storageType = storageType;
      this.path = `/${storageType}${virtualPath === "/" ? "" : virtualPath}`;
    }

    createDirectory(name) {
      const storageType = this._storageType;
      if (!name || name.includes("/") || name === ".." || name === ".") {
        const req = new StorageRequest();
        Promise.resolve().then(() =>
          req._reject(new DOMException(`Invalid dir: ${name}`, "InvalidModificationError")));
        return req;
      }
      return makeRequest(async () => {
        const db = await openDatabase();
        const dirBlob = new Blob([], { type: "inode/directory" });
        const dirPath = `__dir__/${name}`;
        const record  = makeRecord(dirBlob, dirPath);
        const { store } = txStore(db, storageType, "readwrite");
        await idbPromise(store.put(record));
        return new PseudoDirectory(storageType, `/${name}`);
      });
    }

    getFilesAndDirectories() {
      const storageType = this._storageType;
      return makeRequest(async () => {
        const db = await openDatabase();
        const { store } = txStore(db, storageType, "readonly");
        const allRecords = await idbPromise(store.getAll());
        const items = [];
        for (const record of allRecords) {
          if (record.type === "inode/directory") {
            const dirName = record.name.replace("__dir__/", "");
            items.push(new PseudoDirectory(storageType, `/${dirName}`));
          } else {
            items.push(recordToFile(record, storageType));
          }
        }
        return items;
      });
    }
  }

  // ── DeviceStorage ──────────────────────────────────────────────────────────
  class DeviceStorage extends EventTarget {
    constructor(storageType) {
      super();
      this.storageName = storageType;
      this._storageType = storageType;
      this.onchange = null; // Fix 2: Add Native handler hook
    }

    addNamed(blob, name) {
      if (!(blob instanceof Blob)) return _rejectRequest("Expected Blob", "InvalidModificationError");
      if (typeof name !== "string" || !name) return _rejectRequest("Invalid name", "InvalidModificationError");
      if (_hasUnsafePath(name)) return _rejectRequest(`Unsafe path: ${name}`, "InvalidModificationError");

      const storageType = this._storageType;
      return makeRequest(async () => {
        const db     = await openDatabase();
        const record = makeRecord(blob, name);
        const { store } = txStore(db, storageType, "readwrite");
        await idbPromise(store.put(record));
        const fullPath = `/${storageType}/${name}`;
        _dispatchChangeEvent(this, "created", fullPath);
        return fullPath;
      });
    }

    appendNamed(blob, name) {
      if (!(blob instanceof Blob)) return _rejectRequest("Expected Blob", "InvalidModificationError");
      if (typeof name !== "string" || !name) return _rejectRequest("Invalid name", "InvalidModificationError");

      const storageType = this._storageType;
      return makeRequest(async () => {
        const db = await openDatabase();
        const { store: readStore } = txStore(db, storageType, "readonly");
        let existing = await idbPromise(readStore.get(name)).catch(() => null);

        let newBlob = (existing && existing.blob) 
          ? new Blob([existing.blob, blob], { type: blob.type || existing.type })
          : blob;

        const record = makeRecord(newBlob, name);
        const { store: writeStore } = txStore(db, storageType, "readwrite");
        await idbPromise(writeStore.put(record));
        const fullPath = `/${storageType}/${name}`;
        _dispatchChangeEvent(this, "modified", fullPath);
        return fullPath;
      });
    }

    // get(name) {
    //   if (typeof name !== "string" || !name) return _rejectRequest("Invalid name", "NotFoundError");
    //   const storageType = this._storageType;
    //   return makeRequest(async () => {
    //     const db = await openDatabase();
    //     const { store } = txStore(db, storageType, "readonly");
    //     const record = await idbPromise(store.get(name));
    //     if (!record) throw new DOMException(`File not found: ${name}`, "NotFoundError");
    //     return recordToFile(record, storageType);
    //   });
    // }
    get(name) {
  if (typeof name !== "string" || !name) return _rejectRequest("Invalid name", "NotFoundError");
  
  // Strip leading "/<storageType>/" prefix if present (from enumerate()'s file.name)
  const prefix = `/${this._storageType}/`;
  if (name.startsWith(prefix)) name = name.slice(prefix.length);
  // Also strip a bare leading slash
  else if (name.startsWith("/")) name = name.slice(1);

  const storageType = this._storageType;
  return makeRequest(async () => {
    const db = await openDatabase();
    const { store } = txStore(db, storageType, "readonly");
    const record = await idbPromise(store.get(name));
    if (!record) throw new DOMException(`File not found: ${name}`, "NotFoundError");
    return recordToFile(record, storageType);
  });
}

    getEditable(name) { return this.get(name); }

    delete(name) {
      if (typeof name !== "string" || !name) return _rejectRequest("Invalid name", "NotFoundError");
      const storageType = this._storageType;
      return makeRequest(async () => {
        const db = await openDatabase();
        const { store: readStore } = txStore(db, storageType, "readonly");
        const existing = await idbPromise(readStore.get(name));
        if (!existing) throw new DOMException(`File not found: ${name}`, "NotFoundError");
        const { store: writeStore } = txStore(db, storageType, "readwrite");
        await idbPromise(writeStore.delete(name));
        const fullPath = `/${storageType}/${name}`;
        _dispatchChangeEvent(this, "deleted", fullPath);
        return name;
      });
    }

    enumerate(pathOrOptions, options) {
      let pathPrefix = "", since = 0;
      if (typeof pathOrOptions === "string") {
        pathPrefix = pathOrOptions;
        if (options && typeof options.since === "number") since = options.since;
      } else if (pathOrOptions && typeof pathOrOptions === "object") {
        if (typeof pathOrOptions.since === "number") since = pathOrOptions.since;
      }
      return new FileIterable(this._storageType, pathPrefix, since);
    }

    enumerateEditable(pathOrOptions, options) { return this.enumerate(pathOrOptions, options); }

    usedSpace() {
      const storageType = this._storageType;
      return makeRequest(async () => {
        const db = await openDatabase();
        const { store } = txStore(db, storageType, "readonly");
        const allRecords = await idbPromise(store.getAll());
        let total = 0;
        for (const record of allRecords) total += record.size || 0;
        return total;
      });
    }

    freeSpace() { return makeRequest(async () => SIMULATED_FREE_BYTES); }
    isDiskFull() { return makeRequest(async () => false); }
    available() { return makeRequest(async () => "available"); }

    getRoot() {
      return openDatabase().then(() => new PseudoDirectory(this._storageType, "/"));
    }

    getStorageName() { return this.storageName; }
    getStoragePath() { return `/${this._storageType}`; }

    storageStatus() { return makeRequest(async () => "available"); }
    format() { return makeRequest(async () => "unavailable"); }
    mount() { return makeRequest(async () => "available"); }
    unmount() { return makeRequest(async () => "unavailable"); }
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  function _rejectRequest(msg, name) {
    const req = new StorageRequest();
    req._promise = Promise.reject(new DOMException(msg, name));
    req._promise.catch(() => {});
    Promise.resolve().then(() => req._reject(new DOMException(msg, name)));
    return req;
  }

  function _hasUnsafePath(path) {
    if (path.startsWith("/"))  return true;
    const parts = path.split("/");
    for (const part of parts) if (part === ".." || part === ".") return true;
    return false;
  }

  function _dispatchChangeEvent(storage, reason, path) {
    Promise.resolve().then(() => {
      const event = new CustomEvent("change", {
        bubbles:    false,
        cancelable: false,
        detail: { reason, path },
      });
      Object.defineProperty(event, "path",   { value: path });
      Object.defineProperty(event, "reason", { value: reason });
      storage.dispatchEvent(event);

      // Fix 2: Trigger direct property handler if present
      if (typeof storage.onchange === "function") {
        try { storage.onchange(event); } catch (e) { console.error(e); }
      }
    });
  }

  // ── navigator.b2g namespace ────────────────────────────────────────────────
  const _storageInstances = new Map();

  const b2g = Object.freeze({
    getDeviceStorage(storageType) {
      if (!STORAGE_TYPES.includes(storageType)) {
        throw new DOMException(
          `Unknown storage type '${storageType}'. Valid types: ${STORAGE_TYPES.join(", ")}`, "UnknownError");
      }
      if (!_storageInstances.has(storageType)) {
        _storageInstances.set(storageType, new DeviceStorage(storageType));
      }
      return _storageInstances.get(storageType);
    },

    getDeviceStorages(storageType) {
      // Fix 3: Handle no-arguments -> return all volumes
      if (storageType === undefined || storageType === null || storageType === "") {
        return STORAGE_TYPES.map(type => this.getDeviceStorage(type));
      }

      if (storageType === "sdcard") {
        return [ this.getDeviceStorage("sdcard"), this.getDeviceStorage("sdcard1") ];
      }
      return [this.getDeviceStorage(storageType)];
    }
  });

  // ── Install polyfill ───────────────────────────────────────────────────────
  if (typeof global.navigator !== "undefined" && !global.navigator.b2g) {
    try {
      Object.defineProperty(global.navigator, "b2g", {
        value: b2g, writable: false, configurable: true, enumerable: true,
      });
      console.info("[DeviceStorage] navigator.b2g installed. Backend: IndexedDB.");
    } catch (e) {
      console.warn("[DeviceStorage] Could not install navigator.b2g:", e);
    }
  }

  // ── Built-in Explorer UI (?explorer in URL) ────────────────────────────────
  function _getExplorerParam() {
    if (typeof location === 'undefined') return null;
    const search = (location.search || '').slice(1).split('&');
    for (const pair of search) {
      const kv = pair.split('=');
      if (kv[0] === 'explorer') return kv.length > 1 && kv[1] ? decodeURIComponent(kv[1]) : 'sdcard';
    }
    return null;
  }

  function _esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _icon(name, isDir) {
    if (isDir) return '\uD83D\uDCC1';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const MAP = {
      jpg:'\uD83D\uDDBC', jpeg:'\uD83D\uDDBC', png:'\uD83D\uDDBC', gif:'\uD83D\uDDBC',
      mp3:'\uD83C\uDFB5', wav:'\uD83C\uDFB5', mp4:'\uD83C\uDFAC', txt:'\uD83D\uDCC4',
      pdf:'\uD83D\uDCD1', zip:'\uD83D\uDCE6'
    };
    return MAP[ext] || '\uD83D\uDCC4';
  }

  function _formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[Math.min(i, 3)];
  }

  function _formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ` +
           `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }

  function _launchExplorer(startVolume) {
    const css = `
      #ds-ov {position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;
        background:#0d1117;color:#c9d1d9;font-family:monospace,monospace;font-size:13px;
        display:flex;flex-direction:column;overflow:hidden;}
      #ds-ov * {box-sizing:border-box;}
      #ds-tb {display:flex;align-items:center;gap:6px;padding:8px 12px;background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;flex-wrap:wrap;}
      #ds-tb h1 {margin:0;font-size:14px;color:#58a6ff;flex:0 0 auto;}
      #ds-tb select, #ds-tb button, #ds-tb input[type=text] {background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;}
      #ds-tb input[type=text] {cursor:text;min-width:160px;}
      #ds-tb button:hover {background:#388bfd22;border-color:#58a6ff;}
      #ds-close {margin-left:auto;color:#f85149 !important;}
      #ds-bc {padding:5px 12px;background:#0d1117;border-bottom:1px solid #21262d;font-size:11px;color:#8b949e;flex-shrink:0;}
      #ds-bc span {color:#58a6ff;cursor:pointer;}
      #ds-bc span:hover {text-decoration:underline;}
      #ds-bd {flex:1;overflow-y:auto;position:relative;}
      .ds-row {display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #21262d;cursor:default;user-select:none;}
      .ds-row:hover {background:#161b22;}
      .ds-ico {font-size:16px;flex-shrink:0;width:22px;text-align:center;}
      .ds-nm {flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c9d1d9;}
      .ds-nm.ds-dir {color:#58a6ff;cursor:pointer;}
      .ds-nm.ds-dir:hover {text-decoration:underline;}
      .ds-meta {font-size:11px;color:#8b949e;white-space:nowrap;flex-shrink:0;}
      .ds-acts {display:flex;gap:3px;flex-shrink:0;}
      .ds-acts button {background:transparent;border:1px solid #30363d;color:#8b949e;border-radius:3px;padding:2px 5px;font-size:11px;cursor:pointer;}
      .ds-acts button:hover {color:#c9d1d9;border-color:#8b949e;}
      #ds-empty {text-align:center;padding:40px;color:#484f58;}
      #ds-drop {position:absolute;top:0;left:0;width:100%;height:100%;background:#58a6ff22;border:3px dashed #58a6ff;display:none;align-items:center;justify-content:center;font-size:18px;color:#58a6ff;pointer-events:none;z-index:5;}
      #ds-pv-panel {background:#0d1117;border-top:2px solid #30363d;max-height:200px;overflow:auto;padding:8px 12px;flex-shrink:0;display:none;}
      #ds-pv-panel img, #ds-pv-panel video, #ds-pv-panel audio {max-width:100%;max-height:160px;display:block;}
      #ds-pv-panel pre {margin:0;font-size:11px;white-space:pre-wrap;color:#e6edf3;}
      #ds-st {padding:4px 12px;background:#161b22;border-top:1px solid #30363d;font-size:11px;color:#8b949e;flex-shrink:0;display:flex;gap:16px;}
    `;

    const styleEl = document.createElement('style');
    styleEl.id = 'ds-explorer-style';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    const ov = document.createElement('div');
    ov.id = 'ds-ov';
    ov.innerHTML = `
      <div id="ds-tb">
        <h1>💾 B2G Explorer</h1>
        <select id="ds-vol"></select>
        <input type="text" id="ds-filter" placeholder="Filter...">
        <button id="ds-ref">↻</button>
        <button id="ds-up">⬆ Upload</button>
        <input type="file" id="ds-finput" multiple style="display:none">
        <button id="ds-mkdir">+ Dir</button>
        <button id="ds-close">✕ Close</button>
      </div>
      <div id="ds-bc"></div>
      <div id="ds-bd">
        <div id="ds-empty">Loading...</div>
        <div id="ds-drop">Drop files</div>
      </div>
      <div id="ds-pv-panel"></div>
      <div id="ds-st"><span id="ds-cnt"></span><span id="ds-used"></span><span id="ds-free"></span></div>
    `;
    document.body.appendChild(ov);

    const volSel   = document.getElementById('ds-vol');
    const filterIn = document.getElementById('ds-filter');
    const body     = document.getElementById('ds-bd');
    const emptyEl  = document.getElementById('ds-empty');
    const bcEl     = document.getElementById('ds-bc');
    const pvPanel  = document.getElementById('ds-pv-panel');
    const finput   = document.getElementById('ds-finput');
    const dropEl   = document.getElementById('ds-drop');

    STORAGE_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = type;
      volSel.appendChild(opt);
    });
    volSel.value = STORAGE_TYPES.includes(startVolume) ? startVolume : 'sdcard';

    const state = { dir: '', filter: '', records: [] };

    function renderBC() {
      const segs = [{ label: '💾 ' + volSel.value, dir: '' }];
      if (state.dir) {
        const parts = state.dir.split('/');
        let acc = '';
        for (let i=0; i<parts.length; i++) {
          acc += (i ? '/' : '') + parts[i];
          segs.push({ label: parts[i], dir: acc });
        }
      }
      bcEl.innerHTML = segs.map((s, i) => 
        (i ? ' <span style="color:#484f58">/</span> ' : '') + 
        `<span data-d="${_esc(s.dir)}">${_esc(s.label)}</span>`
      ).join('');
      bcEl.querySelectorAll('span[data-d]').forEach(el => {
        el.onclick = () => { state.dir = el.getAttribute('data-d'); loadFiles(); };
      });
    }

    async function loadFiles() {
      renderBC();
      pvPanel.style.display = 'none';
      emptyEl.style.display = 'block';
      emptyEl.textContent = "Loading...";

      try {
        const db = await openDatabase();
        const { store } = txStore(db, volSel.value, "readonly");
        const recs = await idbPromise(store.getAll());
        state.records = recs;
        renderRows(recs);
        updateStatus();
      } catch(e) {
        emptyEl.textContent = 'Error: ' + e.message;
      }
    }

    function renderRows(records) {
      body.querySelectorAll('.ds-row').forEach(e => e.remove());

      const prefix = state.dir ? state.dir + '/' : '';
      const filt = state.filter.toLowerCase();
      const subdirs = {}, fileRows = [];

      for (const rec of records) {
        if (state.dir && !rec.name.startsWith(prefix)) continue;
        const rel = state.dir ? rec.name.slice(prefix.length) : rec.name;
        const slash = rel.indexOf('/');
        
        if (slash === -1) {
          if (!filt || basename(rec.name).toLowerCase().includes(filt)) fileRows.push(rec);
        } else {
          const sd = rel.slice(0, slash);
          if (!filt || sd.toLowerCase().includes(filt)) subdirs[sd] = true;
        }
      }

      fileRows.sort((a,b) => basename(a.name).localeCompare(basename(b.name)));
      const sdList = Object.keys(subdirs).sort();

      if (!sdList.length && !fileRows.length) {
        emptyEl.textContent = '(empty)';
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';

      sdList.forEach(sdName => {
        const row = document.createElement('div'); row.className = 'ds-row';
        row.innerHTML = `<span class="ds-ico">${_icon('', true)}</span>
          <span class="ds-nm ds-dir">${_esc(sdName)}</span>
          <span class="ds-meta">folder</span>
          <span class="ds-acts"><button class="ds-rm">🗑</button></span>`;
        row.querySelector('.ds-nm').onclick = () => { state.dir = (state.dir ? state.dir + '/' : '') + sdName; loadFiles(); };
        row.querySelector('.ds-rm').onclick = (e) => { e.stopPropagation(); _delFolder(sdName); };
        body.insertBefore(row, dropEl);
      });

      fileRows.forEach(rec => {
        const row = document.createElement('div'); row.className = 'ds-row';
        const bname = basename(rec.name);
        row.innerHTML = `<span class="ds-ico">${_icon(bname, false)}</span>
          <span class="ds-nm" title="${_esc(rec.name)}">${_esc(bname)}</span>
          <span class="ds-meta">${_formatBytes(rec.size)} &nbsp; ${_formatDate(rec.lastModified)}</span>
          <span class="ds-acts">
            <button class="ds-pv">👁</button>
            <button class="ds-dl">⬇</button>
            <button class="ds-rm">🗑</button>
          </span>`;
        row.querySelector('.ds-pv').onclick = (e) => { e.stopPropagation(); _preview(rec); };
        row.querySelector('.ds-dl').onclick = (e) => { e.stopPropagation(); _download(rec); };
        row.querySelector('.ds-rm').onclick = (e) => { e.stopPropagation(); _delFile(rec); };
        body.insertBefore(row, dropEl);
      });

      document.getElementById('ds-cnt').textContent = `${sdList.length} dir(s), ${fileRows.length} file(s)`;
    }

    async function updateStatus() {
      const st = navigator.b2g.getDeviceStorage(volSel.value);
      document.getElementById('ds-used').textContent = 'Used: ' + _formatBytes(await st.usedSpace());
      document.getElementById('ds-free').textContent = 'Free: ' + _formatBytes(await st.freeSpace());
    }

    function _preview(rec) {
      const blob = rec.blob; 
      const url = URL.createObjectURL(blob);
      const mime = rec.type || '';
      if (mime.startsWith('image/')) pvPanel.innerHTML = `<img src="${url}">`;
      else if (mime.startsWith('video/')) pvPanel.innerHTML = `<video src="${url}" controls></video>`;
      else if (mime.startsWith('audio/')) pvPanel.innerHTML = `<audio src="${url}" controls></audio>`;
      else if (mime.startsWith('text/') || mime === 'application/json') {
        const fr = new FileReader();
        fr.onload = () => { pvPanel.innerHTML = `<pre>${_esc(String(fr.result).slice(0,5000))}</pre>`; pvPanel.style.display='block'; };
        fr.readAsText(blob);
        return;
      } else pvPanel.innerHTML = `<span style="color:#8b949e">No preview for ${_esc(mime)}</span>`;
      pvPanel.style.display = 'block';
    }

    function _download(rec) {
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement('a');
      a.href = url; a.download = basename(rec.name);
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    async function _delFile(rec) {
      if (!confirm(`Delete "${basename(rec.name)}"?`)) return;
      try {
        await navigator.b2g.getDeviceStorage(volSel.value).delete(rec.name);
        loadFiles();
      } catch(e) { alert(e.name); }
    }

    async function _delFolder(sdName) {
      if (!confirm(`Delete folder "${sdName}" and all contents?`)) return;
      const fp = (state.dir ? state.dir + '/' : '') + sdName + '/';
      const toDel = state.records.filter(r => r.name.startsWith(fp)).map(r => r.name);
      const st = navigator.b2g.getDeviceStorage(volSel.value);
      for (const p of toDel) await st.delete(p).catch(()=>{});
      loadFiles();
    }

    async function _upload(files) {
      if (!files.length) return;
      emptyEl.innerHTML = `Uploading ${files.length} file(s)...`;
      emptyEl.style.display = 'block';
      const st = navigator.b2g.getDeviceStorage(volSel.value);
      for (const file of files) {
        const path = (state.dir ? state.dir + '/' : '') + file.name;
        await st.addNamed(file, path);
      }
      loadFiles();
    }

    finput.onchange = () => { _upload(finput.files); finput.value = ''; };
    body.ondragover = (e) => { e.preventDefault(); dropEl.style.display='flex'; };
    body.ondragleave = (e) => { if (!body.contains(e.relatedTarget)) dropEl.style.display='none'; };
    body.ondrop = (e) => { e.preventDefault(); dropEl.style.display='none'; if(e.dataTransfer.files) _upload(e.dataTransfer.files); };

    volSel.onchange = () => { state.dir = ''; loadFiles(); };
    filterIn.oninput = () => renderRows(state.records);
    document.getElementById('ds-ref').onclick = loadFiles;
    document.getElementById('ds-up').onclick = () => finput.click();
    document.getElementById('ds-mkdir').onclick = async () => {
      let name = prompt('New folder name:');
      if (!name) return;
      name = name.replace(/[\/\\]/g, '_');
      const path = (state.dir ? state.dir + '/' : '') + name + '/.keep';
      await navigator.b2g.getDeviceStorage(volSel.value).addNamed(new Blob([''],{type:'text/plain'}), path);
      loadFiles();
    };
    document.getElementById('ds-close').onclick = () => {
      ov.remove();
      document.getElementById('ds-explorer-style').remove();
    };

    loadFiles();
  }

  // Launch explorer automatically if ?explorer URL parameter is present
  if (typeof document !== "undefined") {
    const param = _getExplorerParam();
    if (param !== null) {
      const launch = () => _launchExplorer(param);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', launch);
      else launch();
    }
  }

  // ── Module Exports ─────────────────────────────────────────────────────────
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { b2g, StorageRequest, FileIterable, PseudoDirectory, openExplorer: _launchExplorer };
  } else {
    // Expose global helper for easy debugging
    global.__DeviceStorageExplorer = _launchExplorer;
  }

}(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this));



if (!HTMLMediaElement.prototype.fastSeek) {
  HTMLMediaElement.prototype.fastSeek = function(time) {
    this.currentTime = time;
  };
}
