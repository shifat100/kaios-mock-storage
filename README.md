

# KaiOS DeviceStorage Polyfills (v2.5 & v3.0)

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![KaiOS](https://img.shields.io/badge/KaiOS-2.5%20%7C%203.0-blue.svg)](https://www.kaiostech.com/)

A set of drop-in JavaScript polyfills that emulate the proprietary **KaiOS DeviceStorage API** in standard desktop browsers (Chrome, Firefox, Safari, Edge). 

These polyfills are designed for developers who want to build and debug KaiOS applications on their desktop machines without constantly needing a physical device or a slow emulator.

## 🚀 Features

- **High Accuracy:** Logic is mirrored directly from the original Gecko/B2G C++ source code (`nsDeviceStorage.cpp`).
- **Persistent Storage:** Uses **IndexedDB** as a backend; files you save persist even after refreshing the page.
- **Dual Volume Support:** Properly handles internal `sdcard` and external `sdcard1` volumes.
- **Event System:** Full support for `onchange` and `addEventListener('change')` events when files are created, modified, or deleted.
- **Async Iterators (KaiOS 3.0):** Implements the new `FileIterable` protocol, supporting `for await...of` loops for file enumeration.
- **Native File Compatibility:** Returns real `File` objects compatible with `URL.createObjectURL` and `FileReader`.
- **Built-in Explorer:** A visual UI to manage your virtual file system directly in the browser.

---

## 🛠 Installation

Simply include the desired version at the very top of your HTML file, before any other scripts:

```html
<!-- For KaiOS 2.5 Apps -->
<script src="kaios-storage-2.5.js"></script>

<!-- For KaiOS 3.0 Apps -->
<script src="kaios-storage-3.0.js"></script>
```

*Note: The polyfill automatically detects if it is running on a real KaiOS device and will disable itself to let the native API take over.*

---

## 📂 Built-in File Explorer

Both polyfills include a visual **DeviceStorage Explorer**. This allows you to upload files from your computer into the virtual KaiOS storage, delete files, or preview images/videos.

### How to open:
1. **Via URL Parameter:** Add `?explorer` to your app's URL.
   - `http://localhost:8080/index.html?explorer`
   - `http://localhost:8080/index.html?explorer=sdcard1` (Opens external SD card)
2. **Via Console:** Call `__DeviceStorageExplorer()` in the browser developer tools.

---

## 📖 API Usage

### KaiOS 3.0 (Modern)
The 3.0 version uses the `navigator.b2g` namespace and Async Iterators for enumeration.

```javascript
const sdcard = navigator.b2g.getDeviceStorage("sdcard");

// 1. Add a file
await sdcard.addNamed(myBlob, "photos/vacation.jpg");

// 2. Modern Enumeration (Async Iterator)
const iterable = sdcard.enumerate();
for await (const file of iterable) {
  console.log("Found file:", file.name, file.size);
}

// 3. Space usage
const free = await sdcard.freeSpace();
console.log(`Free space: ${free} bytes`);
```

### KaiOS 2.5 (Legacy)
The 2.5 version uses the direct `navigator` namespace and the legacy `DOMCursor` for enumeration.

```javascript
var storage = navigator.getDeviceStorage("pictures");

// 1. Add a file
var request = storage.addNamed(blob, "image.png");
request.onsuccess = function() { console.log("Saved!"); };

// 2. Legacy Enumeration (DOMCursor)
var cursor = storage.enumerate();
cursor.onsuccess = function() {
  var file = this.result;
  if (file) {
    console.log("File found: " + file.name);
    this.continue();
  }
};
```

---

## 🔍 Technical Implementation Details

To ensure 1:1 compatibility with native KaiOS apps, the following architectural details were implemented:

| Feature | KaiOS Native Behavior | Polyfill Implementation |
| :--- | :--- | :--- |
| **Backend** | Physical Disk / Ext4 / VFAT | IndexedDB (Object Store per volume) |
| **Request Object** | `DOMRequest` with `readyState` | Custom `StorageRequest` class with micro-tasking |
| **Enumeration** | `DOMCursor` (2.5) / `FileIterable` (3.0) | Full async iterator support |
| **Path Safety** | Rejects `..` and `~` | Strict regex validation for directory traversal |
| **MIME Handling** | Enforced by Storage Type | Validates Blob type against storage category |

---

## 📜 License

This project is licensed under the **Mozilla Public License 2.0 (MPL 2.0)** - the same license used by the original Gecko source code.

## 🤝 Contributing

If you find an edge-case where a native app behaves differently than the polyfill, please open an issue with a code snippet of the failing logic.
