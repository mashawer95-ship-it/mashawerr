const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const IGNORED_DIRS = ['.git', 'node_modules', 'uploads', 'dist', 'build', '.idea', '.vscode'];
const IGNORED_EXTS = ['.log', '.tmp'];

let debounceTimer = null;
let isPushing = false;
let modifiedFiles = new Set();

console.log('====================================================');
console.log('🚀 Mashawerr API: Auto Git Push Watcher Started');
console.log(`📁 Watching directory: ${PROJECT_DIR}`);
console.log('⚡ Any saved change will automatically be pushed to GitHub!');
console.log('====================================================');

function shouldIgnore(filename) {
    if (!filename) return true;
    const normalized = filename.replace(/\\/g, '/');
    for (const dir of IGNORED_DIRS) {
        if (normalized.startsWith(dir + '/') || normalized === dir || normalized.includes('/' + dir + '/')) {
            return true;
        }
    }
    for (const ext of IGNORED_EXTS) {
        if (normalized.endsWith(ext)) return true;
    }
    return false;
}

function handleAutoPush() {
    if (isPushing) return;
    isPushing = true;

    try {
        const status = execSync('git status --porcelain', { cwd: PROJECT_DIR }).toString().trim();
        if (!status) {
            console.log('ℹ️ No git changes detected.');
            isPushing = false;
            return;
        }

        console.log('\n🔍 Validating JavaScript syntax before pushing...');
        const lines = status.split('\n');
        for (const line of lines) {
            const filePath = line.substring(3).trim();
            if (filePath.endsWith('.js') && fs.existsSync(path.join(PROJECT_DIR, filePath))) {
                try {
                    execSync(`node -c "${filePath}"`, { cwd: PROJECT_DIR, stdio: 'pipe' });
                } catch (err) {
                    console.error(`❌ Syntax Error in ${filePath}! Push canceled to protect deployment:`);
                    console.error(err.stderr ? err.stderr.toString() : err.message);
                    isPushing = false;
                    return;
                }
            }
        }

        console.log('📦 Staging files (git add -A)...');
        execSync('git add -A', { cwd: PROJECT_DIR });

        const timestamp = new Date().toLocaleString('sv-SE', { timeZoneName: 'short' });
        const commitMessage = `Auto-push backend updates: ${timestamp}`;
        console.log(`📝 Committing: "${commitMessage}"...`);
        execSync(`git commit -m "${commitMessage}"`, { cwd: PROJECT_DIR });

        console.log('🚀 Pushing to GitHub (origin main)...');
        execSync('git push origin main', { cwd: PROJECT_DIR });

        console.log('✅ Successfully pushed to GitHub! Render is deploying updates.\n');
    } catch (err) {
        console.error('❌ Auto-push error:', err.message);
        if (err.stdout) console.log(err.stdout.toString());
        if (err.stderr) console.error(err.stderr.toString());
    } finally {
        isPushing = false;
        modifiedFiles.clear();
    }
}

try {
    fs.watch(PROJECT_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename || shouldIgnore(filename)) return;

        modifiedFiles.add(filename);
        console.log(`[Event: ${eventType}] Modified: ${filename}`);

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log('\n⏳ Change settled. Initiating auto-push to GitHub...');
            handleAutoPush();
        }, 2500);
    });
} catch (e) {
    console.error('Failed to start watcher:', e);
}
