'use strict';

const actionui = require('actionui');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const https = require('https');
const { getLastError, clearError } = actionui;
const { exec, execSync } = require('child_process');

const REGISTRY = 'registry.npmjs.org';
const DOWNLOADS = 'api.npmjs.org';

const VIEW = {
    SEARCH_FIELD: 101,
    SORT_PICKER: 102,
    RESULTS_TABLE: 103,
    STATUS_TEXT: 104,
    PACKAGE_INFO: 111,
    NPM_LINK: 120,
    OPEN_REPO_BUTTON: 140,
    INSTALL_LOCATION_PICKER: 150,
    GLOBAL_PATH_TEXT: 151
};

const nodeDir = path.dirname(process.execPath);
const npmPath = path.join(nodeDir, 'npm');
const globalPrefix = path.join(nodeDir, '..');
const globalModulesPath = execSync(`"${npmPath}" root -g`, { encoding: 'utf8' }).trim();

// Worker for background network requests
function runInWorker(script, data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const workerData = ${JSON.stringify(data)};
            ${script}
        `, {
            eval: true
        });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}

// Network functions run in worker to not block main thread
async function searchPackagesWorker(query, sort) {
    return runInWorker(`
        const { parentPort } = require('worker_threads');
        const https = require('https');
        const REGISTRY = 'registry.npmjs.org';
        
        function httpsGet(hostname, path) {
            return new Promise((resolve, reject) => {
                const req = https.request({ hostname, path, method: 'GET', headers: { 'Accept': 'application/json' } }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
                });
                req.on('error', reject);
                req.end();
            });
        }
        
        (async () => {
            const params = new URLSearchParams({ text: workerData.query, size: 50 });
            const result = await httpsGet(REGISTRY, '/-/v1/search?' + params);
            parentPort.postMessage(result);
        })();
    `, { query, sort });
}

async function getDownloadsWorker(packageName) {
    return runInWorker(`
        const { parentPort } = require('worker_threads');
        const https = require('https');
        const DOWNLOADS = 'api.npmjs.org';
        
        function httpsGet(hostname, path) {
            return new Promise((resolve, reject) => {
                const req = https.request({ hostname, path, method: 'GET', headers: { 'Accept': 'application/json' } }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
                });
                req.on('error', reject);
                req.end();
            });
        }
        
        (async () => {
            try {
                const data = await httpsGet(DOWNLOADS, '/downloads/point/last-month/' + workerData.packageName);
                parentPort.postMessage(data.downloads || 0);
            } catch { parentPort.postMessage(0); }
        })();
    `, { packageName });
}

async function getPackageMetaWorker(packageName) {
    return runInWorker(`
        const { parentPort } = require('worker_threads');
        const https = require('https');
        const REGISTRY = 'registry.npmjs.org';
        
        function httpsGet(hostname, path) {
            return new Promise((resolve, reject) => {
                const req = https.request({ hostname, path, method: 'GET', headers: { 'Accept': 'application/json' } }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
                });
                req.on('error', reject);
                req.end();
            });
        }
        
        (async () => {
            try {
                const data = await httpsGet(REGISTRY, '/' + workerData.packageName);
                parentPort.postMessage(data);
            } catch { parentPort.postMessage(null); }
        })();
    `, { packageName });
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

const icon_path = path.join(__dirname, 'js.icns')
const app = new actionui.Application({ name: 'NPM Explorer', icon: icon_path });

let mainWindow = null;
let currentSearchResults = [];
let selectedPackage = null;
let lastQuery = null;
let lastSort = null;
let currentRepoUrl = null;
let currentNpmUrl = null;

app.onWillFinishLaunching(() => {
    const uiPath = path.join(__dirname, 'npm-explorer.json');
    app.loadAndPresentWindow(uiPath, null, 'NPM Explorer');
});

app.onWindowWillPresent((window) => {
    mainWindow = window;
    mainWindow.setValue(VIEW.GLOBAL_PATH_TEXT, 0, `Global: ${globalModulesPath}`);
    console.log('[NPM] Window ready');
});

app.onDidFinishLaunching(() => {
    // App is ready
});

async function performSearch(query, sort) {
    if (!query || !query.trim()) return;
    if (!mainWindow) { 
        console.log('[NPM] performSearch: no window');
        return; 
    }
    
    const trimmedQuery = query.trim();
    if (lastQuery === trimmedQuery && lastSort === sort) {
        console.log('[NPM] performSearch: skipping - no change');
        return;
    }
    
    lastQuery = trimmedQuery;
    lastSort = sort;
    
    console.log('[NPM] performSearch: querying', query);
    mainWindow.setValue(VIEW.STATUS_TEXT, 0, 'Searching...');
    
    try {
        const data = await searchPackagesWorker(query.trim(), sort);
        console.log('[NPM] performSearch: got', data.objects?.length || 0, 'results');
        
        if (!data.objects || data.objects.length === 0) {
            mainWindow.setValue(VIEW.STATUS_TEXT, 0, 'No results found');
            mainWindow.setRows(VIEW.RESULTS_TABLE, [[]]);
            return;
        }
        
        currentSearchResults = data.objects;
        
        if (sort === 'downloads') {
            data.objects.sort((a, b) => (b.downloads?.monthly || 0) - (a.downloads?.monthly || 0));
        } else if (sort === 'trending') {
            data.objects.sort((a, b) => (b.downloads?.weekly || 0) - (a.downloads?.weekly || 0));
        } else if (sort === 'updated') {
            data.objects.sort((a, b) => {
                const dateA = a.package?.date ? new Date(a.package.date) : new Date(0);
                const dateB = b.package?.date ? new Date(b.package.date) : new Date(0);
                return dateB - dateA;
            });
        }
        
        const rows = [];
        for (const pkg of data.objects) {
            const score = pkg.score ? (pkg.score.final || 0).toFixed(1) : '-';
            rows.push([
                pkg.package.name,
                (pkg.package.description || '').substring(0, 60),
                pkg.package.version || '-',
                score
            ]);
        }
        
        mainWindow.setRows(VIEW.RESULTS_TABLE, rows);
        mainWindow.setValue(VIEW.STATUS_TEXT, 0, `Found ${data.objects.length} packages for "${query}"`);
        
    } catch (e) {
        console.log('performSearch error:', e.message);
        mainWindow.setValue(VIEW.STATUS_TEXT, 0, 'Search failed: ' + e.message);
    }
}

async function showPackageDetails(packageName) {
    selectedPackage = packageName;
    
    mainWindow.setValue(VIEW.PACKAGE_INFO, 0, 'Loading package info...');
    mainWindow.setProperty(VIEW.OPEN_REPO_BUTTON, 'disabled', true);
    currentRepoUrl = null;
    currentNpmUrl = null;
    
    const pkgData = currentSearchResults.find(p => p.package.name === packageName);
    const downloadsWeekly = pkgData?.downloads?.weekly || 0;
    const downloadsMonthly = pkgData?.downloads?.monthly || 0;
    const packageDate = pkgData?.package?.date ? new Date(pkgData.package.date).toLocaleDateString() : null;
    
    try {
        console.log('[NPM] showPackageDetails: loading', packageName);
        const meta = await getPackageMetaWorker(packageName);
        
        if (!meta) {
            mainWindow.setValue(VIEW.PACKAGE_INFO, 0, 'Failed to load package info');
            return;
        }
        
        let info = `${packageName}\n`;
        
        if (meta.description) {
            info += `\n${meta.description}\n\n`;
        }
        
        info += `Version: ${meta['dist-tags']?.latest || '-'}\n`;
        
        if (packageDate) {
            info += `Published: ${packageDate}\n`;
        }
        
        if (downloadsWeekly > 0) {
            info += `Downloads: ${formatNumber(downloadsWeekly)}/week, ${formatNumber(downloadsMonthly)}/month\n`;
        }
        
        if (meta.author?.name) {
            info += `Author: ${meta.author.name}\n`;
        }
        
        if (meta.maintainers && meta.maintainers.length > 0) {
            info += `Maintainer: ${meta.maintainers[0].username}\n`;
        }
        
        if (meta.license) {
            info += `License: ${meta.license}\n`;
        }
        
        const latestVersion = meta['dist-tags']?.latest;
        const versionData = meta.versions?.[latestVersion];
        
        const deps = versionData?.dependencies ? Object.keys(versionData.dependencies) : [];
        if (deps.length > 0) {
            info += `\nDependencies: ${deps.join(', ')}`;
        }
        
        mainWindow.setValue(VIEW.PACKAGE_INFO, 0, info);
        
        let repoUrl = '';
        if (meta.homepage) {
            repoUrl = meta.homepage;
        } else if (meta.repository) {
            const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository.url;
            if (repo && repo.startsWith('git+')) {
                repoUrl = repo.replace('git+', '').replace('.git', '');
            } else if (repo) {
                repoUrl = repo;
            }
        }
        
        currentRepoUrl = repoUrl || null;
        
        const npmUrl = `https://www.npmjs.com/package/${packageName}`;
        currentNpmUrl = npmUrl;
        mainWindow.setProperty(VIEW.NPM_LINK, 'url', npmUrl);
        mainWindow.setProperty(VIEW.OPEN_REPO_BUTTON, 'disabled', false);
        
    } catch (e) {
        console.log('Details error:', e.message);
        mainWindow.setValue(VIEW.PACKAGE_INFO, 0, 'Error loading package: ' + e.message);
    }
}

