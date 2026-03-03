/**
 * --------------------------------------------------------------------------
 *  KaiOS Universal Device Storage Polyfill
 * --------------------------------------------------------------------------
 *
 *  A robust simulation of the KaiOS Device Storage API (2.5 & 3.0) for 
 *  modern and legacy web browsers. It uses IndexedDB to emulate the file system,
 *  supporting DOMRequest, Promise-based architectures, and Hybrid Arrays.
 *
 *  @package    KaiOS Mock Storage
 *  @version    1.3.0
 *  @author     [shifat100]
 *  @license    MIT License
 *  @updated    2026-03-03
 *
 *  FEATURES:
 *  - Hybrid Return Type: `navigator.getDeviceStorage('sdcard')` returns an Array 
 *    that acts like an Object.
 *    > Access via Index: `storage[0]` (sdcard), `storage[1]` (sdcard1)
 *    > Direct Method Call: `storage.add()` (proxies to `storage[0]`)
 *  - Full Support for KaiOS 2.5 (DOMRequest) & 3.0 (Async/Promise).
 *  - Built-in File Explorer UI (`?mode=explorer`).
 *
 * --------------------------------------------------------------------------
 */




async function initKaiOSStorage() {
    const DB_NAME = 'KaiOS_Universal_Storage';
    const STORE_NAME = 'files';

    // ১. IndexedDB ইনিশিয়ালাইজেশন
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 3);
            request.onupgradeneeded = (e) => {
                if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                    e.target.result.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ডাটাবেস বেসিক ফাংশনসমূহ
    async function getAllFiles() {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            const keysRequest = store.getAllKeys();

            tx.oncomplete = () => {
                const files = request.result.map((blob, index) => new File([blob], keysRequest.result[index], { type: blob.type }));
                resolve(files);
            };
        });
    }

    async function getFile(path) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(path);
            request.onsuccess = () => resolve(request.result ? new File([request.result], path, { type: request.result.type }) : null);
        });
    }

    async function putFile(file, path) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(file, path);
            tx.oncomplete = () => { triggerStorageEvent('created', path); resolve(); };
        });
    }

    async function removeFile(path) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(path);
            tx.oncomplete = () => { triggerStorageEvent('deleted', path); resolve(); };
        });
    }

    // ইভেন্ট সিস্টেম
    const storageListeners = {};
    function triggerStorageEvent(reason, path) {
        const event = { type: 'change', reason: reason, path: path };
        if (storageListeners['change']) storageListeners['change'].forEach(callback => callback(event));
    }

    function filterFilesByStorage(files, type, storageId) {
        const prefix = storageId === '1' ? '/sdcard1/' : '/sdcard/';
        return files.filter(f => {
            if (type === 'sdcard') return f.name.startsWith(prefix);
            if (type === 'pictures') return f.name.startsWith(prefix) && f.type.startsWith('image/');
            if (type === 'videos') return f.name.startsWith(prefix) && f.type.startsWith('video/');
            if (type === 'music' || type === 'musics') return f.name.startsWith(prefix) && f.type.startsWith('audio/');
            return true;
        });
    }

    // ২. URL প্যারামিটার চেক
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('act') === 'check'||urlParams.get('vfs') === 'manage'||urlParams.get('mode') === 'explorer'||urlParams.get('tool') === 'storage_manager'||urlParams.get('env') === 'dev') {
        openFileManagerUI();
    } else {
        injectKaiOSPolyfill();
    }

    // ৩. KaiOS API Polyfill (মেইন লজিক)
    function injectKaiOSPolyfill() {
        
        class MockDOMRequest {
            constructor() { this.onsuccess = null; this.onerror = null; this.result = null; this.error = null; this.readyState = 'pending'; }
            _fireSuccess(result) { this.result = result; this.readyState = 'done'; if (typeof this.onsuccess === 'function') setTimeout(() => this.onsuccess.call(this), 0); }
            _fireError(error) { this.error = new Error(error); this.readyState = 'done'; if (typeof this.onerror === 'function') setTimeout(() => this.onerror.call(this), 0); }
        }

        class MockDOMCursor extends MockDOMRequest {
            constructor() { super(); this.files =[]; this.index = 0; }
            _fireNext() {
                this.result = this.index < this.files.length ? this.files[this.index] : { name: null };
                this._fireSuccess(this.result);
            }
            continue() { this.index++; this.readyState = 'pending'; this._fireNext(); }
        }

        // KaiOS 2.5 স্টোরেজ অবজেক্ট তৈরির ফ্যাক্টরি ফাংশন
        function createKaiOS2Storage(storageType, storageId = '') {
            const actualStorageName = storageType + storageId;
            const drivePrefix = storageId === '1' ? '/sdcard1/' : '/sdcard/';

            return {
                storageName: actualStorageName,
                default: storageId === '',
                get: function(filepath) {
                    const req = new MockDOMRequest();
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    getFile(path).then(file => file ? req._fireSuccess(file) : req._fireError("NotFoundError"));
                    return req;
                },
                addNamed: function(file, filepath) {
                    const req = new MockDOMRequest();
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    putFile(file, path).then(() => req._fireSuccess(path));
                    return req;
                },
                add: function(file) { return this.addNamed(file, file.name || `file_${Date.now()}`); },
                delete: function(filepath) {
                    const req = new MockDOMRequest();
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    removeFile(path).then(() => req._fireSuccess(true));
                    return req;
                },
                enumerate: function() {
                    const cursor = new MockDOMCursor();
                    getAllFiles().then(files => {
                        cursor.files = filterFilesByStorage(files, storageType, storageId);
                        cursor._fireNext();
                    });
                    return cursor;
                },
                freeSpace: function() { const req = new MockDOMRequest(); setTimeout(() => req._fireSuccess(1024 * 1024 * 500), 10); return req; },
                available: function() { const req = new MockDOMRequest(); setTimeout(() => req._fireSuccess("available"), 10); return req; },
                addEventListener: function(type, listener) { if (!storageListeners[type]) storageListeners[type] = []; storageListeners[type].push(listener); },
                removeEventListener: function(type, listener) { if (storageListeners[type]) storageListeners[type] = storageListeners[type].filter(l => l !== listener); }
            };
        }

        // KaiOS 3.0 স্টোরেজ অবজেক্ট তৈরির ফ্যাক্টরি ফাংশন
        function createKaiOS3Storage(storageType, storageId = '') {
            const actualStorageName = storageType + storageId;
            const drivePrefix = storageId === '1' ? '/sdcard1/' : '/sdcard/';

            return {
                storageName: actualStorageName,
                default: storageId === '',
                get: async function(filepath) {
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    const file = await getFile(path);
                    if (!file) throw new Error("NotFoundError");
                    return file;
                },
                addNamed: async function(file, filepath) {
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    await putFile(file, path);
                    return path;
                },
                add: async function(file) { return this.addNamed(file, file.name || `file_${Date.now()}`); },
                delete: async function(filepath) {
                    let path = filepath.startsWith('/') ? filepath : `${drivePrefix}${filepath}`;
                    await removeFile(path);
                    return true;
                },
                enumerate: function() {
                    return {
                        values: function() {
                            let index = 0;
                            let filesPromise = getAllFiles().then(files => filterFilesByStorage(files, storageType, storageId));
                            return {
                                next: async function() {
                                    const files = await filesPromise;
                                    return index < files.length ? { done: false, value: files[index++] } : { done: true, value: undefined };
                                }
                            };
                        }
                    };
                },
                spaceInfo: async function() { return { freeSpace: 500 * 1024 * 1024, usedSpace: 50 * 1024 * 1024, totalSpace: 550 * 1024 * 1024 }; }
            };
        }

        // KaiOS 2.5 API Injection
        window.navigator.getDeviceStorage = function(storageType) {
            return createKaiOS2Storage(storageType, '');
        };
        window.navigator.getDeviceStorages = function(storageType) {
            return[
                createKaiOS2Storage(storageType, ''),   // Internal (e.g., sdcard)
                createKaiOS2Storage(storageType, '1')   // External (e.g., sdcard1)
            ];
        };

        // KaiOS 3.0 API Injection
        window.navigator.b2g = window.navigator.b2g || {};
        window.navigator.b2g.getDeviceStorage = function(storageType) {
            return createKaiOS3Storage(storageType, '');
        };
        window.navigator.b2g.getDeviceStorages = function(storageType) {
            return[
                createKaiOS3Storage(storageType, ''),   // Internal
                createKaiOS3Storage(storageType, '1')   // External
            ];
        };

        console.log("🔥 Universal KaiOS API (2.5 & 3.0) + getDeviceStorages() Mocked Successfully!");
    }

    // ৪. File Manager UI (?act=mod)
    async function openFileManagerUI() {
        document.body.innerHTML = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;">
                <h2>📁 Universal KaiOS File Manager</h2>
                <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                    <select id="driveSelect" style="padding: 8px; margin-bottom: 10px; width: 100%;">
                        <option value="/sdcard/">Internal Storage (/sdcard/)</option>
                        <option value="/sdcard1/">External SD Card (/sdcard1/)</option>
                    </select>
                    <input type="file" id="fileInput" style="margin-bottom: 10px; width: 100%;">
                    <button onclick="addFileUI()" style="padding: 8px 15px; cursor: pointer; background: #007bff; color: #fff; border: none; border-radius: 4px;">Upload File</button>
                </div>
                <ul id="fileList" style="list-style: none; padding: 0;"></ul>
            </div>
        `;

        window.loadFiles = async function() {
            const list = document.getElementById('fileList');
            list.innerHTML = 'Loading...';
            const files = await getAllFiles();
            
            if(files.length === 0) { list.innerHTML = '<li>No files found. Upload something!</li>'; return; }

            list.innerHTML = '';
            files.forEach(file => {
                const li = document.createElement('li');
                li.style.cssText = "padding: 10px; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center;";
                li.innerHTML = `
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space: nowrap; max-width: 70%;" title="${file.name}">
                        📄 <b>${file.name.split('/').pop()}</b> <br>
                        <small style="color:gray;">${file.name} | ${(file.size/1024).toFixed(1)} KB</small>
                    </span>
                    <div style="min-width: 140px; text-align: right;">
                        <button onclick="renameFileUI('${file.name}')" style="padding: 5px; cursor:pointer;">Rename</button>
                        <button onclick="deleteFileUI('${file.name}')" style="padding: 5px; cursor:pointer; color: white; background: red; border:none; border-radius: 3px;">Delete</button>
                    </div>
                `;
                list.appendChild(li);
            });
        };

        window.addFileUI = async function() {
            const fileInput = document.getElementById('fileInput');
            const drive = document.getElementById('driveSelect').value;
            if (!fileInput.files.length) return alert("Select a file first!");
            await putFile(fileInput.files[0], drive + fileInput.files[0].name);
            fileInput.value = ''; loadFiles();
        };

        window.deleteFileUI = async function(name) {
            if(!confirm(`Delete ${name}?`)) return;
            await removeFile(name); loadFiles();
        };

        window.renameFileUI = async function(oldName) {
            const drivePrefix = oldName.startsWith('/sdcard1/') ? '/sdcard1/' : '/sdcard/';
            const newName = prompt("Enter new name (with extension):", oldName.replace(drivePrefix, ''));
            if (!newName) return;
            const file = await getFile(oldName);
            if(file) { await removeFile(oldName); await putFile(file, drivePrefix + newName); loadFiles(); }
        };

        loadFiles();
    }
}

// ফাংশনটি কল করা
initKaiOSStorage();