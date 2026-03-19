/**
 * KaiOS 2.5 DeviceStorage API Polyfill  v2.1.1
 * ============================================
 * Drop-in emulation of navigator.getDeviceStorage / getDeviceStorages
 * for standard browsers (Chrome, Firefox) backed by IndexedDB.
 *
 * NEW in v2.1.1:
 *   • Fixed Strict Mode TypeError (Cannot set property lastModifiedDate)
 *     by using Object.defineProperty to safely shadow prototype getters.
 *   • Native File/Blob storage in IndexedDB (Zero-RAM copies for large files)
 *   • Native File object returns (Compatible with URL.createObjectURL)
 *   • Native .onchange event handler support
 *
 * Compatible: ES5, no Arrow functions, no classes, no fetch.
 * License: MPL 2.0
 */

;(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory();
  }
}(this, function () {
  'use strict';

  /* =========================================================================
   * 0.  Guard – real KaiOS: skip polyfill, keep native
   * ===================================================================== */
  if (navigator.getDeviceStorage &&
      typeof navigator.getDeviceStorage === 'function' &&
      /KAIOS|KaiOS/i.test(navigator.userAgent || '')) {
    console.log('[DeviceStorage] Real KaiOS detected – native API active.');
    return;
  }

  /* =========================================================================
   * 1.  Debug logger
   * ===================================================================== */
  var DS_DEBUG = false;

  function DSLog() {
    if (!DS_DEBUG) { return; }
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[DS]');
    console.log.apply(console, a);
  }
  function DSWarn() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[DS][WARN]');
    console.warn.apply(console, a);
  }

  /* =========================================================================
   * 2.  Micro-Promise shim  (uses native Promise when available)
   * ===================================================================== */
  var DSPromise = (function () {
    var P = 0, F = 1, R = 2;
    function Pr(exec) {
      this._s = P; this._v = undefined; this._h = [];
      var self = this;
      try { exec(function (v) { self._res(v); }, function (r) { self._rej(r); }); }
      catch (e) { self._rej(e); }
    }
    Pr.prototype._res = function (v) {
      if (this._s !== P) { return; }
      if (v && typeof v.then === 'function') {
        var s = this;
        v.then(function (x) { s._res(x); }, function (x) { s._rej(x); });
        return;
      }
      this._s = F; this._v = v; this._fl();
    };
    Pr.prototype._rej = function (r) {
      if (this._s !== P) { return; }
      this._s = R; this._v = r; this._fl();
    };
    Pr.prototype._fl = function () {
      var h = this._h; this._h = [];
      for (var i = 0; i < h.length; i++) { this._hd(h[i]); }
    };
    Pr.prototype._hd = function (h) {
      var self = this;
      if (self._s === P) { self._h.push(h); return; }
      setTimeout(function () {
        var cb = self._s === F ? h.onF : h.onR;
        if (!cb) { (self._s === F ? h.res : h.rej)(self._v); return; }
        try { h.res(cb(self._v)); } catch (e) { h.rej(e); }
      }, 0);
    };
    Pr.prototype.then = function (onF, onR) {
      var self = this;
      return new Pr(function (res, rej) {
        self._hd({
          onF: typeof onF === 'function' ? onF : null,
          onR: typeof onR === 'function' ? onR : null,
          res: res, rej: rej
        });
      });
    };
    Pr.prototype['catch'] = function (onR) { return this.then(null, onR); };
    Pr.resolve = function (v) { return new Pr(function (r) { r(v); }); };
    Pr.reject  = function (r) { return new Pr(function (_, j) { j(r); }); };
    Pr.all = function (list) {
      return new Pr(function (res, rej) {
        if (!list || !list.length) { res([]); return; }
        var out = new Array(list.length), rem = list.length;
        for (var i = 0; i < list.length; i++) {
          (function (idx) {
            Pr.resolve(list[idx]).then(function (v) {
              out[idx] = v;
              if (--rem === 0) { res(out); }
            }, rej);
          }(i));
        }
      });
    };
    return (typeof window !== 'undefined' && window.Promise) ? window.Promise : Pr;
  }());

  /* =========================================================================
   * 3.  DOMRequest
   * ===================================================================== */
  function DOMRequest() {
    this.onsuccess  = null;
    this.onerror    = null;
    this.result     = undefined;
    this.error      = null;
    this.readyState = 'pending';
  }
  DOMRequest.prototype._fireSuccess = function (result) {
    this.result = result;
    this.readyState = 'done';
    DSLog('DOMRequest ok', result);
    if (typeof this.onsuccess === 'function') {
      try { this.onsuccess({ target: this }); } catch (e) { DSWarn('onsuccess threw', e); }
    }
  };
  DOMRequest.prototype._fireError = function (name, msg) {
    this.error = { name: name, message: msg || name };
    this.readyState = 'done';
    DSLog('DOMRequest err', name, msg);
    if (typeof this.onerror === 'function') {
      try { this.onerror({ target: this }); } catch (e) { DSWarn('onerror threw', e); }
    }
  };
  DOMRequest.prototype.then = function (onF, onR) {
    var self = this;
    return new DSPromise(function (res, rej) {
      var os = self.onsuccess, oe = self.onerror;
      self.onsuccess = function (e) { if (typeof os === 'function') { os(e); } res(self.result); };
      self.onerror   = function (e) { if (typeof oe === 'function') { oe(e); } rej(self.error); };
    }).then(onF, onR);
  };

  /* =========================================================================
   * 4.  DOMCursor
   * ===================================================================== */
  function DOMCursor(items) {
    DOMRequest.call(this);
    this._items = items || [];
    this._index = 0;
    this.done   = false;
  }
  DOMCursor.prototype = Object.create(DOMRequest.prototype);
  DOMCursor.prototype.constructor = DOMCursor;
  DOMCursor.prototype._advance = function () {
    if (this._index < this._items.length) {
      this.done = false;
      this._fireSuccess(this._items[this._index++]);
    } else {
      this.done = true;
      this.result = null;
      this.readyState = 'done';
      DSLog('DOMCursor done');
      if (typeof this.onsuccess === 'function') {
        try { this.onsuccess({ target: this }); } catch (e) { DSWarn('cursor cb threw', e); }
      }
    }
  };
  DOMCursor.prototype['continue'] = function () {
    var self = this;
    setTimeout(function () { self._advance(); }, 0);
  };

  /* =========================================================================
   * 5.  Volume registry
   * ===================================================================== */
  var VOLUME_DEFS = [
    { storageType:'sdcard',   storageName:'sdcard',   isDefault:true,  label:'Internal Storage (sdcard)'  },
    { storageType:'sdcard',   storageName:'sdcard1',  isDefault:false, label:'External SD Card (sdcard1)' },
    { storageType:'music',    storageName:'music',    isDefault:true,  label:'Music'    },
    { storageType:'videos',   storageName:'videos',   isDefault:true,  label:'Videos'   },
    { storageType:'pictures', storageName:'pictures', isDefault:true,  label:'Pictures' }
  ];

  /* =========================================================================
   * 6.  IndexedDB adapter
   * ===================================================================== */
  var _dbCache = {};

  function openDB(storageName, callback) {
    if (_dbCache[storageName]) { callback(null, _dbCache[storageName]); return; }
    var req = indexedDB.open('DS_' + storageName, 1);
    req.onupgradeneeded = function (e) {
      var db    = e.target.result;
      var store = db.createObjectStore('files', { keyPath: 'path' });
      store.createIndex('name',         'name',         { unique: false });
      store.createIndex('lastModified', 'lastModified', { unique: false });
      store.createIndex('size',         'size',         { unique: false });
    };
    req.onsuccess = function (e) {
      _dbCache[storageName] = e.target.result;
      DSLog('IDB open: DS_' + storageName);
      callback(null, _dbCache[storageName]);
    };
    req.onerror = function (e) { callback(e.target.error, null); };
  }

  function withStore(storageName, mode, callback) {
    openDB(storageName, function (err, db) {
      if (err) { callback(err); return; }
      var tx    = db.transaction(['files'], mode);
      var store = tx.objectStore('files');
      callback(null, store, tx);
    });
  }

  /* =========================================================================
   * 7.  Path helpers
   * ===================================================================== */
  function normalizePath(storageName, rawPath) {
    var p = (rawPath || '').replace(/^\/+/, '');
    var prefixes = [storageName + '/', 'sdcard/', 'sdcard1/'];
    for (var i = 0; i < prefixes.length; i++) {
      if (p.indexOf(prefixes[i]) === 0) { p = p.slice(prefixes[i].length); break; }
    }
    return p.replace(/\.\.\//g, '').replace(/\/\//g, '/');
  }

  function basename(path) { var p = path.split('/'); return p[p.length - 1]; }

  function generateUniqueName(ext) {
    return 'file_' + Date.now() + '_' +
           Math.floor(Math.random() * 0xFFFFFF).toString(16) +
           (ext ? '.' + ext : '');
  }

  function formatBytes(bytes) {
    if (!bytes) { return '0 B'; }
    var units = ['B','KB','MB','GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[Math.min(i, 3)];
  }

  function formatDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' +
           ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
           ('0' + d.getDate()).slice(-2) + ' ' +
           ('0' + d.getHours()).slice(-2) + ':' +
           ('0' + d.getMinutes()).slice(-2);
  }

  /* =========================================================================
   * 8.  Core storage operations
   * ===================================================================== */

  function _storeBlob(storageName, path, blob, mode, req) {
    if (mode === 'append') {
      withStore(storageName, 'readwrite', function (dbErr, store) {
        if (dbErr) { req._fireError('UnknownError', dbErr.message); return; }
        var gr = store.get(path);
        gr.onsuccess = function () {
          var finalBlob;
          if (gr.result && gr.result.data) {
            // Concatenate existing blob with new blob
            finalBlob = new Blob([gr.result.data, blob], { type: blob.type || 'application/octet-stream' });
          } else {
            finalBlob = blob;
          }
          var rec = {
            path: path, name: basename(path),
            type: finalBlob.type,
            size: finalBlob.size, lastModified: Date.now(), data: finalBlob
          };
          var pr = store.put(rec);
          pr.onsuccess = function () { _notifyChange(storageName, 'modified', path); req._fireSuccess(path); };
          pr.onerror   = function () { req._fireError('UnknownError', pr.error && pr.error.message); };
        };
        gr.onerror = function () { req._fireError('UnknownError', gr.error && gr.error.message); };
      });
    } else {
      withStore(storageName, 'readwrite', function (dbErr, store) {
        if (dbErr) { req._fireError('UnknownError', dbErr.message); return; }
        var rec = {
          path: path, name: basename(path),
          type: blob.type || 'application/octet-stream',
          size: blob.size, lastModified: Date.now(), data: blob // Store Blob natively
        };
        var pr = store.put(rec);
        pr.onsuccess = function () { _notifyChange(storageName, 'created', path); req._fireSuccess(path); };
        pr.onerror   = function () { req._fireError('UnknownError', pr.error && pr.error.message); };
      });
    }
  }

  /**
   * Transforms an IndexedDB record into a native HTML5 File object with
   * B2G-specific properties attached (.path and .lastModifiedDate)
   */
  function _recToFileEntry(rec) {
    var file;
    try {
      // Create a native File (supported in modern browsers)
      file = new File([rec.data], rec.name, {
        type: rec.type || 'application/octet-stream',
        lastModified: rec.lastModified
      });
    } catch (e) {
      // Fallback for extremely old environments without the File constructor
      file = new Blob([rec.data], { type: rec.type || 'application/octet-stream' });
      try { Object.defineProperty(file, 'name', { value: rec.name, enumerable: true }); } catch (ex) {}
      try { Object.defineProperty(file, 'lastModified', { value: rec.lastModified, enumerable: true }); } catch (ex) {}
    }
    
    // Safely bypass strict mode prototype getters by using defineProperty
    try {
      Object.defineProperty(file, 'lastModifiedDate', {
        value: new Date(rec.lastModified),
        enumerable: true,
        configurable: true
      });
    } catch (e) {}

    try {
      Object.defineProperty(file, 'path', {
        value: rec.path,
        enumerable: true,
        configurable: true
      });
    } catch (e) {}
    
    return file;
  }

  function _getFile(storageName, path, req) {
    withStore(storageName, 'readonly', function (err, store) {
      if (err) { req._fireError('UnknownError', err.message); return; }
      var gr = store.get(path);
      gr.onsuccess = function () {
        if (!gr.result) { req._fireError('NotFoundError', 'File not found: ' + path); return; }
        req._fireSuccess(_recToFileEntry(gr.result));
      };
      gr.onerror = function () { req._fireError('UnknownError', gr.error && gr.error.message); };
    });
  }

  function _deleteFile(storageName, path, req) {
    withStore(storageName, 'readwrite', function (err, store) {
      if (err) { req._fireError('UnknownError', err.message); return; }
      var gr = store.get(path);
      gr.onsuccess = function () {
        if (!gr.result) { req._fireError('NotFoundError', 'File not found: ' + path); return; }
        var dr = store['delete'](path);
        dr.onsuccess = function () { _notifyChange(storageName, 'deleted', path); req._fireSuccess(path); };
        dr.onerror   = function () { req._fireError('UnknownError', dr.error && dr.error.message); };
      };
      gr.onerror = function () { req._fireError('UnknownError', gr.error && gr.error.message); };
    });
  }

  function _enumerate(storageName, dirPath, opts, cursor) {
    opts    = opts    || {};
    dirPath = dirPath || '';
    if (dirPath && dirPath[dirPath.length - 1] === '/') { dirPath = dirPath.slice(0, -1); }

    var since = opts.since
      ? (opts.since instanceof Date ? opts.since.getTime() : opts.since)
      : 0;
    var filterExts = opts.filterExt
      ? (Array.isArray(opts.filterExt) ? opts.filterExt : [opts.filterExt])
      : null;

    withStore(storageName, 'readonly', function (err, store) {
      if (err) { cursor._fireError('UnknownError', err.message); return; }
      var all = [], cr = store.openCursor();
      cr.onsuccess = function () {
        var c = cr.result;
        if (c) {
          var rec    = c.value;
          var inDir  = !dirPath || rec.path === dirPath || rec.path.indexOf(dirPath + '/') === 0;
          var fresh  = !since   || rec.lastModified >= since;
          var extOk  = true;
          if (filterExts) {
            var low = rec.name.toLowerCase(); extOk = false;
            for (var i = 0; i < filterExts.length; i++) {
              if (low.slice(-filterExts[i].length) === filterExts[i].toLowerCase()) { extOk = true; break; }
            }
          }
          if (inDir && fresh && extOk) { all.push(rec); }
          c['continue']();
        } else {
          var sb = opts.sortBy || 'name', so = opts.sortOrder || 'asc';
          all.sort(function (a, b) {
            var va = sb === 'date' ? a.lastModified : sb === 'size' ? a.size : a.name.toLowerCase();
            var vb = sb === 'date' ? b.lastModified : sb === 'size' ? b.size : b.name.toLowerCase();
            return va < vb ? (so === 'asc' ? -1 : 1) : va > vb ? (so === 'asc' ? 1 : -1) : 0;
          });
          var items = all.map(function (r) { return _recToFileEntry(r); });
          cursor._items = items; cursor._index = 0;
          setTimeout(function () { cursor._advance(); }, 0);
        }
      };
      cr.onerror = function () { cursor._fireError('UnknownError', cr.error && cr.error.message); };
    });
  }

  /* Read all raw records – used by the explorer */
  function _getAllRecords(storageName, callback) {
    withStore(storageName, 'readonly', function (err, store) {
      if (err) { callback(err, null); return; }
      var all = [], cr = store.openCursor();
      cr.onsuccess = function () {
        var c = cr.result;
        if (c) { all.push(c.value); c['continue'](); }
        else   { callback(null, all); }
      };
      cr.onerror = function () { callback(cr.error, null); };
    });
  }

  function _usedSpace(storageName, req) {
    withStore(storageName, 'readonly', function (err, store) {
      if (err) { req._fireError('UnknownError', err.message); return; }
      var total = 0, cr = store.openCursor();
      cr.onsuccess = function () {
        var c = cr.result;
        if (c) { total += c.value.size || 0; c['continue'](); }
        else   { req._fireSuccess(total); }
      };
      cr.onerror = function () { req._fireError('UnknownError', cr.error && cr.error.message); };
    });
  }

  function _freeSpace(req) {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        req._fireSuccess((est.quota || 0) - (est.usage || 0));
      })['catch'](function () { req._fireSuccess(1024 * 1024 * 512); });
    } else {
      req._fireSuccess(1024 * 1024 * 512);
    }
  }

  function _available(storageName, req) {
    openDB(storageName, function (err) {
      req._fireSuccess(err ? 'unavailable' : 'available');
    });
  }

  /* =========================================================================
   * 9.  Change-event bus
   * ===================================================================== */
  var _changeListeners = {};

  function _notifyChange(storageName, operation, path) {
    var ev = { 
      storageName: storageName, 
      operation: operation,
      path: path, 
      reason: operation, // Legacy B2G uses e.reason ('created', 'modified', 'deleted')
      type: 'change' 
    };

    // 1. Notify addEventListener listeners
    var lst = _changeListeners[storageName];
    if (lst && lst.length) {
      for (var i = 0; i < lst.length; i++) {
        try { lst[i](ev); } catch (e) { DSWarn('change listener threw', e); }
      }
    }

    // 2. Notify direct instance.onchange handlers
    var instance = _instanceCache[storageName];
    if (instance && typeof instance.onchange === 'function') {
      try { instance.onchange(ev); } catch (e) { DSWarn('onchange threw', e); }
    }
  }

  /* =========================================================================
   * 10.  DeviceStorage object
   * ===================================================================== */
  function DeviceStorage(storageType, storageName, isDefault) {
    this.storageType = storageType;
    this.storageName = storageName;
    this['default']  = !!isDefault;
    this.onchange    = null; // Native callback support
  }

  DeviceStorage.prototype._path = function (raw) {
    return normalizePath(this.storageName, raw);
  };

  DeviceStorage.prototype.add = function (blob) {
    if (!blob || !(blob instanceof Blob)) {
      var r = new DOMRequest();
      setTimeout(function () { r._fireError('InvalidArgumentError', 'Expected a Blob'); }, 0);
      return r;
    }
    var ext = (blob.type || '').split('/')[1] || '';
    return this.addNamed(blob, generateUniqueName(ext));
  };

  DeviceStorage.prototype.addNamed = function (blob, raw) {
    var req = new DOMRequest();
    if (!blob || !(blob instanceof Blob)) {
      setTimeout(function () { req._fireError('InvalidArgumentError', 'Expected a Blob'); }, 0);
      return req;
    }
    if (!raw || typeof raw !== 'string') {
      setTimeout(function () { req._fireError('InvalidArgumentError', 'Expected a path string'); }, 0);
      return req;
    }
    _storeBlob(this.storageName, this._path(raw), blob, 'write', req);
    return req;
  };

  DeviceStorage.prototype.appendNamed = function (blob, raw) {
    var req = new DOMRequest();
    if (!blob || !(blob instanceof Blob)) {
      setTimeout(function () { req._fireError('InvalidArgumentError', 'Expected a Blob'); }, 0);
      return req;
    }
    _storeBlob(this.storageName, this._path(raw), blob, 'append', req);
    return req;
  };

  DeviceStorage.prototype.get = function (raw) {
    var req = new DOMRequest();
    _getFile(this.storageName, this._path(raw), req);
    return req;
  };

  DeviceStorage.prototype['delete'] = function (raw) {
    var req = new DOMRequest();
    _deleteFile(this.storageName, this._path(raw), req);
    return req;
  };

  DeviceStorage.prototype.enumerate = function (pathOrOpts, opts) {
    var dir = '', o = {};
    if (typeof pathOrOpts === 'string') {
      dir = this._path(pathOrOpts); o = opts || {};
    } else if (pathOrOpts && typeof pathOrOpts === 'object') {
      o = pathOrOpts;
    } else {
      o = opts || {};
    }
    var cursor = new DOMCursor([]);
    _enumerate(this.storageName, dir, o, cursor);
    return cursor;
  };

  DeviceStorage.prototype.freeSpace = function () {
    var req = new DOMRequest(); _freeSpace(req); return req;
  };

  DeviceStorage.prototype.usedSpace = function () {
    var req = new DOMRequest(); _usedSpace(this.storageName, req); return req;
  };

  DeviceStorage.prototype.available = function () {
    var req = new DOMRequest(); _available(this.storageName, req); return req;
  };

  DeviceStorage.prototype.addEventListener = function (type, fn) {
    if (type !== 'change') { return; }
    if (!_changeListeners[this.storageName]) { _changeListeners[this.storageName] = []; }
    if (_changeListeners[this.storageName].indexOf(fn) === -1) {
      _changeListeners[this.storageName].push(fn);
    }
  };

  DeviceStorage.prototype.removeEventListener = function (type, fn) {
    if (type !== 'change') { return; }
    var arr = _changeListeners[this.storageName];
    if (!arr) { return; }
    var i = arr.indexOf(fn);
    if (i !== -1) { arr.splice(i, 1); }
  };

  /* =========================================================================
   * 11.  navigator API installation
   * ===================================================================== */
  var _instanceCache = {};

  function _buildInstance(def) {
    if (!_instanceCache[def.storageName]) {
      _instanceCache[def.storageName] = new DeviceStorage(def.storageType, def.storageName, def.isDefault);
    }
    return _instanceCache[def.storageName];
  }

  function getDeviceStorage(type) {
    for (var i = 0; i < VOLUME_DEFS.length; i++) {
      if (VOLUME_DEFS[i].storageType === type && VOLUME_DEFS[i].isDefault) {
        return _buildInstance(VOLUME_DEFS[i]);
      }
    }
    DSWarn('getDeviceStorage: unknown type', type);
    return null;
  }

  function getDeviceStorages(type) {
    // Called with no argument → return every registered volume
    if (type === undefined || type === null || type === '') {
      var all = [];
      for (var i = 0; i < VOLUME_DEFS.length; i++) { all.push(_buildInstance(VOLUME_DEFS[i])); }
      return all;
    }
    var out = [];
    for (var j = 0; j < VOLUME_DEFS.length; j++) {
      if (VOLUME_DEFS[j].storageType === type) { out.push(_buildInstance(VOLUME_DEFS[j])); }
    }
    return out;
  }

  if (typeof navigator !== 'undefined') {
    navigator.getDeviceStorage  = getDeviceStorage;
    navigator.getDeviceStorages = getDeviceStorages;
    DSLog('DeviceStorage polyfill v2.1.1 installed.');
  }

  /* =========================================================================
   * 12.  Built-in File Explorer
   *
   *  Activated when ?explorer appears in the page URL.
   *  Value (optional) picks the starting volume / type:
   *    ?explorer            → "sdcard"
   *    ?explorer=sdcard1    → external card
   *    ?explorer=pictures   → pictures storage
   *
   *  Rendered as a full-viewport overlay injected into <body>.
   *  Can also be opened programmatically: DS.openExplorer('sdcard1')
   * ===================================================================== */

  /* -- URL parameter detection -- */
  function _getExplorerParam() {
    if (typeof location === 'undefined') { return null; }
    var search = (location.search || '').slice(1).split('&');
    for (var i = 0; i < search.length; i++) {
      var kv = search[i].split('=');
      if (kv[0] === 'explorer') {
        return kv.length > 1 && kv[1] ? decodeURIComponent(kv[1]) : 'sdcard';
      }
    }
    return null;
  }

  /* -- HTML-escape (for injected text) -- */
  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* -- Icon lookup -- */
  function _icon(name, isDir) {
    if (isDir) { return '\uD83D\uDCC1'; } /* folder */
    var ext = (name.split('.').pop() || '').toLowerCase();
    var MAP = {
      jpg:'\uD83D\uDDBC', jpeg:'\uD83D\uDDBC', png:'\uD83D\uDDBC',
      gif:'\uD83D\uDDBC', webp:'\uD83D\uDDBC', svg:'\uD83D\uDDBC',
      mp3:'\uD83C\uDFB5', ogg:'\uD83C\uDFB5', wav:'\uD83C\uDFB5',
      flac:'\uD83C\uDFB5', aac:'\uD83C\uDFB5',
      mp4:'\uD83C\uDFAC', webm:'\uD83C\uDFAC', mkv:'\uD83C\uDFAC',
      txt:'\uD83D\uDCC4', md:'\uD83D\uDCC4', json:'\uD83D\uDCC4',
      xml:'\uD83D\uDCC4', csv:'\uD83D\uDCC4',
      pdf:'\uD83D\uDCD1', zip:'\uD83D\uDCE6', gz:'\uD83D\uDCE6'
    };
    return MAP[ext] || '\uD83D\uDCC4';
  }

  /* ---- Main explorer launcher ---- */
  function _launchExplorer(startVolume) {
    /* ---- CSS ---- */
    var css = '\
#ds-ov{position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;\
  background:#0d1117;color:#c9d1d9;font-family:monospace,monospace;font-size:13px;\
  display:flex;flex-direction:column;overflow:hidden;}\
#ds-ov *{box-sizing:border-box;}\
/* toolbar */\
#ds-tb{display:flex;align-items:center;gap:6px;padding:8px 12px;\
  background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;flex-wrap:wrap;}\
#ds-tb h1{margin:0;font-size:14px;color:#58a6ff;flex:0 0 auto;}\
#ds-tb select,#ds-tb button,#ds-tb input[type=text]{\
  background:#21262d;color:#c9d1d9;border:1px solid #30363d;\
  border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;}\
#ds-tb input[type=text]{cursor:text;min-width:160px;}\
#ds-tb button:hover{background:#388bfd22;border-color:#58a6ff;}\
#ds-close{margin-left:auto;color:#f85149 !important;}\
/* breadcrumb */\
#ds-bc{padding:5px 12px;background:#0d1117;border-bottom:1px solid #21262d;\
  font-size:11px;color:#8b949e;flex-shrink:0;}\
#ds-bc span{color:#58a6ff;cursor:pointer;}\
#ds-bc span:hover{text-decoration:underline;}\
/* body */\
#ds-bd{flex:1;overflow-y:auto;position:relative;}\
/* rows */\
.ds-row{display:flex;align-items:center;gap:8px;padding:6px 12px;\
  border-bottom:1px solid #21262d;cursor:default;user-select:none;}\
.ds-row:hover{background:#161b22;}\
.ds-ico{font-size:16px;flex-shrink:0;width:22px;text-align:center;}\
.ds-nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c9d1d9;}\
.ds-nm.ds-dir{color:#58a6ff;cursor:pointer;}\
.ds-nm.ds-dir:hover{text-decoration:underline;}\
.ds-meta{font-size:11px;color:#8b949e;white-space:nowrap;flex-shrink:0;}\
.ds-acts{display:flex;gap:3px;flex-shrink:0;}\
.ds-acts button{background:transparent;border:1px solid #30363d;\
  color:#8b949e;border-radius:3px;padding:2px 5px;font-size:11px;cursor:pointer;}\
.ds-acts button:hover{color:#c9d1d9;border-color:#8b949e;}\
.ds-dl{color:#3fb950 !important;}.ds-rm{color:#f85149 !important;}.ds-pv{color:#d2a8ff !important;}\
/* empty / spinner */\
#ds-empty{text-align:center;padding:40px;color:#484f58;}\
@keyframes ds-spin{to{transform:rotate(360deg)}}\
.ds-spin{display:inline-block;width:14px;height:14px;border:2px solid #30363d;\
  border-top-color:#58a6ff;border-radius:50%;animation:ds-spin .7s linear infinite;\
  vertical-align:middle;margin-right:5px;}\
/* drop zone */\
#ds-drop{position:absolute;top:0;left:0;width:100%;height:100%;\
  background:#58a6ff22;border:3px dashed #58a6ff;display:none;\
  align-items:center;justify-content:center;font-size:18px;\
  color:#58a6ff;pointer-events:none;z-index:5;}\
/* preview */\
#ds-pv-panel{background:#0d1117;border-top:2px solid #30363d;\
  max-height:200px;overflow:auto;padding:8px 12px;flex-shrink:0;display:none;}\
#ds-pv-panel img,#ds-pv-panel video,#ds-pv-panel audio{max-width:100%;max-height:160px;display:block;}\
#ds-pv-panel pre{margin:0;font-size:11px;white-space:pre-wrap;color:#e6edf3;}\
/* status */\
#ds-st{padding:4px 12px;background:#161b22;border-top:1px solid #30363d;\
  font-size:11px;color:#8b949e;flex-shrink:0;display:flex;gap:16px;white-space:nowrap;}\
';

    var styleEl = document.createElement('style');
    styleEl.id  = 'ds-explorer-style';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    /* ---- Build skeleton ---- */
    var ov = document.createElement('div');
    ov.id  = 'ds-ov';
    ov.innerHTML =
      '<div id="ds-tb">' +
        '<h1>\uD83D\uDCBE DeviceStorage Explorer</h1>' +
        '<select id="ds-vol"></select>' +
        '<input type="text" id="ds-filter" placeholder="Filter files\u2026">' +
        '<button id="ds-ref">\u21BB Refresh</button>' +
        '<button id="ds-up">\u2B06 Upload</button>' +
        '<input type="file" id="ds-finput" multiple style="display:none">' +
        '<button id="ds-mkdir">+ Folder</button>' +
        '<button id="ds-close">\u2715 Close</button>' +
      '</div>' +
      '<div id="ds-bc"></div>' +
      '<div id="ds-bd">' +
        '<div id="ds-empty"><span class="ds-spin"></span> Loading\u2026</div>' +
        '<div id="ds-drop">Drop files to upload</div>' +
      '</div>' +
      '<div id="ds-pv-panel" id="ds-pv-panel"></div>' +
      '<div id="ds-st">' +
        '<span id="ds-cnt"></span>' +
        '<span id="ds-used"></span>' +
        '<span id="ds-free"></span>' +
      '</div>';
    document.body.appendChild(ov);

    /* ---- Refs ---- */
    var volSel   = document.getElementById('ds-vol');
    var filterIn = document.getElementById('ds-filter');
    var body     = document.getElementById('ds-bd');
    var emptyEl  = document.getElementById('ds-empty');
    var bcEl     = document.getElementById('ds-bc');
    var pvPanel  = document.getElementById('ds-pv-panel');
    var cntEl    = document.getElementById('ds-cnt');
    var usedEl   = document.getElementById('ds-used');
    var freeEl   = document.getElementById('ds-free');
    var finput   = document.getElementById('ds-finput');
    var dropEl   = document.getElementById('ds-drop');

    /* ---- Populate volume selector ---- */
    for (var vi = 0; vi < VOLUME_DEFS.length; vi++) {
      var opt = document.createElement('option');
      opt.value       = VOLUME_DEFS[vi].storageName;
      opt.textContent = VOLUME_DEFS[vi].label +
        (VOLUME_DEFS[vi].isDefault ? '' : ' \u2605');
      volSel.appendChild(opt);
    }

    /* Pick starting volume */
    var startSN = 'sdcard';
    for (var si = 0; si < VOLUME_DEFS.length; si++) {
      if (VOLUME_DEFS[si].storageName === startVolume ||
          VOLUME_DEFS[si].storageType === startVolume) {
        startSN = VOLUME_DEFS[si].storageName;
        break;
      }
    }
    volSel.value = startSN;

    /* ---- State ---- */
    var state = { dir: '', filter: '', records: [] };

    /* ---- Volume def helper ---- */
    function curDef() {
      var sn = volSel.value;
      for (var i = 0; i < VOLUME_DEFS.length; i++) {
        if (VOLUME_DEFS[i].storageName === sn) { return VOLUME_DEFS[i]; }
      }
      return VOLUME_DEFS[0];
    }

    /* ---- Breadcrumb ---- */
    function renderBC() {
      var sn = curDef().storageName;
      var segs = [{ label: '\uD83D\uDCBE ' + sn, dir: '' }];
      if (state.dir) {
        var parts = state.dir.split('/'), acc = '';
        for (var pi = 0; pi < parts.length; pi++) {
          acc += (pi ? '/' : '') + parts[pi];
          segs.push({ label: parts[pi], dir: acc });
        }
      }
      var html = '';
      for (var i = 0; i < segs.length; i++) {
        if (i > 0) { html += ' <span style="color:#484f58">/</span> '; }
        html += '<span data-d="' + _esc(segs[i].dir) + '">' + _esc(segs[i].label) + '</span>';
      }
      bcEl.innerHTML = html;
      var spans = bcEl.querySelectorAll('span[data-d]');
      for (var si2 = 0; si2 < spans.length; si2++) {
        (function (el) {
          el.onclick = function () { state.dir = el.getAttribute('data-d'); loadFiles(); };
        }(spans[si2]));
      }
    }

    /* ---- Load & render ---- */
    function loadFiles() {
      renderBC();
      pvPanel.style.display = 'none';
      emptyEl.innerHTML = '<span class="ds-spin"></span> Loading\u2026';
      emptyEl.style.display = 'block';
      _getAllRecords(curDef().storageName, function (err, recs) {
        if (err) { emptyEl.textContent = 'Error: ' + err.message; return; }
        state.records = recs;
        renderRows(recs);
        updateStatus();
      });
    }

    function renderRows(records) {
      /* Remove old rows */
      var old = body.querySelectorAll('.ds-row');
      for (var ri = 0; ri < old.length; ri++) { body.removeChild(old[ri]); }

      var prefix = state.dir ? state.dir + '/' : '';
      var filt   = state.filter.toLowerCase();
      var subdirs = {}, fileRows = [];

      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (state.dir && rec.path.indexOf(prefix) !== 0) { continue; }
        var rel   = state.dir ? rec.path.slice(prefix.length) : rec.path;
        var slash = rel.indexOf('/');
        if (slash === -1) {
          if (!filt || rec.name.toLowerCase().indexOf(filt) !== -1) { fileRows.push(rec); }
        } else {
          var sd = rel.slice(0, slash);
          if (!filt || sd.toLowerCase().indexOf(filt) !== -1) { subdirs[sd] = true; }
        }
      }

      fileRows.sort(function (a, b) {
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });
      var sdList = [];
      for (var k in subdirs) { if (Object.prototype.hasOwnProperty.call(subdirs, k)) { sdList.push(k); } }
      sdList.sort();

      if (!sdList.length && !fileRows.length) {
        emptyEl.textContent = '(empty – drag files here to upload)';
        emptyEl.style.display = 'block';
        cntEl.textContent = '0 items';
        return;
      }
      emptyEl.style.display = 'none';

      /* Render folder rows */
      for (var di = 0; di < sdList.length; di++) {
        (function (sdName) {
          var row = _mkRow([
            '<span class="ds-ico">' + _icon('', true) + '</span>',
            '<span class="ds-nm ds-dir">' + _esc(sdName) + '</span>',
            '<span class="ds-meta">folder</span>',
            '<span class="ds-acts">',
              '<button class="ds-rm" title="Delete folder">\uD83D\uDDD1</button>',
            '</span>'
          ].join(''));
          row.querySelector('.ds-nm.ds-dir').onclick = function () {
            state.dir = (state.dir ? state.dir + '/' : '') + sdName;
            loadFiles();
          };
          row.querySelector('.ds-rm').onclick = function (e) {
            e.stopPropagation();
            _delFolder(sdName);
          };
          body.insertBefore(row, dropEl);
        }(sdList[di]));
      }

      /* Render file rows */
      for (var fi = 0; fi < fileRows.length; fi++) {
        (function (rec) {
          var row = _mkRow([
            '<span class="ds-ico">' + _icon(rec.name, false) + '</span>',
            '<span class="ds-nm" title="' + _esc(rec.path) + '">' + _esc(rec.name) + '</span>',
            '<span class="ds-meta">' + formatBytes(rec.size) + '&nbsp;' + formatDate(rec.lastModified) + '</span>',
            '<span class="ds-acts">',
              '<button class="ds-pv" title="Preview">\uD83D\uDC41</button>',
              '<button class="ds-dl" title="Download">\u2B07</button>',
              '<button class="ds-rm" title="Delete">\uD83D\uDDD1</button>',
            '</span>'
          ].join(''));
          row.querySelector('.ds-pv').onclick = function (e) { e.stopPropagation(); _preview(rec); };
          row.querySelector('.ds-dl').onclick = function (e) { e.stopPropagation(); _download(rec); };
          row.querySelector('.ds-rm').onclick = function (e) { e.stopPropagation(); _delFile(rec); };
          body.insertBefore(row, dropEl);
        }(fileRows[fi]));
      }

      cntEl.textContent = sdList.length + ' folder(s), ' + fileRows.length + ' file(s)';
    }

    function _mkRow(html) {
      var d = document.createElement('div');
      d.className = 'ds-row';
      d.innerHTML = html;
      return d;
    }

    /* ---- Status bar ---- */
    function updateStatus() {
      var sn = curDef().storageName;
      var ur = new DOMRequest(); _usedSpace(sn, ur);
      ur.onsuccess = function (e) { usedEl.textContent = 'Used: ' + formatBytes(e.target.result); };
      var fr = new DOMRequest(); _freeSpace(fr);
      fr.onsuccess = function (e) { freeEl.textContent = 'Free: ' + formatBytes(e.target.result); };
    }

    /* ---- Preview ---- */
    function _preview(rec) {
      // rec is the raw IDB record; rec.data is the natively stored Blob
      var blob = rec.data; 
      var url  = URL.createObjectURL(blob);
      var mime = rec.type || '';
      if (mime.indexOf('image/') === 0) {
        pvPanel.innerHTML = '<img src="' + url + '" alt="' + _esc(rec.name) + '">';
        pvPanel.style.display = 'block';
      } else if (mime.indexOf('video/') === 0) {
        pvPanel.innerHTML = '<video src="' + url + '" controls></video>';
        pvPanel.style.display = 'block';
      } else if (mime.indexOf('audio/') === 0) {
        pvPanel.innerHTML = '<audio src="' + url + '" controls></audio>';
        pvPanel.style.display = 'block';
      } else if (mime.indexOf('text/') === 0 || mime === 'application/json') {
        var fr2 = new FileReader();
        fr2.onload = function () {
          pvPanel.innerHTML = '<pre>' + _esc(String(fr2.result).slice(0, 5000)) + '</pre>';
          pvPanel.style.display = 'block';
        };
        fr2.readAsText(blob);
      } else {
        pvPanel.innerHTML = '<span style="color:#8b949e">No preview for ' + _esc(mime || 'this type') + '</span>';
        pvPanel.style.display = 'block';
      }
    }

    /* ---- Download ---- */
    function _download(rec) {
      // rec.data is the native Blob
      var blob = rec.data;
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = rec.name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    }

    /* ---- Delete file ---- */
    function _delFile(rec) {
      if (!window.confirm('Delete "' + rec.name + '"?')) { return; }
      var req = new DOMRequest();
      _deleteFile(curDef().storageName, rec.path, req);
      req.onsuccess = function () { loadFiles(); };
      req.onerror   = function (e) { window.alert('Delete failed: ' + e.target.error.name); };
    }

    /* ---- Delete folder ---- */
    function _delFolder(sdName) {
      var fp = (state.dir ? state.dir + '/' : '') + sdName + '/';
      if (!window.confirm('Delete folder "' + sdName + '" and all its contents?')) { return; }
      var toDel = [];
      for (var i = 0; i < state.records.length; i++) {
        if (state.records[i].path.indexOf(fp) === 0) { toDel.push(state.records[i].path); }
      }
      if (!toDel.length) { return; }
      var done = 0;
      for (var di = 0; di < toDel.length; di++) {
        (function (p) {
          var req = new DOMRequest();
          _deleteFile(curDef().storageName, p, req);
          req.onsuccess = req.onerror = function () { if (++done === toDel.length) { loadFiles(); } };
        }(toDel[di]));
      }
    }

    /* ---- Upload ---- */
    function _upload(files) {
      if (!files || !files.length) { return; }
      var sn = curDef().storageName;
      var dir = state.dir;
      var total = files.length, done = 0;
      emptyEl.innerHTML = '<span class="ds-spin"></span> Uploading ' + total + ' file(s)\u2026';
      emptyEl.style.display = 'block';
      for (var i = 0; i < total; i++) {
        (function (file) {
          var path = (dir ? dir + '/' : '') + file.name;
          var req  = new DOMRequest();
          _storeBlob(sn, path, file, 'write', req);
          req.onsuccess = req.onerror = function () { if (++done === total) { loadFiles(); } };
        }(files[i]));
      }
    }

    finput.onchange = function () { _upload(finput.files); finput.value = ''; };

    /* drag-drop */
    body.addEventListener('dragover', function (e) {
      e.preventDefault(); dropEl.style.display = 'flex';
    });
    body.addEventListener('dragleave', function (e) {
      if (!body.contains(e.relatedTarget)) { dropEl.style.display = 'none'; }
    });
    body.addEventListener('drop', function (e) {
      e.preventDefault(); dropEl.style.display = 'none';
      if (e.dataTransfer && e.dataTransfer.files) { _upload(e.dataTransfer.files); }
    });

    /* ---- Toolbar wiring ---- */
    volSel.onchange = function () { state.dir = ''; pvPanel.style.display = 'none'; loadFiles(); };
    filterIn.oninput = function () { state.filter = filterIn.value; renderRows(state.records); };
    document.getElementById('ds-ref').onclick   = loadFiles;
    document.getElementById('ds-up').onclick    = function () { finput.click(); };
    document.getElementById('ds-mkdir').onclick = function () {
      var name = window.prompt('New folder name:');
      if (!name) { return; }
      name = name.replace(/[\/\\]/g, '_');
      var path = (state.dir ? state.dir + '/' : '') + name + '/.keep';
      var req  = new DOMRequest();
      _storeBlob(curDef().storageName, path,
                 new Blob([''], { type: 'text/plain' }), 'write', req);
      req.onsuccess = loadFiles;
    };
    document.getElementById('ds-close').onclick = function () {
      document.body.removeChild(ov);
      var s = document.getElementById('ds-explorer-style');
      if (s) { document.head.removeChild(s); }
    };

    /* ---- Initial load ---- */
    loadFiles();
  }

  /* -- Auto-launch if ?explorer in URL -- */
  (function () {
    var param = _getExplorerParam();
    if (param === null) { return; }
    function launch() { _launchExplorer(param); }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', launch);
    } else {
      launch();
    }
  }());

  /* =========================================================================
   * 13.  Public exports
   * ===================================================================== */
  var publicAPI = {
    getDeviceStorage  : getDeviceStorage,
    getDeviceStorages : getDeviceStorages,
    DOMRequest        : DOMRequest,
    DOMCursor         : DOMCursor,
    DeviceStorage     : DeviceStorage,
    VOLUME_DEFS       : VOLUME_DEFS,
    openExplorer      : function (vol) { _launchExplorer(vol || 'sdcard'); },
    setDebug          : function (f)   { DS_DEBUG = !!f; },
    clearStorage      : function (storageName) {
      var req = new DOMRequest();
      withStore(storageName, 'readwrite', function (err, store) {
        if (err) { req._fireError('UnknownError', err.message); return; }
        var r = store.clear();
        r.onsuccess = function () { req._fireSuccess(true); };
        r.onerror   = function () { req._fireError('UnknownError', r.error && r.error.message); };
      });
      return req;
    }
  };

  return publicAPI;
}));