app.action('npm.search', async (ctx) => {
    const text = mainWindow.getValueAsString(VIEW.SEARCH_FIELD, 0);
    console.log('[NPM] npm.search: text=', text);
    const sortPicker = mainWindow.getValueAsString(VIEW.SORT_PICKER, 0);
    console.log('[NPM] npm.search: sortPicker=', sortPicker);
    const sort = sortPicker || 'relevance';
    await performSearch(text, sort);
});

app.action('npm.sort.changed', async (ctx) => {
    const text = mainWindow.getValueAsString(VIEW.SEARCH_FIELD, 0);
    const sortPicker = mainWindow.getValueAsString(VIEW.SORT_PICKER, 0);
    const sort = sortPicker || 'relevance';
    if (text) {
        await performSearch(text, sort);
    }
});

app.action('npm.package.selection.changed', async (ctx) => {
    const selectedRow = mainWindow.getValue(VIEW.RESULTS_TABLE, 0);
    if (selectedRow && Array.isArray(selectedRow) && selectedRow.length > 0) {
        const packageName = selectedRow[0];
        await showPackageDetails(packageName);
    }
});

app.action('npm.install.package', async (ctx) => {
    if (selectedPackage) {
        let installArgs, cwd, locationNote, installTarget;
        if (installLocation === 'global') {
            installArgs = `install -g --prefix "${globalPrefix}" ${selectedPackage}`;
            installTarget = globalModulesPath;
            locationNote = ` globally to ${globalModulesPath}`;
        } else if (installLocation === 'custom') {
            installArgs = `install ${selectedPackage}`;
            const isNodeModules = customInstallPath.endsWith('/node_modules') || customInstallPath.endsWith('node_modules');
            cwd = isNodeModules ? path.dirname(customInstallPath) : customInstallPath;
            installTarget = cwd;
            locationNote = ` to ${cwd}`;
        } else {
            installArgs = `install ${selectedPackage}`;
            cwd = process.cwd();
            installTarget = cwd;
            locationNote = '';
        }

        const writable = isWritable(installTarget);

        if (!writable) {
          const choice = app.alert({
            title: 'Permission Required',
            message: `Cannot write to "${installTarget}". Use Terminal with sudo?`,
            style: 'warning',
            buttons: ['Use Terminal', 'Cancel']
         });
         if (choice === 'Use Terminal') {
                const sudoCmd = `sudo "${npmPath}" ${installArgs}`;
                const escapedCmd = sudoCmd.replace(/"/g, '\\"');
                const scriptPath = path.join('/tmp', `npm_install_${Date.now()}.applescript`);
                const scriptContent = `tell application "Terminal"\n    do script "${escapedCmd}"\n    activate\nend tell`;
                fs.writeFileSync(scriptPath, scriptContent);
                exec(`osascript "${scriptPath}"`, (err, stdout, stderr) => {
                    try { fs.unlinkSync(scriptPath); } catch(e) {}
                    mainWindow.setValue(VIEW.STATUS_TEXT, 0, err ? 'Failed: ' + err.message : 'Opened Terminal with sudo');
                });
            }
            return;
        }

        const cmd = `"${npmPath}" ${installArgs}`;
        exec(cmd, { cwd }, (error, stdout, stderr) => {
            if (error) {
                console.log('[NPM] install error:', error.message);
                mainWindow.setValue(VIEW.STATUS_TEXT, 0, 'Install failed: ' + error.message);
            } else {
                console.log('[NPM] install success');
                mainWindow.setValue(VIEW.STATUS_TEXT, 0, `Installed ${selectedPackage}${locationNote}`);
            }
        });
    }
});

function isWritable(dir) {
    try {
        const testFile = path.join(dir, '.npm_write_test_' + Date.now());
        fs.writeFileSync(testFile, '');
        fs.unlinkSync(testFile);
        return true;
    } catch {
        return false;
    }
}

let installLocation = 'global';
let customInstallPath = null;
app.action('npm.install.location.changed', async (ctx) => {
    installLocation = mainWindow.getValueAsString(VIEW.INSTALL_LOCATION_PICKER, 0);
    if (installLocation === 'global') {
        customInstallPath = null;
        mainWindow.setValue(VIEW.GLOBAL_PATH_TEXT, 0, `Global: ${globalModulesPath}`);
    } else if (installLocation === 'local') {
        customInstallPath = null;
        mainWindow.setValue(VIEW.GLOBAL_PATH_TEXT, 0, `Local: ${process.cwd()}/node_modules`);
    } else if (installLocation === 'custom') {
            const result = app.openPanel({
                title: 'Select Installation Directory',
                canChooseFiles: false,
                canChooseDirectories: true,
                canCreateDirectories: true
            });
            if (result && result.length > 0) {
                const isNodeModules = result[0].endsWith('/node_modules') || result[0].endsWith('node_modules');
                customInstallPath = isNodeModules ? path.dirname(result[0]) : result[0];
                mainWindow.setValue(VIEW.GLOBAL_PATH_TEXT, 0, `Custom: ${customInstallPath}/node_modules`);
            } else {
                mainWindow.setValue(VIEW.INSTALL_LOCATION_PICKER, 0, 'global');
                mainWindow.setValue(VIEW.GLOBAL_PATH_TEXT, 0, `Global: ${globalModulesPath}`);
            }
        }
});

app.run();