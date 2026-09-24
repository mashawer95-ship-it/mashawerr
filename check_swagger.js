const fs = require('fs');
const code = fs.readFileSync('./config/swagger.js', 'utf8');
const compIdx = code.indexOf('        components: {');
const pathsIdx = code.indexOf('        paths: {');
const between = code.substring(compIdx, pathsIdx);

// Count braces OUTSIDE strings only
let depth = 0;
let inStr = false;
let strChar = '';
let lineNum = code.substring(0, compIdx).split('\n').length;

for (let i = 0; i < between.length; i++) {
    const c = between[i];
    if (between[i] === '\n') lineNum++;
    if (inStr) {
        if (c === strChar && between[i - 1] !== '\\') inStr = false;
        continue;
    }
    if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
    if (c === '`') { inStr = true; strChar = c; continue; }
    if (c === '{') depth++;
    if (c === '}') depth--;
}
console.log('Balance between components and paths (should be 0):', depth);
console.log('If > 0: need', depth, 'more closing braces before paths');
console.log('If < 0: need', Math.abs(depth), 'fewer closing braces before paths');
