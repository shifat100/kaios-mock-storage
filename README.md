
# KaiOS Universal Device Storage Polyfill

![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-KaiOS_2.5_%26_3.0-orange.svg)

A robust simulation of the **KaiOS Device Storage API** (used in Firefox OS, KaiOS 2.5, and KaiOS 3.0) for modern web browsers. 

This library allows developers to test file management features (SD Card access, file creation, reading, and deletion) directly in Chrome, Firefox, or Edge without needing a physical KaiOS device or the simulator. It uses **IndexedDB** to persist files across sessions.

## 🚀 Features

*   **Universal Support:** Emulates both **KaiOS 2.5** (DOMRequest) and **KaiOS 3.0** (Promise-based/`b2g`) APIs.
*   **Persistent Storage:** Uses the browser's `IndexedDB` to save files. Files remain available even after refreshing the page.
*   **Multi-Storage Simulation:** Simulates Internal Storage (`/sdcard/`) and External SD Card (`/sdcard1/`).
*   **Hybrid Arrays:** Fully supports `getDeviceStorages()` returning iterable arrays.
*   **Built-in File Explorer:** Includes a visual GUI to upload, rename, and delete files for debugging purposes.



## 📦 Installation

Simply download the script and include it in your `index.html` **before** your main application logic.

```html
<script src="path/to/kaios-storage-polyfill.js"></script>
<script src="app.js"></script>
```

> **Note:** This script overwrites `navigator.getDeviceStorage` and `navigator.b2g.getDeviceStorage`. Ensure you only load this in a development environment or wrap it in a condition if deploying to a real device.

---

## 🛠 Usage

### 1. KaiOS 2.5 Style (DOMRequest)
Used by most legacy KaiOS devices. Returns a `DOMRequest` object with `onsuccess` and `onerror`.

```javascript
// Get storage access (music, pictures, videos, sdcard)
var storage = navigator.getDeviceStorage('sdcard');

// Create a file
var file = new Blob(["Hello KaiOS"], {type: "text/plain"});
var request = storage.addNamed(file, "my_document.txt");

request.onsuccess = function () {
    console.log("File saved: " + this.result);
};

request.onerror = function () {
    console.error("Error: " + this.error.name);
};
```

### 2. KaiOS 3.0 Style (Async/Promise)
Used by newer KaiOS 3.x devices via the `navigator.b2g` namespace.

```javascript
async function saveFile() {
    // Note the use of 'b2g' namespace
    const storage = navigator.b2g.getDeviceStorage('sdcard');
    const file = new Blob(["Async Content"], {type: "text/plain"});

    try {
        const path = await storage.addNamed(file, "async_doc.txt");
        console.log("File created at: ", path);
    } catch (err) {
        console.error("Save failed", err);
    }
}
```

### 3. Handling Multiple Storages (SD Card)
Accessing internal vs. external storage.

```javascript
// Returns an array: [0] = Internal, [1] = SD Card
var storages = navigator.getDeviceStorages('sdcard');

// Save to External SD Card (/sdcard1/)
var sdCard = storages[1]; 
sdCard.addNamed(blob, "backup.dat");
```

---

## 📂 Visual File Explorer (Debug Mode)

This polyfill comes with a built-in GUI to help you manage the virtual file system without writing code.

**How to activate:**
Add `?mode=explorer` to your browser URL.

**Example:**
`http://localhost:8080/index.html?mode=explorer`

**Explorer Capabilities:**
*   Select Drive (Internal `/sdcard/` or External `/sdcard1/`).
*   **Upload** real files from your computer to the virtual storage.
*   **Rename** existing virtual files.
*   **Delete** virtual files.

![Explorer Mode](https://via.placeholder.com/600x200?text=Explorer+Mode+UI+Preview)

---

## 📖 API Support Matrix

| Method | Description | KaiOS 2.5 | KaiOS 3.0 |
| :--- | :--- | :---: | :---: |
| `add(file)` | Add file with auto-generated name | ✅ | ✅ |
| `addNamed(file, name)` | Add file with specific name | ✅ | ✅ |
| `get(name)` | Retrieve a file as a Blob/File | ✅ | ✅ |
| `delete(name)` | Remove a file | ✅ | ✅ |
| `enumerate()` | List all files (Cursor/Iterator) | ✅ | ✅ |
| `freeSpace()` | Check available space | ✅ | ❌ |
| `spaceInfo()` | Check space (Total/Used/Free) | ❌ | ✅ |
| `addEventListener` | Listen for 'change' events | ✅ | ❌ |

---

## 🔧 Technical Details

*   **Database Name:** `KaiOS_Universal_Storage` (IndexedDB)
*   **Store Name:** `files`
*   **Virtual Paths:**
    *   Internal: prepends `/sdcard/`
    *   External: prepends `/sdcard1/`

## 📝 License

This project is licensed under the **MIT License**.

**Author:** [shifat100]  
**Last Updated:** 2026-03-03
