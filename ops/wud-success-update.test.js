"use strict";
// 更新成功判据的方向性单测。
// 运行：node --test ops/
// 背景：2026-11-12 ttrss 被 mirror 换成 6 月的旧镜像，旧脚本的宽松判据
// 把「digest 变了」直接判成成功，于是发了成功邮件。这里把方向判定抽成
// 纯函数单独验证，避免再回归。
const test = require('node:test');
const assert = require('node:assert');
const { compareCreated } = require('./wud-success-update.js');

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
