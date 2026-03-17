/**
 * KaiOS 3.0 DeviceStorage API Polyfill
 * 
 * Emulates `navigator.b2g.getDeviceStorage` using IndexedDB.
 * Supports StorageRequest bindings, Promises, and FileIterable for async loops.
 */
(function(global) {
    // Avoid re-initializing if it already exists natively or is previously loaded
    if (!global.navigator) global.navigator = {};
    if (!global.navigator.b2g) global.navigator.b2g = {};
    if (global.navigator.b2g.getDeviceStorage) return;

    // --- Database Configuration ---
    const DB_NAME = 'KaiOS_DeviceStorage_Polyfill';
    const DB_VERSION = 1;
    const STORE_NAME = 'files';

    /**
     * Internal helper to get/initialize the IndexedDB instance.
     * Uses a single object store with compound IDs (storageType::path).
     */
    function getDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // id will be formatted as "storageType::path" to guarantee uniqueness
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('storageType', 'storageType', { unique: false });
                    store.createIndex('path', 'path', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // --- Core API Classes ---

    /**
     * StorageRequest mimics the DOMRequest/Promise hybrid used in KaiOS.
     * It triggers `onsuccess`/`onerror` handlers and behaves as a Promise.
     */
    class StorageRequest {
        constructor() {
            this.readyState = 'pending';
            this.result = undefined;
            this.error = undefined;
            this.onsuccess = null;
            this.onerror = null;

            this._promise = new Promise((resolve, reject) => {
                this._resolve = resolve;
                this._reject = reject;
            });
        }

        then(onfulfilled, onrejected) {
            return this._promise.then(onfulfilled, onrejected);
        }

        catch(onrejected) {
            return this._promise.catch(onrejected);
        }

        _fireSuccess(result) {
            this.readyState = 'done';
            this.result = result;
            if (typeof this.onsuccess === 'function') {
                // Emulate Event object targeting this request
                this.onsuccess({ target: this });
            }
            this._resolve(result);
        }

        _fireError(error) {
            this.readyState = 'done';
            this.error = error;
            if (typeof this.onerror === 'function') {
                this.onerror({ target: this });
            }
            this._reject(error);
        }
    }

    /**
     * FileIterable implements the KaiOS 3.0 async iterator for enumerating files.
     * Allows seamless `for await...of` loops and streaming.
     */
    class FileIterable {
        constructor(storageType, pathPrefix = '') {
            this.storageType = storageType;
            this.pathPrefix = pathPrefix;
        }

        async *[Symbol.asyncIterator]() {
            const db = await getDB();
            
            // Fetch records inside a promise to avoid IndexedDB transaction
            // auto-closing during yields to the async event loop.
            const files = await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('storageType');
                const request = index.openCursor(IDBKeyRange.only(this.storageType));

                const results =[];
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const val = cursor.value;
                        // Filter out directory markers & match prefix
                        if (!val.isDirectory && val.path.startsWith(this.pathPrefix)) {
                            // Rehydrate the File object from stored Blob + Metadata
                            const file = new File([val.blob], val.path, {
                                type: val.blob.type,
                                lastModified: val.lastModified
                            });
                            results.push(file);
                        }
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                request.onerror = () => reject(request.error);
            });

            for (const file of files) {
                yield file;
            }
        }

        values() {
            return this[Symbol.asyncIterator]();
        }
    }

    /**
     * StorageDirectory mimics a pseudo-directory (DeviceStorageRoot).
     */
    class StorageDirectory {
        constructor(type, path) {
            this.type = type;
            this.path = path; // Ends with "/", or empty for root
        }

        createDirectory(name) {
            const req = new StorageRequest();
            // Sanitize and create nested directory path
            const cleanName = name.replace(/^\/+|\/+$/g, '');
            const dirPath = this.path + cleanName + "/";
            const dirId = this.type + '::' + dirPath;

            getDB().then(db => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const addReq = store.put({
                    id: dirId,
                    storageType: this.type,
                    path: dirPath,
                    isDirectory: true,
                    lastModified: Date.now()
                });

                addReq.onsuccess = () => req._fireSuccess(new StorageDirectory(this.type, dirPath));
                addReq.onerror = () => req._fireError(new DOMException('Could not create directory', 'InvalidModificationError'));
            }).catch(e => req._fireError(e));

            return req;
        }

        // List files specifically inside this directory
        enumerate() {
            return new FileIterable(this.type, this.path);
        }
    }

    /**
     * Main DeviceStorage class representing a specific storage type (e.g., 'sdcard').
     */
    class DeviceStorage {
        constructor(type) {
            this.storageName = type;
        }

        addNamed(blob, name) {
            const req = new StorageRequest();
            if (!blob || !name) {
                setTimeout(() => req._fireError(new DOMException("Blob and name required", "UnknownError")), 0);
                return req;
            }

            const cleanName = name.replace(/^\/+/, ''); // Strip leading slashes
            const id = this.storageName + '::' + cleanName;

            getDB().then(db => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const putReq = store.put({
                    id: id,
                    storageType: this.storageName,
                    path: cleanName,
                    blob: blob,
                    isDirectory: false,
                    size: blob.size,
                    lastModified: blob.lastModified || Date.now()
                });

                putReq.onsuccess = () => req._fireSuccess(cleanName);
                putReq.onerror = () => req._fireError(new DOMException('Modification failed', 'InvalidModificationError'));
            }).catch(err => req._fireError(err));

            return req;
        }

        get(name) {
            const req = new StorageRequest();
            const cleanName = name.replace(/^\/+/, '');
            const id = this.storageName + '::' + cleanName;

            getDB().then(db => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const getReq = store.get(id);

                getReq.onsuccess = (e) => {
                    const result = e.target.result;
                    if (!result || result.isDirectory) {
                        req._fireError(new DOMException(`File ${cleanName} not found`, 'NotFoundError'));
                    } else {
                        const file = new File([result.blob], result.path, {
                            type: result.blob.type,
                            lastModified: result.lastModified
                        });
                        req._fireSuccess(file);
                    }
                };
                getReq.onerror = () => req._fireError(new DOMException('Read failed', 'UnknownError'));
            }).catch(err => req._fireError(err));

            return req;
        }

        delete(name) {
            const req = new StorageRequest();
            const cleanName = name.replace(/^\/+/, '');
            const id = this.storageName + '::' + cleanName;

            getDB().then(db => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);

                // Check existence first to properly throw NotFoundError
                const checkReq = store.get(id);
                checkReq.onsuccess = (e) => {
                    if (!e.target.result || e.target.result.isDirectory) {
                        req._fireError(new DOMException(`File ${cleanName} not found`, 'NotFoundError'));
                        return;
                    }
                    const delReq = store.delete(id);
                    delReq.onsuccess = () => req._fireSuccess(true);
                    delReq.onerror = () => req._fireError(new DOMException('Deletion failed', 'InvalidModificationError'));
                };
                checkReq.onerror = () => req._fireError(new DOMException('Deletion failed', 'UnknownError'));
            }).catch(err => req._fireError(err));

            return req;
        }

        usedSpace() {
            const req = new StorageRequest();

            getDB().then(db => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('storageType');
                const cursorReq = index.openCursor(IDBKeyRange.only(this.storageName));

                let totalSize = 0;
                cursorReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        if (!cursor.value.isDirectory && cursor.value.size) {
                            totalSize += cursor.value.size;
                        }
                        cursor.continue();
                    } else {
                        req._fireSuccess(totalSize);
                    }
                };
                cursorReq.onerror = () => req._fireError(new DOMException('Space calc failed', 'UnknownError'));
            }).catch(err => req._fireError(err));

            return req;
        }

        freeSpace() {
            const req = new StorageRequest();
            // Mocking a generous 10GB free space
            setTimeout(() => req._fireSuccess(10 * 1024 * 1024 * 1024), 0);
            return req;
        }

        enumerate() {
            return new FileIterable(this.storageName, "");
        }

        getRoot() {
            const req = new StorageRequest();
            // Represents the root directory "/"
            setTimeout(() => {
                req._fireSuccess(new StorageDirectory(this.storageName, ""));
            }, 0);
            return req;
        }
    }

    // --- Export Polyfill ---
    global.navigator.b2g.getDeviceStorage = function(type) {
        // Typically types are: 'sdcard', 'pictures', 'videos', 'music', 'apps'
        return new DeviceStorage(type);
    };

})(typeof window !== 'undefined' ? window : globalThis);


