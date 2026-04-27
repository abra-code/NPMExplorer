'use strict';

const actionui = require('actionui');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REGISTRY = 'registry.npmjs.org';
const DOWNLOADS = 'api.npmjs.org';

function httpsGet(hostname, path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: path,
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.end();
    });
}

async function searchPackages(query, sort = 'relevance') {
    const params = new URLSearchParams({
        text: query,
        size: 50,
    });
    if (sort === 'popularity') params.set('popularity', '1.0');
    else if (sort === 'quality') params.set('quality', '1.0');
    else if (sort === 'maintenance') params.set('maintenance', '1.0');
    
    return httpsGet(REGISTRY, `/-/v1/search?${params}`);
}

async function getDownloads(packageName) {
    try {
        const data = await httpsGet(DOWNLOADS, `/downloads/point/last-month/${packageName}`);
        return data.downloads || 0;
    } catch { return 0; }
}

async function getPackageMeta(packageName) {
    try {
        return await httpsGet(REGISTRY, `/${packageName}`);
    } catch { return null; }
}

function dumpMeta(meta) {
    if (!meta) { console.log('No meta found'); return; }
    const latest = meta['dist-tags']?.latest;
    const ver = meta.versions?.[latest];
    
    console.log('\n=== META DUMP ===');
    console.log('name:', meta.name);
    console.log('latest:', latest);
    console.log('description:', meta.description?.slice(0, 80));
    console.log('license:', meta.license);
    console.log('author:', meta.author?.name);
    console.log('maintainers:', meta.maintainers?.map(m => m.username));
    console.log('keywords:', meta.keywords?.slice(0, 10));
    console.log('homepage:', meta.homepage);
    console.log('repository:', meta.repository?.url);
    console.log('bugs:', meta.bugs?.url);
    console.log('\n--- dependencies ---');
    console.log(ver?.dependencies ? Object.keys(ver.dependencies) : []);
    console.log('\n--- devDependencies ---');
    console.log(ver?.devDependencies ? Object.keys(ver.devDependencies) : []);
    console.log('\n--- other version info ---');
    console.log('engines:', ver?.engines);
    console.log('scripts:', ver?.scripts);
    console.log('dist:', ver?.dist);
    console.log('funding:', ver?.funding);
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

// Test the API directly first (no UI)
const pkg = process.argv[2] || 'express';

async function testAPI() {
    console.log('Testing npm API for:', pkg);
    try {
        const meta = await getPackageMeta(pkg);
        dumpMeta(meta);
        console.log('\nAPI test PASSED');
    } catch (e) {
        console.error('API test failed:', e.message);
    }
    process.exit(0);
}

testAPI();