/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║       KaiOS 4.0  DeviceStorage  Polyfill  —  v2.0               ║
 * ║       navigator.b2g.getDeviceStorage()                          ║
 * ║       navigator.b2g.getDeviceStorages()                         ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  KaiOS 4.0 এ যা পরিবর্তন হয়েছে (2.5 থেকে):                    ║
 * ║   • DeviceStorage এখন navigator.b2g.* এর নিচে                  ║
 * ║   • enumerate() এর return type: DOMCursor → FileIterable        ║
 * ║   • FileIterable: async iterable + itor.next() দুটোই            ║
 * ║   • File.name এ storageName সহ full path আসে                    ║
 * ║     e.g.  /sdcard/music/song.mp3                                ║
 * ║           /sdcard1/photos/img.jpg                               ║
 * ║                                                                  ║
 * ║  Dual Storage সিমুলেশন:                                         ║
 * ║   • sdcard  → internal storage  (default: true,  isRemovable: false) ║
 * ║   • sdcard1 → external SD card  (default: false, isRemovable: true)  ║
 * ║   • getDeviceStorage()  → শুধু default storage                  ║
 * ║   • getDeviceStorages() → [internal, external] দুটোই            ║
 * ║                                                                  ║
 * ║  সব DeviceStorage Properties:                                   ║
 * ║   .storageName  .storagePath  .default  .isRemovable            ║
 * ║   .canBeMounted  .canBeFormatted  .lowDiskSpace                 ║
 * ║                                                                  ║
 * ║  সব Methods:                                                    ║
 * ║   add()  addNamed()  appendNamed()  get()  getEditable()        ║
 * ║   delete()  enumerate()  enumerateEditable()                    ║
 * ║   freeSpace()  usedSpace()  available()  storageStatus()        ║
 * ║   format()  mount()  unmount()  getRoot()                       ║
 * ║                                                                  ║
 * ║  Backend: IndexedDB                                             ║
 * ║  License: MIT                                                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  //  Real API থাকলে skip
  // ────────────────────────────────────────────────────────────────
  if (
    global.navigator &&
    global.navigator.b2g &&
    typeof global.navigator.b2g.getDeviceStorage === 'function'
  ) {
    console.info('[KaiOS Polyfill] Real DeviceStorage API found. Skipping polyfill.');
    return;
  }

  console.info('[KaiOS Polyfill v2.0] Installing…');

  // ────────────────────────────────────────────────────────────────
  //  Storage Volume সংজ্ঞা
  //  KaiOS ডিভাইসে internal = "sdcard", external SD = "sdcard1"
  //  (কিছু ডিভাইসে "extsdcard" — উভয়ই সমর্থিত)
  // ────────────────────────────────────────────────────────────────
  const VOLUME_DEFS = {
    // internal (built-in) volumes
    sdcard:   { mountPath: '/sdcard',   isRemovable: false, isDefault: true  },
    sdcard1:  { mountPath: '/sdcard1',  isRemovable: true,  isDefault: false },
    extsdcard:{ mountPath: '/extsdcard',isRemovable: true,  isDefault: false },

    // media storage areas — দুটো volume এর জন্যই থাকে
    pictures: { mountPath: '/sdcard',   isRemovable: false, isDefault: true  },
    pictures1:{ mountPath: '/sdcard1',  isRemovable: true,  isDefault: false },
    music:    { mountPath: '/sdcard',   isRemovable: false, isDefault: true  },
    music1:   { mountPath: '/sdcard1',  isRemovable: true,  isDefault: false },
    videos:   { mountPath: '/sdcard',   isRemovable: false, isDefault: true  },
    videos1:  { mountPath: '/sdcard1',  isRemovable: true,  isDefault: false },
    apps:     { mountPath: '/sdcard',   isRemovable: false, isDefault: true  },
  };

  /**
   * getDeviceStorages('sdcard') → দুটো ডিভাইস দেয়:
   *   [internal sdcard, external sdcard1]
   * getDeviceStorages('pictures') → [pictures (internal), pictures1 (external)]
   */
  const MULTI_VOLUME_MAP = {
    sdcard:   ['sdcard',    'sdcard1'],
    pictures: ['pictures',  'pictures1'],
    music:    ['music',     'music1'],
    videos:   ['videos',    'videos1'],
    apps:     ['apps'],
  };

  // MIME রেস্ট্রিকশন
  const MIME_RESTRICTIONS = {
    music:    /^audio\//,
    music1:   /^audio\//,
    pictures: /^image\//,
    pictures1:/^image\//,
    videos:   /^video\//,
    videos1:  /^video\//,
  };

  // ────────────────────────────────────────────────────────────────
  //  IndexedDB layer
  // ────────────────────────────────────────────────────────────────
  const DB_NAME    = '__kaios_devicestorage_v2__';
  const DB_VERSION = 1;
  const STORE_NAME = 'files';

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // key: "volumeName/filePath"  e.g. "sdcard/music/song.mp3"
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('volumeName',   'volumeName',   { unique: false });
          store.createIndex('lastModified', 'lastModified', { unique: false });
          store.createIndex('mimeType',     'mimeType',     { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
    return _dbPromise;
  }

  /** একটি IDB operation promise এ মোড়ানো */
  function idbOp(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let   result;
      try { result = fn(store, tx); } catch (err) { reject(err); return; }
      if (result instanceof IDBRequest) {
        result.onsuccess = () => resolve(result.result);
        result.onerror   = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror    = ()  => reject(tx.error);
      }
    }));
  }

  // ────────────────────────────────────────────────────────────────
  //  DOMRequest  (KaiOS compat)
  // ────────────────────────────────────────────────────────────────
  class DOMRequest {
    constructor() {
      this.onsuccess  = null;
      this.onerror    = null;
      this.result     = undefined;
      this.error      = null;
      this.readyState = 'pending';
    }

    // thenable — DOMRequest কে Promise.then() এ ব্যবহার করা যায়
    then(onFulfilled, onRejected) {
      return new Promise((resolve, reject) => {
        const prevSuccess = this.onsuccess;
        const prevError   = this.onerror;
        this.onsuccess = function (e) {
          if (prevSuccess) prevSuccess.call(this, e);
          resolve(this.result);
        };
        this.onerror = function (e) {
          if (prevError) prevError.call(this, e);
          reject(this.error);
        };
      }).then(onFulfilled, onRejected);
    }

    _resolve(value) {
      this.result     = value;
      this.readyState = 'done';
      if (typeof this.onsuccess === 'function') {
        this.onsuccess.call(this, { target: this });
      }
    }

    _reject(err) {
      this.error      = err instanceof Error ? err : new Error(String(err));
      this.readyState = 'done';
      if (typeof this.onerror === 'function') {
        this.onerror.call(this, { target: this });
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  //  FileIterable  (KaiOS 4.0 — replaces DOMCursor)
  //  async iterable: for-await-of + itor.next() দুটোই কাজ করে
  // ────────────────────────────────────────────────────────────────
  class FileIterable {
    constructor(fetchAll) {
      this._fetchAll = fetchAll;
    }

    /** itor.next() style */
    values() {
      return this[Symbol.asyncIterator]();
    }

    /** for-await-of style */
    [Symbol.asyncIterator]() {
      const filesPromise = this._fetchAll();
      let index = 0;
      return {
        next: async () => {
          const files = await filesPromise;
          if (index < files.length) {
            return { done: false, value: files[index++] };
          }
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; }
      };
    }
  }

  // ────────────────────────────────────────────────────────────────
  //  Helper: auto filename
  // ────────────────────────────────────────────────────────────────
  function autoName(volumeName, blob) {
    const ext = (blob.type || 'application/octet-stream').split('/')[1]
      .replace(/[^a-z0-9]/gi, '') || 'bin';
    return `${volumeName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  }

  // ────────────────────────────────────────────────────────────────
  //  Helper: KaiOS File path format
  //  real device এ:  File.name = "/sdcard/folder/file.txt"
  // ────────────────────────────────────────────────────────────────
  function buildFilePath(mountPath, filename) {
    // mountPath: "/sdcard"  filename: "music/song.mp3"
    // → "/sdcard/music/song.mp3"
    return `${mountPath}/${filename}`;
  }

  // ────────────────────────────────────────────────────────────────
  //  DeviceStorage class
  // ────────────────────────────────────────────────────────────────
  class DeviceStorage extends EventTarget {
    /**
     * @param {string}  volumeName   - 'sdcard', 'sdcard1', 'pictures', …
     * @param {object}  volumeDef    - from VOLUME_DEFS
     */
    constructor(volumeName, volumeDef) {
      super();

      // ── Read-only Properties ──────────────────────────────────
      /** storage area এর নাম (e.g. "sdcard", "sdcard1", "pictures") */
      this.storageName = volumeName;

      /** mount path (e.g. "/sdcard", "/sdcard1") — KaiOS এ storagePath */
      this.storagePath = volumeDef.mountPath;

      /** true মানে এটিই default storage (Settings > Default media location) */
      this.default = volumeDef.isDefault;

      /** SD card হলে true, internal হলে false */
      this.isRemovable = volumeDef.isRemovable;

      /** SD card removable তাই mount/unmount করা যায় */
      this.canBeMounted = volumeDef.isRemovable;

      /** SD card format করা যায় */
      this.canBeFormatted = volumeDef.isRemovable;

      /** Storage প্রায় ভর্তি হলে true — polyfill এ dynamic */
      this.lowDiskSpace = false;

      // ── Internal state ────────────────────────────────────────
      this._mountPath  = volumeDef.mountPath;
      this._mounted    = true;   // SD card simulation
      this._available  = true;   // false = SD card বের করা হয়েছে
      this._onchange   = null;

      // onchange shorthand setter
      Object.defineProperty(this, 'onchange', {
        get: () => this._onchange,
        set: (fn) => {
          if (this._onchange) this.removeEventListener('change', this._onchange);
          this._onchange = fn;
          if (fn) this.addEventListener('change', fn);
        },
        configurable: true
      });
    }

    // ── Private helpers ─────────────────────────────────────────

    _idbKey(filename) {
      // IndexedDB key: "sdcard/music/song.mp3"
      return `${this.storageName}/${filename}`;
    }

    _validateMime(blob) {
      const rule = MIME_RESTRICTIONS[this.storageName];
      if (rule && !rule.test(blob.type || '')) {
        throw new DOMException(
          `Storage "${this.storageName}" requires MIME type matching ` +
          `${rule}. Got: "${blob.type || 'none'}"`,
          'TypeMismatchError'
        );
      }
    }

    _checkAvailable() {
      if (!this._available) {
        throw new DOMException(
          `Storage "${this.storageName}" is not available (SD card removed?)`,
          'InvalidStateError'
        );
      }
    }

    _fireChange(reason, filePath) {
      const evt = new CustomEvent('change', {
        bubbles: false,
        detail:  { reason, path: filePath }
      });
      // KaiOS style: event.reason এবং event.path সরাসরি
      evt.reason = reason;
      evt.path   = filePath;
      this.dispatchEvent(evt);
    }

    /** IndexedDB record → File object (KaiOS style path) */
    _recordToFile(record) {
      const fullPath = buildFilePath(this._mountPath, record.filename);
      return new File(
        [record.data],
        fullPath,  // ← "/sdcard/music/song.mp3" — KaiOS এর মতো
        {
          type:         record.mimeType,
          lastModified: record.lastModified
        }
      );
    }

    // ═══════════════════════════════════════════════════════════
    //  WRITE METHODS
    // ═══════════════════════════════════════════════════════════

    /**
     * add(blob)
     * অটো-নাম দিয়ে file যোগ করে।
     * @returns DOMRequest → result: filename (string)
     */
    add(blob) {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          this._checkAvailable();
          this._validateMime(blob);
          const name = autoName(this.storageName, blob);
          await this._writeRecord(name, blob);
          const fullPath = buildFilePath(this._mountPath, name);
          this._fireChange('created', fullPath);
          req._resolve(fullPath);  // KaiOS তে full path ফেরত দেয়
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /**
     * addNamed(blob, name)
     * নাম নির্দিষ্ট করে file যোগ করে।
     * @returns DOMRequest → result: full path (string)
     */
    addNamed(blob, name) {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          this._checkAvailable();
          this._validateMime(blob);

          if (name.startsWith('/') || name.startsWith('../')) {
            throw new DOMException(
              'File path cannot start with "/" or "../"',
              'SecurityError'
            );
          }

          // duplicate check
          const existing = await idbOp('readonly', s => s.get(this._idbKey(name)));
          if (existing) {
            throw new DOMException(
              `File "${name}" already exists in "${this.storageName}"`,
              'PathExistsError'
            );
          }

          await this._writeRecord(name, blob);
          const fullPath = buildFilePath(this._mountPath, name);
          this._fireChange('created', fullPath);
          req._resolve(fullPath);
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /**
     * appendNamed(blob, name)
     * বিদ্যমান file এ data append করে (chunked download এর জন্য)।
     * @returns DOMRequest
     */
    appendNamed(blob, name) {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          this._checkAvailable();
          const key      = this._idbKey(name);
          const existing = await idbOp('readonly', s => s.get(key));

          if (existing) {
            // বিদ্যমান data + নতুন data একসাথে করো
            const combined  = new Blob([existing.data, blob], { type: existing.mimeType || blob.type });
            const newRecord = {
              ...existing,
              data:         combined,
              size:         combined.size,
              lastModified: Date.now()
            };
            await idbOp('readwrite', s => s.put(newRecord));
            const fullPath = buildFilePath(this._mountPath, name);
            this._fireChange('modified', fullPath);
            req._resolve(fullPath);
          } else {
            // file নেই → addNamed এর মতো করো
            await this._writeRecord(name, blob);
            const fullPath = buildFilePath(this._mountPath, name);
            this._fireChange('created', fullPath);
            req._resolve(fullPath);
          }
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /** internal: record write to IDB */
    async _writeRecord(name, blob) {
      const record = {
        key:          this._idbKey(name),
        volumeName:   this.storageName,
        filename:     name,
        size:         blob.size,
        mimeType:     blob.type || 'application/octet-stream',
        lastModified: Date.now(),
        data:         blob
      };
      await idbOp('readwrite', s => s.put(record));
      await this._updateLowDiskSpace();
    }

    // ═══════════════════════════════════════════════════════════
    //  READ METHODS
    // ═══════════════════════════════════════════════════════════

    /**
     * get(name | fullPath)
     * নাম বা full path দিয়ে file পড়ে।
     * KaiOS এ full path "/sdcard/file.txt" বা শুধু "file.txt" — দুটোই চলে
     * @returns DOMRequest → result: File
     */
    get(nameOrPath) {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          this._checkAvailable();
          const name = this._normalizeName(nameOrPath);
          const record = await idbOp('readonly', s => s.get(this._idbKey(name)));
          if (!record) {
            throw new DOMException(`File "${name}" not found in "${this.storageName}"`, 'NotFoundError');
          }
          req._resolve(this._recordToFile(record));
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /**
     * getEditable(name)
     * Editable File ফেরত দেয়।
     * নোট: ব্রাউজারে FileHandle API নেই, তাই File ই দেওয়া হয়
     * @returns DOMRequest → result: File
     */
    getEditable(nameOrPath) {
      return this.get(nameOrPath);
    }

    // ═══════════════════════════════════════════════════════════
    //  DELETE
    // ═══════════════════════════════════════════════════════════

    /**
     * delete(name | fullPath)
     * @returns DOMRequest → result: true
     */
    delete(nameOrPath) {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          this._checkAvailable();
          const name = this._normalizeName(nameOrPath);
          const key  = this._idbKey(name);
          const r    = await idbOp('readonly', s => s.get(key));
          if (!r) {
            throw new DOMException(`File "${name}" not found in "${this.storageName}"`, 'NotFoundError');
          }
          await idbOp('readwrite', s => s.delete(key));
          const fullPath = buildFilePath(this._mountPath, name);
          this._fireChange('deleted', fullPath);
          await this._updateLowDiskSpace();
          req._resolve(true);
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    // ═══════════════════════════════════════════════════════════
    //  ENUMERATE  (KaiOS 4.0: FileIterable, not DOMCursor)
    // ═══════════════════════════════════════════════════════════

    /**
     * enumerate([path], [options])
     * options.since → Date object (এই তারিখের পর modified ফাইল)
     * @returns FileIterable (async iterable)
     *
     * KaiOS 4.0 তে File.name এ full path আসে:
     *   /sdcard/music/song.mp3
     *   /sdcard1/pictures/photo.jpg
     */
    enumerate(pathOrOptions, options) {
      const { path, opts } = _parseEnumArgs(pathOrOptions, options);
      return new FileIterable(async () => {
        this._checkAvailable();
        return this._getFileList(path, opts);
      });
    }

    /**
     * enumerateEditable([path], [options])
     * @returns FileIterable
     */
    enumerateEditable(pathOrOptions, options) {
      // ব্রাউজারে FileHandle নেই, তাই enumerate এর মতোই
      return this.enumerate(pathOrOptions, options);
    }

    /** সব file এর list বের করে */
    async _getFileList(subPath, opts) {
      const db = await openDB();
      const records = await new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const idx = tx.objectStore(STORE_NAME).index('volumeName');
        const r   = idx.getAll(IDBKeyRange.only(this.storageName));
        r.onsuccess = () => resolve(r.result);
        r.onerror   = () => reject(r.error);
      });

      let filtered = records;

      // subPath ফিল্টার
      if (subPath) {
        const prefix = subPath.endsWith('/') ? subPath : subPath + '/';
        filtered = filtered.filter(r => r.filename.startsWith(prefix));
      }

      // since ফিল্টার
      if (opts && opts.since instanceof Date) {
        filtered = filtered.filter(r => r.lastModified >= opts.since.getTime());
      }

      // File object তৈরি — KaiOS 4.0 style path সহ
      return filtered.map(r => this._recordToFile(r));
    }

    // ═══════════════════════════════════════════════════════════
    //  SPACE INFO
    // ═══════════════════════════════════════════════════════════

    /**
     * freeSpace()
     * @returns DOMRequest → result: bytes (number)
     */
    freeSpace() {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          let free;
          if (navigator.storage && navigator.storage.estimate) {
            const { quota, usage } = await navigator.storage.estimate();
            // external SD: simulate 32GB card
            free = this.isRemovable
              ? Math.max(0, 32 * 1024 * 1024 * 1024 - await this._calcUsed())
              : Math.max(0, quota - usage);
          } else {
            free = this.isRemovable
              ? 32 * 1024 * 1024 * 1024
              : 4  * 1024 * 1024 * 1024;
          }
          req._resolve(free);
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /**
     * usedSpace()
     * @returns DOMRequest → result: bytes (number)
     */
    usedSpace() {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        try {
          req._resolve(await this._calcUsed());
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    async _calcUsed() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const idx = tx.objectStore(STORE_NAME).index('volumeName');
        const r   = idx.getAll(IDBKeyRange.only(this.storageName));
        r.onsuccess = () => resolve(r.result.reduce((sum, rec) => sum + (rec.size || 0), 0));
        r.onerror   = () => reject(r.error);
      });
    }

    async _updateLowDiskSpace() {
      try {
        const used = await this._calcUsed();
        const limit = this.isRemovable ? 32 * 1024 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
        this.lowDiskSpace = (limit - used) < 30 * 1024 * 1024; // < 30MB free
      } catch (_) {}
    }

    // ═══════════════════════════════════════════════════════════
    //  STATUS / MOUNT
    // ═══════════════════════════════════════════════════════════

    /**
     * available()
     * @returns DOMRequest → result: 'available' | 'unavailable' | 'shared'
     */
    available() {
      const req = new DOMRequest();
      Promise.resolve().then(() => {
        if (!this._available) {
          req._resolve('unavailable');
        } else if (!this._mounted) {
          req._resolve('shared'); // USB সংযুক্ত
        } else {
          req._resolve('available');
        }
      });
      return req;
    }

    /**
     * storageStatus()
     * available() এর alias (KaiOS কিছু version এ)
     */
    storageStatus() {
      return this.available();
    }

    /**
     * mount() — SD card mount করো (simulation)
     * @returns DOMRequest
     */
    mount() {
      const req = new DOMRequest();
      Promise.resolve().then(() => {
        this._mounted   = true;
        this._available = true;
        this._fireChange('created', this._mountPath + '/');
        req._resolve(true);
      });
      return req;
    }

    /**
     * unmount() — SD card unmount করো (simulation)
     * @returns DOMRequest
     */
    unmount() {
      const req = new DOMRequest();
      Promise.resolve().then(() => {
        if (!this.canBeMounted) {
          req._reject(new DOMException('Internal storage cannot be unmounted.', 'InvalidAccessError'));
          return;
        }
        this._mounted = false;
        req._resolve(true);
      });
      return req;
    }

    /**
     * format() — SD card format করো (simulation: সব file মুছে)
     * @returns DOMRequest
     */
    format() {
      const req = new DOMRequest();
      Promise.resolve().then(async () => {
        if (!this.canBeFormatted) {
          req._reject(new DOMException('Internal storage cannot be formatted.', 'InvalidAccessError'));
          return;
        }
        try {
          const db = await openDB();
          await new Promise((resolve, reject) => {
            const tx  = db.transaction(STORE_NAME, 'readwrite');
            const idx = tx.objectStore(STORE_NAME).index('volumeName');
            const r   = idx.getAllKeys(IDBKeyRange.only(this.storageName));
            r.onsuccess = () => {
              r.result.forEach(k => tx.objectStore(STORE_NAME).delete(k));
              tx.oncomplete = resolve;
              tx.onerror    = () => reject(tx.error);
            };
            r.onerror = () => reject(r.error);
          });
          this.lowDiskSpace = false;
          req._resolve(true);
        } catch (e) { req._reject(e); }
      });
      return req;
    }

    /**
     * getRoot()
     * Storage এর root directory এর path ফেরত দেয়
     * @returns DOMRequest → result: string (path)
     */
    getRoot() {
      const req = new DOMRequest();
      Promise.resolve().then(() => req._resolve(this._mountPath));
      return req;
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * name normalize করে:
     *   "/sdcard/music/song.mp3" → "music/song.mp3"
     *   "music/song.mp3"        → "music/song.mp3"
     */
    _normalizeName(nameOrPath) {
      const prefix = this._mountPath + '/';
      if (nameOrPath.startsWith(prefix)) {
        return nameOrPath.slice(prefix.length);
      }
      // "/sdcard1/..." format এ আসলে volume prefix বাদ দাও
      if (nameOrPath.startsWith('/')) {
        const parts = nameOrPath.split('/').filter(Boolean);
        // first part = volume name, rest = path
        return parts.slice(1).join('/');
      }
      return nameOrPath;
    }

    /** Debug: সব file দেখাও */
    async _debug_listAll() {
      const files = await this._getFileList(null, {});
      console.table(files.map(f => ({ name: f.name, size: f.size, type: f.type })));
      return files;
    }
  }

  // ────────────────────────────────────────────────────────────────
  //  Shared helper: enumerate args parse
  // ────────────────────────────────────────────────────────────────
  function _parseEnumArgs(pathOrOptions, options) {
    if (typeof pathOrOptions === 'string') {
      return { path: pathOrOptions, opts: options || {} };
    }
    if (pathOrOptions && typeof pathOrOptions === 'object') {
      return { path: null, opts: pathOrOptions };
    }
    return { path: null, opts: {} };
  }

  // ────────────────────────────────────────────────────────────────
  //  Instance cache (singleton per volumeName)
  // ────────────────────────────────────────────────────────────────
  const _instances = {};

  function getInstance(volumeName) {
    if (!_instances[volumeName]) {
      const def = VOLUME_DEFS[volumeName];
      if (!def) {
        // অজানা volume → sdcard এর মতো treat করো
        console.warn(`[KaiOS Polyfill] Unknown volume: "${volumeName}". Using sdcard defaults.`);
        _instances[volumeName] = new DeviceStorage(volumeName, {
          mountPath:   `/${volumeName}`,
          isRemovable: false,
          isDefault:   true
        });
      } else {
        _instances[volumeName] = new DeviceStorage(volumeName, def);
      }
    }
    return _instances[volumeName];
  }

  // ────────────────────────────────────────────────────────────────
  //  SD Card simulation helpers (test এর জন্য)
  // ────────────────────────────────────────────────────────────────
  function _simulateSDCardInsert() {
    const ext = getInstance('sdcard1');
    ext._available = true;
    ext._mounted   = true;
    ext._fireChange('created', '/sdcard1/');
    console.info('[KaiOS Polyfill] SD card inserted (simulated)');
  }

  function _simulateSDCardRemove() {
    const ext = getInstance('sdcard1');
    ext._available = false;
    ext._mounted   = false;
    ext._fireChange('deleted', '/sdcard1/');
    console.info('[KaiOS Polyfill] SD card removed (simulated)');
  }

  // ────────────────────────────────────────────────────────────────
  //  navigator.b2g ইনস্টল
  // ────────────────────────────────────────────────────────────────
  if (!global.navigator.b2g) {
    Object.defineProperty(global.navigator, 'b2g', {
      value: Object.create(null),
      writable: false,
      configurable: true
    });
  }

  /**
   * navigator.b2g.getDeviceStorage(storageName)
   *
   * → default storage এর DeviceStorage object ফেরত দেয়
   *   (যেটার .default === true)
   *
   * KaiOS 4.0: navigator.b2g.* এর নিচে
   */
  global.navigator.b2g.getDeviceStorage = function (storageName) {
    const volumes = MULTI_VOLUME_MAP[storageName];
    if (!volumes) {
      console.warn(`[KaiOS Polyfill] Unknown storageName: "${storageName}"`);
      return getInstance(storageName);
    }
    // default volume খোঁজো
    const defaultVol = volumes.find(v => VOLUME_DEFS[v] && VOLUME_DEFS[v].isDefault) || volumes[0];
    return getInstance(defaultVol);
  };

  /**
   * navigator.b2g.getDeviceStorages(storageName)
   *
   * → DeviceStorage[] — সব physical storage area
   *   internal + external SD card দুটোই
   *
   * উদাহরণ:
   *   getDeviceStorages('sdcard') → [sdcard_instance, sdcard1_instance]
   *   প্রথমটি internal (default:true), দ্বিতীয়টি external (default:false)
   */
  global.navigator.b2g.getDeviceStorages = function (storageName) {
    const volumes = MULTI_VOLUME_MAP[storageName] || [storageName];
    return volumes.map(v => getInstance(v));
  };

  // ── KaiOS 2.5 / 3.0 compat: navigator.* (b2g ছাড়া) ────────────
  if (!global.navigator.getDeviceStorage) {
    global.navigator.getDeviceStorage  = global.navigator.b2g.getDeviceStorage;
    global.navigator.getDeviceStorages = global.navigator.b2g.getDeviceStorages;
  }

  // ────────────────────────────────────────────────────────────────
  //  DeviceStorageChangeEvent global class
  // ────────────────────────────────────────────────────────────────
  class DeviceStorageChangeEvent extends CustomEvent {
    constructor(type, init = {}) {
      super(type, { bubbles: false, ...init });
      /** 'created' | 'modified' | 'deleted' */
      this.reason = init.reason || '';
      /** full file path: "/sdcard/music/song.mp3" */
      this.path   = init.path   || '';
    }
  }
  global.DeviceStorageChangeEvent = DeviceStorageChangeEvent;

  // ────────────────────────────────────────────────────────────────
  //  Public debug/test API
  // ────────────────────────────────────────────────────────────────
  global.__KaiOSPolyfill__ = {
    version: '2.0.0',
    backend: 'IndexedDB',

    /** সব virtual storage ক্লিয়ার */
    clearAll: async () => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear().onsuccess = () => {
          console.info('[KaiOS Polyfill] All storage cleared.');
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    },

    /** নির্দিষ্ট volume এর সব ফাইল দেখাও */
    listAll: async (volumeName = 'sdcard') => {
      return getInstance(volumeName)._debug_listAll();
    },

    /** SD card ঢোকানো simulate করো */
    insertSDCard: _simulateSDCardInsert,

    /** SD card বের করা simulate করো */
    removeSDCard: _simulateSDCardRemove,

    /** সব volume এর instance দেখাও */
    instances: _instances,

    /** Volume সংজ্ঞা */
    volumes: VOLUME_DEFS,
  };

  // ────────────────────────────────────────────────────────────────
  //  Startup log
  // ────────────────────────────────────────────────────────────────
  console.info(
    '%c[KaiOS DevStorage Polyfill v2.0]%c Ready!\n' +
    '  API     : navigator.b2g.getDeviceStorage()\n' +
    '  API     : navigator.b2g.getDeviceStorages() → [internal, external]\n' +
    '  Volumes : sdcard (internal) + sdcard1 (external SD)\n' +
    '  File.name: /sdcard/path/file.ext  (KaiOS style)\n' +
    '  KaiOS 4.0: enumerate() → FileIterable (async iterable)\n' +
    '  Debug   : window.__KaiOSPolyfill__\n' +
    '  SD sim  : __KaiOSPolyfill__.insertSDCard() / removeSDCard()',
    'color:#00d4aa;font-weight:bold;font-size:13px',
    'color:#8899aa'
  );

})(typeof globalThis !== 'undefined' ? globalThis : window);