// ==============================================================================
// TESTING HOOKS / DEMO USAGE
// ==============================================================================
/*
(async function testDeviceStoragePolyfill() {
    console.log("--- Starting KaiOS 3.0 DeviceStorage Polyfill Test ---");

    // 1. Get the 'sdcard' storage
    const storage = navigator.b2g.getDeviceStorage("sdcard");

    // 2. Add a new file
    console.log("Adding file 'hello.txt'...");
    const blob = new Blob(["Hello, KaiOS Polyfill!"], { type: "text/plain" });
    
    // Using classic StorageRequest bindings
    const addReq = storage.addNamed(blob, "hello.txt");
    addReq.onsuccess = () => console.log("Success! File added as:", addReq.result);
    addReq.onerror = () => console.error("Error adding file:", addReq.error);

    // Wait for insertion
    await addReq; 

    // 3. Get the file
    console.log("Retrieving 'hello.txt'...");
    try {
        const fileReq = storage.get("hello.txt");
        const file = await fileReq; // Promise-style
        console.log("Retrieved file:", file.name, "| Type:", file.type, "| Size:", file.size);
        const text = await file.text();
        console.log("File content:", text);
    } catch (e) {
        console.error("Failed to retrieve file", e);
    }

    // 4. Test Directory Creation & Sub-files
    const rootReq = storage.getRoot();
    const rootDir = await rootReq;
    const newDir = await rootDir.createDirectory("my_folder");
    console.log("Created directory path:", newDir.path);
    
    await storage.addNamed(new Blob(["Image Content"], {type: "image/png"}), "my_folder/pic.png");

    // 5. Enumerate all files using KaiOS FileIterable `for await...of`
    console.log("Enumerating all files on 'sdcard'...");
    const fileIterable = storage.enumerate();
    for await (const f of fileIterable) {
        console.log("Found File via Enumerate:", f.name, f.size, "bytes");
    }

    // 6. Check metrics
    const used = await storage.usedSpace();
    const free = await storage.freeSpace();
    console.log(`Storage Stats: Used = ${used} bytes, Free = ${free} bytes`);

    // 7. Delete file
    console.log("Deleting 'hello.txt'...");
    await storage.delete("hello.txt");
    console.log("File deleted. Trying to get it again (should fail)...");

    try {
        await storage.get("hello.txt");
    } catch (e) {
        console.log("Expected Error caught:", e.name, "-", e.message); // Should be NotFoundError
    }

    console.log("--- Test Complete ---");
})();
*/
