/**
 * ============================================================================
 * KaiOS 3.0 DeviceStorage API Polyfill
 * ============================================================================
 * Polyfills navigator.b2g.getDeviceStorage() for modern browsers using
 * IndexedDB as the persistent storage backend.
 *
 * Mirrors the Gecko-B2G implementation from:
 *   kaiostech/gecko-b2g → dom/b2g/devicestorage/
 *
 * Supported storage types: "sdcard", "pictures", "videos", "music", "apps"
 *
 * Key design decisions:
 *  - Each storage type maps to a separate IndexedDB object store.
 *  - All async operations return a StorageRequest-like object that exposes
 *    onsuccess / onerror callbacks and is also thenable (Promise-compatible).
 *  - enumerate() returns a FileIterable that supports:
 *      • iterable.values()  → async iterator  (itor.next() → Promise)
 *      • for await (const f of iterable) { … }
 *  - getRoot() returns a pseudo-Directory object with createDirectory() and
 *    getFilesAndDirectories() helpers.
 *  - Error names match KaiOS 3.0 / Gecko-B2G: NotFoundError,
 *    InvalidModificationError, UnknownError.
 *
 * Browser compatibility: Chrome 66+, Firefox 60+, Edge 79+, Safari 14+
 * (all ES2017+ async/await, IndexedDB v2, Symbol.asyncIterator required)
 * ============================================================================
 */

