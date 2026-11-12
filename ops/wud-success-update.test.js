"use strict";
// 更新成功判据的方向性单测。
// 运行：node --test ops/
// 背景：2026-11-12 ttrss 被 mirror 换成 6 月的旧镜像，旧脚本的宽松判据
// 把「digest 变了」直接判成成功，于是发了成功邮件。这里把方向判定抽成
// 纯函数单独验证，避免再回归。
const test = require('node:test');
const assert = require('node:assert');
const { compareCreated, decideVerdict } = require('./wud-success-update.js');

test('compareCreated: 时间前进判定为升级', () => {
    assert.strictEqual(
        compareCreated('2026-06-15T23:00:43.830Z', '2026-11-11T00:58:55.205Z'),
        'newer',
    );
});

test('compareCreated: 时间倒退判定为降级（11-12 ttrss 事件回放）', () => {
    // 本机原本是 2026-11-11 的新镜像，被 mirror 换成 2026-06-15 的旧镜像
    assert.strictEqual(
        compareCreated('2026-11-11T00:58:55.205Z', '2026-06-15T23:00:43.830Z'),
        'older',
    );
});

test('compareCreated: 时间相同判定为持平', () => {
    assert.strictEqual(
        compareCreated('2026-11-11T00:58:55.205Z', '2026-11-11T00:58:55.205Z'),
        'same',
    );
});

test('compareCreated: 任一侧缺失时返回 unknown，不臆断方向', () => {
    assert.strictEqual(compareCreated(null, '2026-11-11T00:58:55.205Z'), 'unknown');
    assert.strictEqual(compareCreated('2026-11-11T00:58:55.205Z', null), 'unknown');
    assert.strictEqual(compareCreated(undefined, undefined), 'unknown');
});

test('compareCreated: 非法时间字符串返回 unknown', () => {
    assert.strictEqual(compareCreated('not-a-date', '2026-11-11T00:58:55.205Z'), 'unknown');
});

test('compareCreated: 同一时刻的不同写法视为持平', () => {
    assert.strictEqual(
        compareCreated('2026-11-11T00:58:55Z', '2026-11-11T00:58:55.000Z'),
        'same',
    );
});

// ─────────────────────────────────────────────────────────────
// decideVerdict：整条判定链的回归测试。
// 红线：digest 变了但方向不明，绝不能判成功——旧脚本正是这样谎报的。
// ─────────────────────────────────────────────────────────────

test('decideVerdict: 构建时间倒退 → 降级，即使 digest 变了也不判成功', () => {
    const r = decideVerdict({
        beforeCreated: '2026-11-11T00:58:55.205Z',
        afterCreated: '2026-06-15T23:00:43.830Z',
        beforeValue: 'sha256:5eb139c5',
        afterValue: 'sha256:3cca2ee5',
        beforeRepo: 'sha256:2c728ec0',
        afterRepo: 'sha256:46abe3e6',
        updateAvailable: true,
        rebuilt: true,
        targetV: 'sha256:5eb139c5',
    });
    assert.strictEqual(r.verdict, 'downgrade');
    assert.match(r.errMsg, /倒退/);
});

test('decideVerdict: 降级优先于 updateAvailable=false（同时成立仍判降级）', () => {
    const r = decideVerdict({
        beforeCreated: '2026-11-11T00:58:55.205Z',
        afterCreated: '2026-06-15T23:00:43.830Z',
        beforeValue: 'sha256:a',
        afterValue: 'sha256:b',
        beforeRepo: 'sha256:c',
        afterRepo: 'sha256:d',
        updateAvailable: false,
        rebuilt: true,
        targetV: 'sha256:a',
    });
    assert.strictEqual(r.verdict, 'downgrade');
});

