#!/usr/bin/env node
/**
 * Guard against hard-coded user-visible strings in the WUD UI.
 *
 * The fork ships a zh-CN catalog; every visible label has to go through
 * `$t()` / `t()`. Upstream has no i18n layer, so without this check every sync
 * silently reintroduces English literals (that is exactly how the 12 files
 * fixed in this batch went unnoticed).
 *
 * The rules are deliberately conservative: a false positive would turn CI red
 * on every upstream merge, which would quickly get the check disabled. It
 * therefore only reports:
 *   - text nodes made of two or more capitalised words ("Application Logs")
 *   - attribute values that contain a space or start with a capital letter
 * and it ignores bound attributes (`:label="$t(...)"`), interpolations and
 * Vuetify field references such as `item-title="title"`.
 *
 * Usage: node ui/scripts/check-i18n-hardcoded.cjs [--verbose]
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const VERBOSE = process.argv.includes('--verbose');

// Attribute whose value is rendered to the user.
const ATTRS = [
    'label',
    'placeholder',
    'title',
    'header-text',
    'hint',
    'aria-label',
    'no-data-text',
];

// Values that are identifiers, not copy.
const ALLOWED = new Set(['title', 'subtitle', 'name', 'id', 'type', 'value']);

const ATTR_RE = new RegExp(
    `(?<![\\w@:.-])(${ATTRS.join('|')})\\s*=\\s*"([^"]*)"`,
    'g',
);
// Two or more words, starting with a capital letter: "Application Logs".
const TEXT_RE = />\s*([A-Z][A-Za-z0-9]+(?:[ ,./&'()!?:-]+[A-Za-z0-9]+)+)\s*</g;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (entry.name.endsWith('.vue')) {
            out.push(full);
        }
    }
    return out;
}

function lineOf(content, index) {
    return content.slice(0, index).split('\n').length;
}

function lineTextAt(content, line) {
    return content.split('\n')[line - 1] || '';
}

/** Blank out HTML comments so their prose is not reported. */
function stripComments(content) {
    return content.replace(/<!--[\s\S]*?-->/g, (m) =>
        m.replace(/[^\n]/g, ' '),
    );
}

const findings = [];

for (const file of walk(SRC)) {
    const raw = fs.readFileSync(file, 'utf8');
    const content = stripComments(raw);
    const rel = path.relative(path.resolve(SRC, '..', '..'), file);

    for (const match of content.matchAll(ATTR_RE)) {
        const [, attr, value] = match;
        if (!value) continue;
        if (ALLOWED.has(value)) continue;
        if (!/^[A-Z]/.test(value) && !value.includes(' ')) continue;
        const line = lineOf(content, match.index);
        const text = lineTextAt(content, line);
        if (/\$t\(|\bt\(/.test(text)) continue;
        findings.push({ file: rel, line, rule: 'attribute', detail: `${attr}="${value}"` });
    }

    for (const match of content.matchAll(TEXT_RE)) {
        const value = match[1].trim();
        const line = lineOf(content, match.index);
        const text = lineTextAt(content, line);
        if (/\$t\(|\bt\(/.test(text)) continue;
        findings.push({ file: rel, line, rule: 'text', detail: value });
    }
}

if (findings.length === 0) {
    if (VERBOSE) {
        console.log('check-i18n: no hard-coded UI strings found');
    }
    process.exit(0);
}

console.error(
    `check-i18n: ${findings.length} hard-coded UI string(s) found. ` +
        'Move them to ui/src/i18n/{en,zh-CN}.ts and render them with $t().',
);
for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`);
}
process.exit(1);