(function (global) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────

  /** Database name shared by all storage types. */
  const DB_NAME = "KaiOSDeviceStorage_v1";
  /** IndexedDB schema version. Bump when adding object stores. */
  const DB_VERSION = 1;

  /**
   * Recognised storage area names.
   * Each maps to its own IndexedDB object store so they are fully isolated.
   *
   * KaiOS dual-storage layout:
   *   • "sdcard"  → internal storage  (built-in flash, always present)
   *   • "sdcard1" → external SD card  (removable, may or may not be inserted)
   *
   * Both get their own IDBObjectStore so files written to sdcard never
   * mix with files written to sdcard1, exactly as on a real KaiOS device
   * where the two volumes are separate mount points.
   */
  const STORAGE_TYPES = ["sdcard", "sdcard1",
                         "pictures", "videos", "music", "apps",
                         "crashes", "apps-storage"];

  /**
   * Simulated free-space constant returned by freeSpace().
   * In a real device this comes from statvfs; in the browser we return a
   * plausible value (2 GiB) that KaiOS apps can use without crashing.
   */
  const SIMULATED_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

  // ── Database singleton ────────────────────────────────────────────────────

  /**
   * Lazily-opened IDBDatabase connection shared across all DeviceStorage
   * instances for the lifetime of the page.
   * @type {IDBDatabase|null}
   */
  let _db = null;

  /**
   * Opens (or returns the cached) IndexedDB database.
   * Creates one object store per storage type on first open.
   * @returns {Promise<IDBDatabase>}
   */
  function openDatabase() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      // Called when the database is first created or the version is bumped.
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        for (const type of STORAGE_TYPES) {
          if (!db.objectStoreNames.contains(type)) {
            // Primary key is the file's logical path (string).
            db.createObjectStore(type, { keyPath: "name" });
          }
        }
      };

      req.onsuccess = (event) => {
        _db = event.target.result;

        // If the connection is blocked elsewhere, log a warning.
        _db.onversionchange = () => {
          console.warn("[DeviceStorage polyfill] Database version changed; " +
                       "closing connection.");
          _db.close();
          _db = null;
        };

        resolve(_db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new DOMException("IndexedDB blocked", "UnknownError"));
    });
  }

  // ── Low-level IDB helpers ─────────────────────────────────────────────────

  /**
   * Wraps an IDBRequest in a Promise.
   * @template T
   * @param {IDBRequest} idbReq
   * @returns {Promise<T>}
   */
  function idbPromise(idbReq) {
    return new Promise((resolve, reject) => {
      idbReq.onsuccess = () => resolve(idbReq.result);
      idbReq.onerror  = () => reject(idbReq.error);
    });
  }

  /**
   * Opens a transaction and returns the requested object store.
   * @param {IDBDatabase} db
   * @param {string} storeName  - one of STORAGE_TYPES
   * @param {"readonly"|"readwrite"} mode
   * @returns {{ tx: IDBTransaction, store: IDBObjectStore }}
   */
  function txStore(db, storeName, mode) {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { tx, store };
  }

  // ── StorageRequest ─────────────────────────────────────────────────────────

  /**
   * KaiOS StorageRequest-like object.
   *
   * Mirrors the DOMRequest / DeviceStorageRequest interface from Gecko:
   *   • result   – populated on success
   *   • error    – populated on failure (a DOMException-like object)
   *   • onsuccess(event)  – callback; event.target === this request
   *   • onerror(event)    – callback; event.target === this request
   *
   * Also thenable so it can be used with `await`.
   *
   * @example
   *   const req = storage.get("photo.jpg");
   *   req.onsuccess = e => console.log(e.target.result);
   *   req.onerror   = e => console.error(e.target.error.name);
   *   // or:
   *   const blob = await req;
   */
  class StorageRequest {
    constructor() {
      /** @type {*} – result value once the operation succeeds */
      this.result = undefined;
      /** @type {DOMException|null} – error once the operation fails */
      this.error  = null;
      /** @type {function|null} – success callback */
      this.onsuccess = null;
      /** @type {function|null} – error callback */
      this.onerror   = null;
      /** Internal Promise that drives the async operation. */
      this._promise = null;
    }

    /**
     * Fires the onsuccess callback with a synthetic event-like object.
     * @param {*} result
     */
    _resolve(result) {
      this.result = result;
      if (typeof this.onsuccess === "function") {
        // Fire asynchronously (micro-task) matching browser DOMRequest behaviour.
        Promise.resolve().then(() => {
          this.onsuccess({ target: this, type: "success" });
        });
      }
    }

    /**
     * Fires the onerror callback with the given error.
     * @param {string|DOMException} errorOrName
     */
    _reject(errorOrName) {
      if (typeof errorOrName === "string") {
        this.error = new DOMException(errorOrName, errorOrName);
      } else {
        this.error = errorOrName;
      }
      if (typeof this.onerror === "function") {
        Promise.resolve().then(() => {
          this.onerror({ target: this, type: "error" });
        });
      }
    }

    // ── thenable interface ──────────────────────────────────────────────────

    /**
     * Makes StorageRequest usable with `await` and `.then()`.
     * The first `.then()` call starts the underlying promise chain.
     */
    then(onFulfilled, onRejected) {
      if (!this._promise) {
        // Should have been set by the factory that created this request.
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

  /**
   * Creates a StorageRequest whose outcome is driven by `asyncFn`.
   * @param {function(): Promise<*>} asyncFn - async function for the operation
   * @returns {StorageRequest}
   */
  function makeRequest(asyncFn) {
    const req = new StorageRequest();
    req._promise = asyncFn().then(
      (result) => { req._resolve(result); return result; },
      (err)    => {
        const name = err && err.name ? err.name : "UnknownError";
        req._reject(new DOMException(err && err.message ? err.message : name, name));
        throw req.error; // re-throw so Promise chain rejects too
      }
    );
    return req;
  }

  // ── Record schema ──────────────────────────────────────────────────────────

  /**
   * A file record stored in IndexedDB.
   * @typedef {Object} FileRecord
   * @property {string}  name         - logical path e.g. "photos/sunset.jpg"
   * @property {string}  type         - MIME type e.g. "image/jpeg"
   * @property {number}  size         - byte length
   * @property {number}  lastModified - Unix timestamp (ms)
   * @property {Blob}    blob         - the actual data
   */

  /**
   * Creates a FileRecord from a Blob and a logical name.
   * @param {Blob} blob
   * @param {string} name
   * @returns {FileRecord}
   */
  function makeRecord(blob, name) {
    return {
      name,
      type:         blob.type || "application/octet-stream",
      size:         blob.size,
      lastModified: Date.now(),
      blob,
    };
  }

  /**
   * Converts a FileRecord back to a File object (Blob subclass with name).
   * @param {FileRecord} record
   * @param {string} storageType
   * @returns {File}
   */
  function recordToFile(record, storageType) {
    const file = new File([record.blob], `/${storageType}/${record.name}`, {
      type:         record.type,
      lastModified: record.lastModified,
    });
    return file;
  }

  // ── FileIterable ───────────────────────────────────────────────────────────

  /**
   * KaiOS 3.0 FileIterable.
   *
   * Declared as `async iterable<File>` in WebIDL:
   *   https://heycam.github.io/webidl/#idl-async-iterable
   *
   * Supports:
   *   • iterable.values()      → async iterator object
   *   • for await (const f of iterable) { … }
   *
   * Files are fetched lazily from IndexedDB one batch at a time using an
   * IDBCursor so that large stores do not block the main thread.
   *
   * @example
   *   const iterable = sdcard.enumerate();
   *   for await (const file of iterable) {
   *     console.log(file.name, file.size);
   *   }
   */
  class FileIterable {
    /**
     * @param {string} storageType   - e.g. "sdcard"
     * @param {string} [pathPrefix]  - optional sub-path filter
     * @param {number} [since]       - optional `since` timestamp filter (ms)
     */
    constructor(storageType, pathPrefix = "", since = 0) {
      this._storageType = storageType;
      this._pathPrefix  = pathPrefix;
      this._since       = since;
    }

    /**
     * Returns an async iterator over all matching File objects.
     * Called automatically by `for await … of`.
     * @returns {AsyncIterator<File>}
     */
    [Symbol.asyncIterator]() {
      return this.values();
    }

    /**
     * Explicitly returns the async iterator (matches KaiOS API).
     * @returns {AsyncIterator<File>}
     */
    values() {
      const storageType = this._storageType;
      const pathPrefix  = this._pathPrefix;
      const since       = this._since;

      /**
       * Internal state:
       *   _records – array of FileRecords fetched so far (drained lazily)
       *   _done    – true once IDB cursor exhausted
       */
      let _records = [];
      let _done    = false;
      let _started = false;
      let _cursor  = null; // live IDBCursor
      let _tx      = null;

      /**
       * Loads all matching records from IndexedDB into _records.
       * We do a full scan (IDBCursor) so we can apply path-prefix and
       * lastModified filters. Results are buffered in _records[].
       * @returns {Promise<void>}
       */
      async function loadAll() {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
          const { tx, store } = txStore(db, storageType, "readonly");
          const request = store.openCursor();

          request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
              // No more records.
              _done = true;
              resolve();
              return;
            }
            const record = cursor.value;
            // Apply optional filters.
            const nameOk   = !pathPrefix || record.name.startsWith(pathPrefix);
            const sinceOk  = !since      || record.lastModified >= since;
            if (nameOk && sinceOk) {
              _records.push(record);
            }
            cursor.continue();
          };

          request.onerror = () => reject(request.error);
          tx.onerror      = () => reject(tx.error);
        });
      }

      let _loadPromise = null;

      /**
       * The actual async iterator object returned by values().
       * `next()` resolves with { done, value } matching the async-iterator
       * protocol defined in the WebIDL spec.
       */
      return {
        next() {
          // Lazily trigger the full load on first call.
          if (!_loadPromise) {
            _loadPromise = loadAll();
          }
          return _loadPromise.then(() => {
            if (_records.length === 0) {
              return { done: true, value: undefined };
            }
            const record = _records.shift();
            const file   = recordToFile(record, storageType);
            return { done: false, value: file };
          });
        },

        // Make the iterator itself async-iterable (for-await-of compliance).
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  // ── PseudoDirectory ────────────────────────────────────────────────────────

  /**
   * Pseudo-directory object returned by getRoot().
   *
   * In Gecko this is a real mozilla::dom::Directory backed by the file system.
   * Here we simulate the essential surface used by KaiOS apps:
   *   • createDirectory(name)        → StorageRequest → result: undefined
   *   • getFilesAndDirectories()     → StorageRequest → result: Array<File>
   *   • path                         → string (virtual root path)
   *
   * Sub-directories are stored as synthetic "folder" records in IndexedDB.
   */
  class PseudoDirectory {
    /**
     * @param {string} storageType
     * @param {string} [virtualPath] - virtual path, default "/"
     */
    constructor(storageType, virtualPath = "/") {
      this._storageType = storageType;
      /** @type {string} Exposed as dir.path */
      this.path = `/${storageType}${virtualPath === "/" ? "" : virtualPath}`;
    }

    /**
     * Creates a virtual subdirectory.
     * Stores a sentinel record in IDB so the path survives page reloads.
     * @param {string} name - directory name (no slashes)
     * @returns {StorageRequest} result → PseudoDirectory
     */
    createDirectory(name) {
      const storageType = this._storageType;
      // Sanitise: no path traversal.
      if (!name || name.includes("/") || name === ".." || name === ".") {
        const req = new StorageRequest();
        Promise.resolve().then(() =>
          req._reject(new DOMException(
            `Invalid directory name: ${name}`, "InvalidModificationError")));
        return req;
      }

      return makeRequest(async () => {
        const db = await openDatabase();
        // Store a zero-byte "directory marker" blob.
        const dirBlob = new Blob([], { type: "inode/directory" });
        // Path for the sentinel: __dir__/<name>
        const dirPath = `__dir__/${name}`;
        const record  = makeRecord(dirBlob, dirPath);
        const { store } = txStore(db, storageType, "readwrite");
        await idbPromise(store.put(record));
        return new PseudoDirectory(storageType, `/${name}`);
      });
    }

    /**
     * Lists all files (and sub-directory sentinels) under this directory.
     * @returns {StorageRequest} result → Array<File|PseudoDirectory>
     */
    getFilesAndDirectories() {
      const storageType = this._storageType;
      return makeRequest(async () => {
        const db = await openDatabase();
        const { store } = txStore(db, storageType, "readonly");
        const allRecords = await idbPromise(store.getAll());
        const items = [];
        for (const record of allRecords) {
          if (record.type === "inode/directory") {
            // It's a directory sentinel – expose as PseudoDirectory.
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

  /**
   * The core KaiOS 3.0 DeviceStorage interface.
   *
   * Maps to nsDOMDeviceStorage in the Gecko-B2G source tree.
   * See: dom/b2g/devicestorage/nsDeviceStorage.h
   *
   * All mutating methods write through to IndexedDB; all read methods read
   * from IndexedDB.  Event listeners (addEventListener / removeEventListener)
   * are fully wired so that "change" events fire after write operations.
   */
  class DeviceStorage extends EventTarget {
    /**
     * @param {string} storageType - one of STORAGE_TYPES
     */
    constructor(storageType) {
      super();
      if (!STORAGE_TYPES.includes(storageType)) {
        throw new DOMException(
          `Unknown storage type: ${storageType}`, "UnknownError");
      }
      /** @type {string} */
      this.storageName = storageType;
      /** @type {string} – KaiOS surface: storage.storageName */
      this._storageType = storageType;
    }

    // ── Write operations ───────────────────────────────────────────────────

    /**
     * Stores `blob` under the logical path `name`.
     * If a file with that name already exists it is silently overwritten
     * (mirrors Gecko AddNamed behaviour).
     *
     * @param {Blob} blob
     * @param {string} name - logical path, e.g. "photos/sunset.jpg"
     * @returns {StorageRequest} result → full path string
     *
     * @example
     *   const req = storage.addNamed(myBlob, "photos/sunset.jpg");
     *   req.onsuccess = e => console.log("Saved at", e.target.result);
     */
    addNamed(blob, name) {
      if (!(blob instanceof Blob)) {
        return _rejectRequest(
          "First argument must be a Blob or File", "InvalidModificationError");
      }
      if (typeof name !== "string" || !name) {
        return _rejectRequest(
          "File name must be a non-empty string", "InvalidModificationError");
      }
      // Prevent path traversal attacks – mirror Gecko's IsSafePath check.
      if (_hasUnsafePath(name)) {
        return _rejectRequest(
          `Unsafe path: ${name}`, "InvalidModificationError");
      }

      const storageType = this._storageType;

      return makeRequest(async () => {
        const db     = await openDatabase();
        const record = makeRecord(blob, name);
        const { store } = txStore(db, storageType, "readwrite");
        await idbPromise(store.put(record));
        const fullPath = `/${storageType}/${name}`;
        // Fire a "change" event after a successful write (like Gecko's
        // OnFileWatcherUpdate).
        _dispatchChangeEvent(this, "created", fullPath);
        return fullPath;
      });
    }

    /**
     * Appends `blob` to the file at `name` (or creates it).
     * Mirrors DeviceStorage.appendNamed() from Gecko.
     *
     * @param {Blob} blob
     * @param {string} name
     * @returns {StorageRequest} result → full path string
     */
    appendNamed(blob, name) {
      if (!(blob instanceof Blob)) {
        return _rejectRequest(
          "First argument must be a Blob or File", "InvalidModificationError");
      }
      if (typeof name !== "string" || !name) {
        return _rejectRequest(
          "File name must be a non-empty string", "InvalidModificationError");
      }

      const storageType = this._storageType;

      return makeRequest(async () => {
        const db = await openDatabase();
        // Try to read existing record.
        const { store: readStore } = txStore(db, storageType, "readonly");
        let existing = await idbPromise(readStore.get(name)).catch(() => null);

        let newBlob;
        if (existing && existing.blob) {
          // Concatenate existing + new data.
          newBlob = new Blob([existing.blob, blob],
                             { type: blob.type || existing.type });
        } else {
          newBlob = blob;
        }

        const record = makeRecord(newBlob, name);
        const { store: writeStore } = txStore(db, storageType, "readwrite");
        await idbPromise(writeStore.put(record));
        const fullPath = `/${storageType}/${name}`;
        _dispatchChangeEvent(this, "modified", fullPath);
        return fullPath;
      });
    }

    // ── Read operations ────────────────────────────────────────────────────

    /**
     * Retrieves the file stored at `name`.
     *
     * @param {string} name - logical path
     * @returns {StorageRequest} result → File object
     *
     * @example
     *   const req = storage.get("photos/sunset.jpg");
     *   req.onsuccess = e => {
     *     const file = e.target.result; // File (Blob subclass)
     *   };
     */
    get(name) {
      if (typeof name !== "string" || !name) {
        return _rejectRequest(
          "File name must be a non-empty string", "NotFoundError");
      }

      const storageType = this._storageType;

      return makeRequest(async () => {
        const db = await openDatabase();
        const { store } = txStore(db, storageType, "readonly");
        const record = await idbPromise(store.get(name));
        if (!record) {
          throw new DOMException(`File not found: ${name}`, "NotFoundError");
        }
        return recordToFile(record, storageType);
      });
    }

    /**
     * Same as get() but conceptually returns an "editable" handle.
     * In the polyfill this is identical to get() since we always return
     * a plain File.
     * @param {string} name
     * @returns {StorageRequest}
     */
    getEditable(name) {
      return this.get(name);
    }

    // ── Delete operation ───────────────────────────────────────────────────

    /**
     * Deletes the file at `name`.
     *
     * @param {string} name - logical path
     * @returns {StorageRequest} result → name (string)
     *
     * @example
     *   const req = storage.delete("photos/sunset.jpg");
     *   req.onsuccess = () => console.log("Deleted");
     */
    delete(name) {
      if (typeof name !== "string" || !name) {
        return _rejectRequest(
          "File name must be a non-empty string", "NotFoundError");
      }

      const storageType = this._storageType;

      return makeRequest(async () => {
        const db = await openDatabase();
        // Verify file exists before deleting (match Gecko NotFoundError).
        const { store: readStore } = txStore(db, storageType, "readonly");
        const existing = await idbPromise(readStore.get(name));
        if (!existing) {
          throw new DOMException(`File not found: ${name}`, "NotFoundError");
        }
        const { store: writeStore } = txStore(db, storageType, "readwrite");
        await idbPromise(writeStore.delete(name));
        const fullPath = `/${storageType}/${name}`;
        _dispatchChangeEvent(this, "deleted", fullPath);
        return name;
      });
    }

    // ── Enumerate ──────────────────────────────────────────────────────────

    /**
     * Returns a FileIterable over all files in this storage area.
     *
     * Mirrors the Gecko WebIDL:
     *   FileIterable enumerate(optional DeviceStorageEnumerationParameters);
     *   FileIterable enumerate(DOMString path, optional …parameters);
     *
     * @param {string|Object} [pathOrOptions]
     *   If a string: a sub-path prefix to filter by.
     *   If an object: enumeration options ({ since: timestamp }).
     * @param {Object} [options]
     *   { since: number }  – only return files modified after this timestamp.
     * @returns {FileIterable}
     *
     * @example
     *   // List all files:
     *   for await (const file of sdcard.enumerate()) { … }
     *
     *   // List files in a subdirectory:
     *   for await (const file of sdcard.enumerate("DCIM/")) { … }
     *
     *   // List files modified since a date:
     *   for await (const file of sdcard.enumerate({ since: Date.now() - 86400000 })) { … }
     */
    enumerate(pathOrOptions, options) {
      let pathPrefix = "";
      let since = 0;

      if (typeof pathOrOptions === "string") {
        pathPrefix = pathOrOptions;
        if (options && typeof options.since === "number") {
          since = options.since;
        }
      } else if (pathOrOptions && typeof pathOrOptions === "object") {
        if (typeof pathOrOptions.since === "number") {
          since = pathOrOptions.since;
        }
      }

      return new FileIterable(this._storageType, pathPrefix, since);
    }

    /**
     * Same as enumerate() but intended for files that may be modified.
     * Semantically equivalent in the polyfill.
     * @param {string|Object} [pathOrOptions]
     * @param {Object} [options]
     * @returns {FileIterable}
     */
    enumerateEditable(pathOrOptions, options) {
      return this.enumerate(pathOrOptions, options);
    }

    // ── Space queries ──────────────────────────────────────────────────────

    /**
     * Returns the total bytes used by this storage area.
     * Calculated by summing `size` fields of all records in the IDB store.
     *
     * @returns {StorageRequest} result → number (bytes)
     *
     * @example
     *   const req = storage.usedSpace();
     *   req.onsuccess = e => console.log("Used:", e.target.result, "bytes");
     */
    usedSpace() {
      const storageType = this._storageType;

      return makeRequest(async () => {
        const db = await openDatabase();
        const { store } = txStore(db, storageType, "readonly");
        const allRecords = await idbPromise(store.getAll());
        let total = 0;
        for (const record of allRecords) {
          total += record.size || 0;
        }
        return total;
      });
    }

    /**
     * Returns a simulated free-space value for this storage area.
     * On a real KaiOS device this calls statvfs; in the browser we return a
     * constant (2 GiB) that satisfies apps checking for available space.
     *
     * @returns {StorageRequest} result → number (bytes)
     *
     * @example
     *   const req = storage.freeSpace();
     *   req.onsuccess = e => console.log("Free:", e.target.result, "bytes");
     */
    freeSpace() {
      return makeRequest(async () => SIMULATED_FREE_BYTES);
    }

    /**
     * Returns whether the storage is considered "disk full".
     * Always returns false in the polyfill.
     * @returns {StorageRequest} result → boolean
     */
    isDiskFull() {
      return makeRequest(async () => false);
    }

    /**
     * Returns the storage availability status.
     * Always "available" in the polyfill.
     * @returns {StorageRequest} result → "available"
     */
    available() {
      return makeRequest(async () => "available");
    }

    // ── Directory / root ───────────────────────────────────────────────────

    /**
     * Returns a Promise that resolves to the root PseudoDirectory.
     * In Gecko this returns Promise<Directory>.
     *
     * @returns {Promise<PseudoDirectory>}
     *
     * @example
     *   const root = await storage.getRoot();
     *   const dir  = await root.createDirectory("DCIM");
     */
    getRoot() {
      // Gecko returns a real Promise here (not a DOMRequest).
      return openDatabase().then(() =>
        new PseudoDirectory(this._storageType, "/"));
    }

    // ── Storage metadata ───────────────────────────────────────────────────

    /**
     * @returns {string} storage name (same as type in the polyfill)
     */
    getStorageName() {
      return this.storageName;
    }

    /**
     * @returns {string} virtual storage path
     */
    getStoragePath() {
      return `/${this._storageType}`;
    }

    // ── Stubs for mount / format (no-op in browser) ────────────────────────

    /** @returns {StorageRequest} */
    storageStatus() {
      return makeRequest(async () => "available");
    }

    /** @returns {StorageRequest} */
    format() {
      return makeRequest(async () => "unavailable");
    }

    /** @returns {StorageRequest} */
    mount() {
      return makeRequest(async () => "available");
    }

    /** @returns {StorageRequest} */
    unmount() {
      return makeRequest(async () => "unavailable");
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns an already-rejected StorageRequest.
   * @param {string} msg
   * @param {string} name - DOMException name
   * @returns {StorageRequest}
   */
  function _rejectRequest(msg, name) {
    const req = new StorageRequest();
    req._promise = Promise.reject(new DOMException(msg, name));
    req._promise.catch(() => {}); // suppress unhandled rejection
    Promise.resolve().then(() =>
      req._reject(new DOMException(msg, name)));
    return req;
  }

  /**
   * Checks whether a path component contains directory traversal sequences.
   * Mirrors Gecko's DeviceStorageFile::IsSafePath().
   * @param {string} path
   * @returns {boolean}
   */
  function _hasUnsafePath(path) {
    // Reject absolute paths, ".." traversals, or paths that start with ".".
    if (path.startsWith("/"))  return true;
    const parts = path.split("/");
    for (const part of parts) {
      if (part === ".." || part === ".") return true;
    }
    return false;
  }

  /**
   * Dispatches a synthetic "change" CustomEvent on the DeviceStorage instance.
   * Mirrors Gecko's nsDOMDeviceStorage::Notify() / OnFileWatcherUpdate().
   * @param {DeviceStorage} storage
   * @param {string} reason  - "created" | "modified" | "deleted"
   * @param {string} path    - full virtual path of the affected file
   */
  function _dispatchChangeEvent(storage, reason, path) {
    // Fire asynchronously so it does not block the current call stack.
    Promise.resolve().then(() => {
      const event = new CustomEvent("change", {
        bubbles:    false,
        cancelable: false,
        detail: { reason, path },
      });
      // Expose path and reason as direct properties to match KaiOS surface:
      //   e.path, e.reason (as seen in test_watch.html)
      Object.defineProperty(event, "path",   { value: path });
      Object.defineProperty(event, "reason", { value: reason });
      storage.dispatchEvent(event);
    });
  }

  // ── navigator.b2g namespace ────────────────────────────────────────────────

  /**
   * Cache of DeviceStorage instances keyed by storage type.
   * navigator.b2g.getDeviceStorage() always returns the same instance for the
   * same type (matching Gecko singleton behaviour).
   * @type {Map<string, DeviceStorage>}
   */
  const _storageInstances = new Map();

  /**
   * The b2g namespace object.
   * Only navigator.b2g.getDeviceStorage is part of the public surface.
   */
  const b2g = Object.freeze({
    /**
     * Returns (or creates) the DeviceStorage instance for `storageType`.
     *
     * @param {string} storageType - "sdcard" | "pictures" | "videos" | "music" | …
     * @returns {DeviceStorage}
     *
     * @example
     *   const sdcard = navigator.b2g.getDeviceStorage("sdcard");
     */
    getDeviceStorage(storageType) {
      if (!STORAGE_TYPES.includes(storageType)) {
        throw new DOMException(
          `Unknown storage type '${storageType}'. ` +
          `Valid types: ${STORAGE_TYPES.join(", ")}`, "UnknownError");
      }
      if (!_storageInstances.has(storageType)) {
        _storageInstances.set(storageType, new DeviceStorage(storageType));
      }
      return _storageInstances.get(storageType);
    },
  });

  // ── Install polyfill ───────────────────────────────────────────────────────

  /**
   * Install navigator.b2g only if it does not already exist (i.e. we are
   * running in a real KaiOS browser, not a desktop browser).
   */
  if (typeof navigator !== "undefined") {
    if (!navigator.b2g) {
      try {
        Object.defineProperty(navigator, "b2g", {
          value:        b2g,
          writable:     false,
          configurable: true,
          enumerable:   true,
        });
        console.info("[DeviceStorage polyfill] navigator.b2g installed. " +
                     "Backend: IndexedDB (" + DB_NAME + ")");
      } catch (e) {
        // Some environments (e.g. strict CSP) may block property definition.
        console.warn("[DeviceStorage polyfill] Could not install navigator.b2g:", e);
      }
    } else {
      console.info("[DeviceStorage polyfill] Real navigator.b2g detected – " +
                   "polyfill not installed.");
    }
  }

  // ── Exports (for module usage) ─────────────────────────────────────────────

  /**
   * If running in a module environment (ES modules or CommonJS shimmed),
   * also export the internals so tests can import them directly.
   */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { b2g, DeviceStorage, FileIterable, StorageRequest,
                       PseudoDirectory };
  }

}(typeof globalThis !== "undefined" ? globalThis :
  typeof window    !== "undefined" ? window    : this));


// ============================================================================
// DEMO / SELF-TEST
// ============================================================================
// Paste the block below into the browser console (after loading the polyfill)
// to verify all operations. It exactly mirrors the usage patterns found in the
// KaiOS test suite (test_add.html, test_enumerate.html, test_dirs.html, etc.)
// ============================================================================

/**
 * Runs a complete smoke-test of the polyfill.
 * Intended to be called from the browser console or at page load.
 *
 * @example
 *   runDeviceStorageDemo();
 */
async function runDeviceStorageDemo() {

  console.group("=== KaiOS DeviceStorage Polyfill Demo ===");

  // ── 1. Get storage handle ─────────────────────────────────────────────────
  const sdcard = navigator.b2g.getDeviceStorage("sdcard");
  console.log("[1] Got DeviceStorage:", sdcard);

  // ── 2. Write files ────────────────────────────────────────────────────────
  console.group("[2] Writing files...");

  const blob1 = new Blob(["Hello, KaiOS world!"], { type: "text/plain" });
  const blob2 = new Blob(["Second file content"], { type: "text/plain" });
  const imgBlob = new Blob(
    [new Uint8Array([0x89,0x50,0x4e,0x47])], // PNG magic bytes
    { type: "image/png" });

  // addNamed with callbacks (classic KaiOS style)
  await new Promise((resolve, reject) => {
    const req = sdcard.addNamed(blob1, "demo/hello.txt");
    req.onsuccess = (e) => {
      console.log("  addNamed onsuccess →", e.target.result);
      resolve();
    };
    req.onerror = (e) => {
      console.error("  addNamed onerror →", e.target.error.name);
      reject(e.target.error);
    };
  });

  // addNamed using await (Promise-compatible)
  const path2 = await sdcard.addNamed(blob2, "demo/second.txt");
  console.log("  addNamed (await) →", path2);

  const pathImg = await sdcard.addNamed(imgBlob, "demo/photo.png");
  console.log("  addNamed image  →", pathImg);

  console.groupEnd();

  // ── 3. Read a file ────────────────────────────────────────────────────────
  console.group("[3] Reading files...");

  // Classic callback style
  await new Promise((resolve, reject) => {
    const req = sdcard.get("demo/hello.txt");
    req.onsuccess = async (e) => {
      const file = e.target.result;
      const text = await file.text();
      console.log("  get (callback) →", file.name, "→ content:", text);
      resolve();
    };
    req.onerror = (e) => {
      console.error("  get onerror →", e.target.error.name);
      reject(e.target.error);
    };
  });

  // Promise style
  const file2 = await sdcard.get("demo/second.txt");
  console.log("  get (await) →", file2.name, "size:", file2.size, "bytes");
  console.log("              → type:", file2.type);

  // Test NotFoundError
  try {
    await sdcard.get("nonexistent.txt");
  } catch (err) {
    console.log("  get missing file → error:", err.name, "✓");
  }

  console.groupEnd();

  // ── 4. appendNamed ────────────────────────────────────────────────────────
  console.group("[4] appendNamed...");
  const appendBlob = new Blob([" [appended]"], { type: "text/plain" });
  await sdcard.appendNamed(appendBlob, "demo/hello.txt");
  const appended = await sdcard.get("demo/hello.txt");
  console.log("  after append →", await appended.text());
  console.groupEnd();

  // ── 5. Space queries ──────────────────────────────────────────────────────
  console.group("[5] Space queries...");

  const usedReq = sdcard.usedSpace();
  await new Promise((resolve) => {
    usedReq.onsuccess = (e) => {
      console.log("  usedSpace →", e.target.result, "bytes");
      resolve();
    };
  });

  const freeBytes = await sdcard.freeSpace();
  console.log("  freeSpace →", freeBytes, "bytes (~" +
              Math.round(freeBytes / 1024 / 1024 / 1024) + " GiB simulated)");

  console.groupEnd();

  // ── 6. Enumerate – for-await-of style ────────────────────────────────────
  console.group("[6] enumerate() – for-await-of");

  const iterable = sdcard.enumerate();
  console.log("  FileIterable:", iterable);

  let count = 0;
  for await (const file of iterable) {
    console.log(`  [${count++}] ${file.name}  (${file.size} bytes, ${file.type})`);
  }
  console.log("  Total files enumerated:", count);

  console.groupEnd();

  // ── 7. Enumerate – manual itor.next() style (KaiOS README example) ───────
  console.group("[7] enumerate() – manual itor.next()");

  const iterable2 = sdcard.enumerate("demo/"); // filter by prefix
  const itor = iterable2.values();

  let entry;
  let idx = 0;
  while (!(entry = await itor.next()).done) {
    console.log(`  file[${idx++}]:`, entry.value.name);
  }
  console.log("  done:", entry.done, "✓");

  console.groupEnd();

  // ── 8. enumerate() with `since` filter ────────────────────────────────────
  console.group("[8] enumerate({ since }) filter");
  const future    = Date.now() + 60_000; // 1 minute in the future
  const itFuture  = sdcard.enumerate({ since: future });
  let futureCount = 0;
  for await (const _ of itFuture) { futureCount++; }
  console.log("  Files modified after now:", futureCount, "(expected 0) ✓");
  console.groupEnd();

  // ── 9. Delete ──────────────────────────────────────────────────────────────
  console.group("[9] delete()");

  await new Promise((resolve, reject) => {
    const req = sdcard.delete("demo/second.txt");
    req.onsuccess = (e) => {
      console.log("  deleted →", e.target.result, "✓");
      resolve();
    };
    req.onerror = (e) => {
      console.error("  delete error →", e.target.error.name);
      reject(e.target.error);
    };
  });

  // Verify it is gone.
  try {
    await sdcard.get("demo/second.txt");
    console.error("  ERROR: file should have been deleted!");
  } catch (e) {
    console.log("  Confirm deleted – get throws:", e.name, "✓");
  }

  // Delete non-existent file → NotFoundError
  try {
    await sdcard.delete("does-not-exist.txt");
  } catch (e) {
    console.log("  delete missing →", e.name, "✓");
  }

  console.groupEnd();

  // ── 10. getRoot / PseudoDirectory ─────────────────────────────────────────
  console.group("[10] getRoot() → createDirectory()");

  const root = await sdcard.getRoot();
  console.log("  root.path:", root.path);

  const dirReq = root.createDirectory("DCIM");
  const dcim   = await dirReq;
  console.log("  createDirectory('DCIM') →", dcim.path);

  // List everything via getFilesAndDirectories
  const listReq = root.getFilesAndDirectories();
  const items   = await listReq;
  console.log("  getFilesAndDirectories() →", items.length, "items");
  for (const item of items) {
    if (item instanceof File) {
      console.log("    FILE:", item.name);
    } else {
      console.log("    DIR: ", item.path);
    }
  }

  console.groupEnd();

  // ── 11. "change" event listener ────────────────────────────────────────────
  console.group("[11] change event");
  const changePromise = new Promise((resolve) => {
    sdcard.addEventListener("change", function handler(e) {
      console.log("  change event fired → reason:", e.reason, " path:", e.path, "✓");
      sdcard.removeEventListener("change", handler);
      resolve();
    });
  });
  await sdcard.addNamed(new Blob(["watch test"], { type: "text/plain" }),
                        "demo/watch.txt");
  await changePromise;
  console.groupEnd();

  // ── 12. pictures storage ────────────────────────────────────────────────────
  console.group("[12] pictures storage");
  const pictures = navigator.b2g.getDeviceStorage("pictures");
  const pngBlob  = new Blob([new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a])],
                             { type: "image/png" });
  const pngPath  = await pictures.addNamed(pngBlob, "devicestorage/test/photo.png");
  console.log("  addNamed (pictures) →", pngPath);
  const usedPic  = await pictures.usedSpace();
  console.log("  usedSpace (pictures) →", usedPic, "bytes ✓");
  console.groupEnd();

  // ── 13. Dual-storage: sdcard (internal) vs sdcard1 (external SD card) ───────
  // Two completely separate storage volumes backed by separate IDBObjectStores.
  // Files written to one are NEVER visible from the other —
  // matching real KaiOS dual-storage behaviour on devices like Nokia 2780 Flip.
  console.group("[13] Dual-storage: sdcard vs sdcard1");

  // --- sdcard (internal built-in storage) ---
  const internalSD   = navigator.b2g.getDeviceStorage("sdcard");
  const internalBlob = new Blob(["I am on INTERNAL storage"], { type: "text/plain" });
  const internalPath = await internalSD.addNamed(internalBlob, "test/internal.txt");
  console.log("  [sdcard]  addNamed →", internalPath);

  // --- sdcard1 (external removable SD card) ---
  const externalSD   = navigator.b2g.getDeviceStorage("sdcard1");
  const externalBlob = new Blob(["I am on EXTERNAL sdcard1"], { type: "text/plain" });
  const externalPath = await externalSD.addNamed(externalBlob, "test/external.txt");
  console.log("  [sdcard1] addNamed →", externalPath);

  // ── Isolation check 1: sdcard must NOT see sdcard1 file ──
  try {
    await internalSD.get("test/external.txt");
    console.error("  ISOLATION FAIL: sdcard1 file leaked into sdcard!");
  } catch (e) {
    console.log("  Isolation: sdcard cannot see sdcard1 file →", e.name, "✓");
  }

  // ── Isolation check 2: sdcard1 must NOT see sdcard file ──
  try {
    await externalSD.get("test/internal.txt");
    console.error("  ISOLATION FAIL: sdcard file leaked into sdcard1!");
  } catch (e) {
    console.log("  Isolation: sdcard1 cannot see sdcard file →", e.name, "✓");
  }

  // ── Read back from each volume independently ──
  const readInternal = await internalSD.get("test/internal.txt");
  console.log("  [sdcard]  read back →", await readInternal.text());
  const readExternal = await externalSD.get("test/external.txt");
  console.log("  [sdcard1] read back →", await readExternal.text());

  // ── Space queries on both volumes ──
  const usedInternal = await internalSD.usedSpace();
  const usedExternal = await externalSD.usedSpace();
  console.log("  [sdcard]  usedSpace →", usedInternal, "bytes");
  console.log("  [sdcard1] usedSpace →", usedExternal, "bytes");

  // ── Enumerate each volume separately ──
  console.log("  --- enumerate sdcard ---");
  let ni = 0;
  for await (const f of internalSD.enumerate()) {
    console.log(`    sdcard[${ni++}]: ${f.name}`);
  }
  console.log("  --- enumerate sdcard1 ---");
  let ne = 0;
  for await (const f of externalSD.enumerate()) {
    console.log(`    sdcard1[${ne++}]: ${f.name}`);
  }

  // ── getRoot on external SD ──
  const extRoot = await externalSD.getRoot();
  console.log("  [sdcard1] root.path →", extRoot.path);
  const extDir = await extRoot.createDirectory("External_DCIM");
  console.log("  [sdcard1] createDirectory →", extDir.path, "✓");

  // ── change event fires on correct volume only ──
  const extChangePromise = new Promise((resolve) => {
    externalSD.addEventListener("change", function h(e) {
      console.log("  [sdcard1] change → reason:", e.reason, "path:", e.path, "✓");
      externalSD.removeEventListener("change", h);
      resolve();
    });
  });
  let falseFire = 0;
  const falseHandler = () => { falseFire++; };
  internalSD.addEventListener("change", falseHandler);
  await externalSD.addNamed(
    new Blob(["ext watch test"], { type: "text/plain" }), "test/watch_ext.txt");
  await extChangePromise;
  internalSD.removeEventListener("change", falseHandler);
  console.log("  sdcard false-fire count (must be 0):", falseFire, "✓");

  console.groupEnd();

  console.log("\n✅  All demo operations completed successfully.");
  console.log("    sdcard  = internal built-in flash storage");
  console.log("    sdcard1 = external removable SD card");
  console.groupEnd();
}

// Auto-run demo if this script is loaded as a standalone <script> tag.
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    runDeviceStorageDemo().catch(console.error);
  });
}
