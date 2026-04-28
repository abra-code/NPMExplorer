# NPMExplorer

![NPMExplorer Icon](Icon/js-macOS-128x128@2x.png)

NPM package explorer applet for searching npm registry.  
Native macOS UI built with [ActionUI](https://github.com/abra-code/ActionUI)

## Development Setup

This project requires node.js which can be downloaded from [nodejs.org](https://nodejs.org/en/download).  
NPMExplorer depends on the local `ActionUI` module, which currently is not published to npm registry and must exist in the local filesystem.  
(This is a temporary setup until the ActionUI node.js pre-built module is published)  

### 1. Clone both repositories

```bash
git clone https://github.com/abra-code/ActionUI.git
git clone https://github.com/abra-code/NPMExplorer.git
```

The ActionUI module is expected to be at `../ActionUI/ActionUINodeJS` relative to this project (sibling directories).

### 2. Build ActionUI native module

```bash
cd ActionUI/ActionUINodeJS
./build_and_install.sh
```

### 3. Install local dependencies

```bash
cd NPMExplorer
npm install
```

This symlinks `actionui` from `../ActionUI/ActionUINodeJS` into `node_modules`.

### 4. Run the app

```bash
node index.js
```