test('decideVerdict: updateAvailable 变 false → 收敛成功', () => {
    const r = decideVerdict({
        beforeCreated: '2026-06-15T23:00:43.830Z',
        afterCreated: '2026-11-11T00:58:55.205Z',
        beforeValue: 'sha256:3cca2ee5',
        afterValue: 'sha256:5eb139c5',
        beforeRepo: 'sha256:46abe3e6',
        afterRepo: 'sha256:2c728ec0',
        updateAvailable: false,
        rebuilt: true,
        targetV: 'sha256:5eb139c5',
    });
    assert.strictEqual(r.verdict, 'confirmed');
    assert.match(r.reason, /收敛/);
});

test('decideVerdict: 已重建且 digest 命中目标 → 成功', () => {
    const r = decideVerdict({
        beforeCreated: null,
        afterCreated: null,
        beforeValue: 'sha256:old',
        afterValue: 'sha256:target',
        beforeRepo: null,
        afterRepo: null,
        updateAvailable: true,
        rebuilt: true,
        targetV: 'sha256:target',
    });
    assert.strictEqual(r.verdict, 'confirmed');
    assert.match(r.reason, /目标 digest/);
});

test('decideVerdict: 未重建时不认 digest 命中（可能只是 tag 指向变了）', () => {
    const r = decideVerdict({
        beforeCreated: null,
        afterCreated: null,
        beforeValue: 'sha256:old',
        afterValue: 'sha256:target',
        beforeRepo: null,
        afterRepo: null,
        updateAvailable: true,
        rebuilt: false,
        targetV: 'sha256:target',
    });
    assert.notStrictEqual(r.verdict, 'confirmed');
});

test('decideVerdict: 构建时间前进 → 成功', () => {
    const r = decideVerdict({
        beforeCreated: '2026-06-15T23:00:43.830Z',
        afterCreated: '2026-11-11T00:58:55.205Z',
        beforeValue: 'sha256:a',
        afterValue: 'sha256:b',
        beforeRepo: null,
        afterRepo: null,
        updateAvailable: true,
        rebuilt: true,
        targetV: 'sha256:other',
    });
    assert.strictEqual(r.verdict, 'confirmed');
    assert.match(r.reason, /构建时间前进/);
});

test('decideVerdict: digest 变了但两侧都没构建时间 → pending，不谎报成功', () => {
    // 2026-11-12 ttrss 被旧脚本判成功的情形：只剩 digest 可看。
    const r = decideVerdict({
        beforeCreated: null,
        afterCreated: null,
        beforeValue: 'sha256:3cca2ee5',
        afterValue: 'sha256:46abe3e6',
        beforeRepo: null,
        afterRepo: null,
        updateAvailable: true,
        rebuilt: false,
        targetV: 'sha256:zzz',
    });
    assert.strictEqual(r.verdict, 'pending');
    assert.match(r.reason, /无法确认方向/);
});

test('decideVerdict: repo digest 变化也计入 pending', () => {
    const r = decideVerdict({
        beforeCreated: null,
        afterCreated: null,
        beforeValue: null,
        afterValue: null,
        beforeRepo: 'sha256:46abe3e6',
        afterRepo: 'sha256:2c728ec0',
        updateAvailable: true,
        rebuilt: false,
        targetV: 'sha256:zzz',
    });
    assert.strictEqual(r.verdict, 'pending');
});

test('decideVerdict: 什么都没变 → null，继续轮询', () => {
    const r = decideVerdict({
        beforeCreated: '2026-11-11T00:58:55.205Z',
        afterCreated: '2026-11-11T00:58:55.205Z',
        beforeValue: 'sha256:a',
        afterValue: 'sha256:a',
        beforeRepo: 'sha256:c',
        afterRepo: 'sha256:c',
        updateAvailable: true,
        rebuilt: false,
        targetV: 'sha256:a',
    });
    assert.strictEqual(r.verdict, null);
});

test('decideVerdict: 构建时间持平且 digest 未变 → null', () => {
    const r = decideVerdict({
        beforeCreated: '2026-11-11T00:58:55.205Z',
        afterCreated: '2026-11-11T00:58:55.205Z',
        beforeValue: null,
        afterValue: null,
        beforeRepo: null,
        afterRepo: null,
        updateAvailable: true,
        rebuilt: false,
        targetV: null,
    });
    assert.strictEqual(r.verdict, null);
});
