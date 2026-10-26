// @ts-nocheck
import express from 'express';
import axios from 'axios';
import nocache from 'nocache';
import { timingSafeEqual } from 'crypto';
import * as registry from '../registry';
import * as store from '../store/container';
import * as event from '../event';
import { Container } from '../model/container';
import { RegistryPushHint } from '../registries/Registry';
import logger from '../log';
import * as component from './component';
import { requireRole } from './rbac';
import * as hubMirrorStore from '../store/hubMirror';
import * as https from 'https';
import * as dns from 'dns';
import * as net from 'net';

const log = logger.child({ component: 'registry-event' });

export function getRegistries(req, res) {
    return component.getAll(req, res, 'registry');
}

export function getRegistry(req, res) {
    return component.getById(req, res, 'registry');
}

/** How long to wait when probing a mirror's `/v2/` for reachability. */
const MIRROR_PROBE_TIMEOUT_MS = 8000;

/**
 * SSRF guard for mirror probes.
 *
 * By default we refuse to probe targets that resolve to a private / loopback /
 * link-local / CGNAT address. Set `WUD_REGISTRY_MIRROR_ALLOW_PRIVATE=true` to
 * permit a LAN mirror — this is intentionally opt-in and OFF by default.
 */
function allowPrivateTarget(): boolean {
    const v = process.env.WUD_REGISTRY_MIRROR_ALLOW_PRIVATE;
    return v === '1' || v === 'true' || v === 'yes';
}

/**
 * True when `ip` is a private / internal address that must never be probed
 * through an attacker-influenced input path. Covers IPv4 RFC1918, loopback,
 * link-local, CGNAT and the IPv6 equivalents.
 */
function isPrivateIp(ip: string): boolean {
    if (!net.isIP(ip)) return false;
    if (net.isIPv4(ip)) {
        const p = ip.split('.').map(Number);
        if (p[0] === 10) return true; // 10.0.0.0/8
        if (p[0] === 127) return true; // 127.0.0.0/8 loopback
        if (p[0] === 0) return true; // 0.0.0.0/8
        if (p[0] === 169 && p[1] === 254) return true; // 169.254.0.0/16
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
        if (p[0] === 192 && p[1] === 168) return true; // 192.168.0.0/16
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64.0.0/10
        return false;
    }
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower === '::') return true; // unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    return false;
}

/**
 * Resolve a hostname to a single IP. Uses the callback form of `dns.lookup`
 * because some Node builds do not expose a promise-based `dns.lookup` (they
 * require a callback even with `{ all: false }`), so the Promise overload would
 * throw "callback must be of type function". The callback form is portable.
 */
function resolveHost(
    host: string,
): Promise<{ address: string; family: number }> {
    return new Promise((resolve, reject) => {
        dns.lookup(host, { all: false }, (err, address, family) =>
            err ? reject(err) : resolve({ address, family }),
        );
    });
}

/**
 * Validate + resolve a mirror base URL for SSRF safety.
 *  - Rejects non http/https schemes (file://, gopher://, dict://, ...).
 *  - Resolves the hostname once and pins the IP (closes DNS-rebinding TOCTOU).
 *  - Flags private/loopback/link-local/CGNAT targets (caller blocks unless allowed).
 *
 * DNS failures are intentionally NOT blocked: we let the real request report
 * the target as unreachable rather than risk a false positive on split-horizon
 * or offline resolvers.
 */
async function resolveAndGuard(base: string): Promise<{
    ok: boolean;
    ip?: string | null;
    family?: number;
    blocked?: boolean;
    kind?: string;
    error?: string;
}> {
    let parsed: URL;
    try {
        parsed = new URL(base);
    } catch {
        return { ok: false, kind: 'invalid', error: 'malformed url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
            ok: false,
            kind: 'invalid',
            error: `unsupported scheme: ${parsed.protocol}`,
        };
    }
    try {
        const { address, family } = await resolveHost(parsed.hostname);
        const blocked = !allowPrivateTarget() && isPrivateIp(address);
        return { ok: true, ip: address, family, blocked };
    } catch {
        return { ok: true, ip: null, family: null, blocked: false };
    }
}

/**
 * Probe a single mirror base URL the same way the Hub provider would:
 * GET /v2/ and inspect the `WWW-Authenticate` challenge.
 *
 * Hardened against SSRF: only http/https are allowed, redirects are disabled
 * (`maxRedirects: 0`), the resolved IP is pinned to defeat DNS-rebinding, and
 * private/internal targets are blocked unless explicitly permitted.
 * @returns {{ok: boolean, status: number|string, kind: string, error?: string}}
 */
async function probeMirror(url) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!base) {
        return {
            ok: false,
            status: 'n/a',
            kind: 'invalid',
            error: 'empty url',
        };
    }
    const guard = await resolveAndGuard(base);
    if (!guard.ok) {
        return {
            ok: false,
            status: 'n/a',
            kind: guard.kind,
            error: guard.error,
        };
    }
    if (guard.blocked) {
        return {
            ok: false,
            status: 'BLOCKED',
            kind: 'private',
            error: 'target resolves to a private/internal address; set WUD_REGISTRY_MIRROR_ALLOW_PRIVATE=true to permit a LAN mirror',
        };
    }
    const parsed = new URL(base);
    const opts: any = {
        method: 'GET',
        url: `${base}/v2/`,
        validateStatus: () => true,
        timeout: MIRROR_PROBE_TIMEOUT_MS,
        maxRedirects: 0,
    };
    // Pin the resolved IP to close the DNS-rebinding TOCTOU window: connect
    // directly to the resolved address while keeping the original Host header
    // (and SNI for https) so the server still routes and validates correctly.
    // We drive the connection target ourselves instead of relying on a custom
    // dns lookup on the agent, which is not honoured on every Node build.
    if (guard.ip) {
        const ipLiteral = net.isIPv6(guard.ip) ? `[${guard.ip}]` : guard.ip;
        const port = parsed.port ? `:${parsed.port}` : '';
        const scheme = base.startsWith('https:') ? 'https' : 'http';
        opts.url = `${scheme}://${ipLiteral}${port}/v2/`;
        opts.headers = { Host: parsed.host };
        if (scheme === 'https') {
            opts.httpsAgent = new https.Agent({ servername: parsed.hostname });
        }
    }
    try {
        const response = await axios(opts);
        const www = String(
            (response.headers && response.headers['www-authenticate']) || '',
        );
        let kind = 'anonymous';
        if (/bearer/i.test(www)) {
            kind = 'bearer';
        } else if (/basic/i.test(www)) {
            kind = 'basic';
        }
        return {
            ok: response.status === 200 || response.status === 401,
            status: response.status,
            kind,
            auth: www.slice(0, 80),
        };
    } catch (e: any) {
        const msg = String((e && e.message) || e);
        const redirected = /maxredirects/i.test(msg);
        return {
            ok: false,
            status: 'ERR',
            kind: redirected ? 'redirect' : 'unreachable',
            error: msg.slice(0, 120),
        };
    }
}

/**
 * Effective mirror list the Hub provider will use right now.
 */
function getEffectiveMirrors() {
    const ui = hubMirrorStore.getMirrors();
    if (ui && ui.length > 0) {
        return ui;
    }
    return [];
}

/**
 * GET /api/registries/hub/mirrors
 * Return the UI-managed mirror list, the effective list, and a per-mirror
 * health probe. Read-only.
 */
export async function listHubMirrors(req, res) {
    try {
        const ui = hubMirrorStore.getMirrors() || [];
        const effective = getEffectiveMirrors();
        const health = [];
        for (const mirror of effective) {
            health.push({ url: mirror, ...(await probeMirror(mirror)) });
        }
        res.status(200).json({ ui, effective, health });
    } catch (e) {
        res.status(500).json({
            error: 'List hub mirrors failed',
            message: e.message,
        });
    }
}

/**
 * PUT /api/registries/hub/mirrors
 * Replace the UI-managed mirror list. Body: { mirrors: string[] }.
 * Empty array clears it so the provider falls back to env.
 */
export function setHubMirrors(req, res) {
    const body = req.body || {};
    if (!Array.isArray(body.mirrors)) {
        return res.status(400).json({
            error: 'Bad request',
            message: 'mirrors must be an array of url strings',
        });
    }
    const mirrors = body.mirrors
        .map((m) => String(m).trim())
        .filter((m) => m.length > 0);
    try {
        const persisted = hubMirrorStore.setMirrors(mirrors);
        res.status(200).json({
            ui: persisted,
            effective: getEffectiveMirrors(),
        });
    } catch (e) {
        res.status(500).json({
            error: 'Set hub mirrors failed',
            message: e.message,
        });
    }
}

/**
 * POST /api/registries/hub/mirrors/test
 * Probe a single mirror URL (useful before saving it). Body: { url }.
 */
export async function testHubMirror(req, res) {
    const body = req.body || {};
    const url = String(body.url || '').trim();
    if (!url) {
        return res.status(400).json({
            error: 'Bad request',
            message: 'url is required',
        });
    }
    try {
        const result = await probeMirror(url);
        res.status(200).json({ url, ...result });
    } catch (e) {
        res.status(500).json({
            error: 'Test hub mirror failed',
            message: e.message,
        });
    }
}

/**
 * Init Router.
 * @returns {*}
 */
export function init() {
    const router = express.Router();
    router.use(nocache());
    // Specific mirror-management routes, registered BEFORE the generic
    // /:type/:name component route so they are not swallowed by it.
    router.get(
        '/hub/mirrors',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        listHubMirrors,
    );
    router.put(
        '/hub/mirrors',
        requireRole(['admin', 'rw'], 'write'),
        setHubMirrors,
    );
    router.post(
        '/hub/mirrors/test',
        requireRole(['admin', 'rw'], 'write'),
        testHubMirror,
    );
    // Generic registry listing / lookup.
    router.use(component.init('registry'));
    return router;
}
export function matches(
    container: Container,
    hint: RegistryPushHint,
    registryId: string,
): boolean {
    try {
        const host = new URL(container.image.registry.url).host.toLowerCase();
        return (
            container.image.registry.name === registryId &&
            host === hint.host &&
            container.image.name === hint.repository &&
            container.image.tag.value === hint.tag
        );
    } catch {
        return false;
    }
}

// Successful hints expire; pending hints are bounded and reserved before any await.
const ttl = 60_000;
const capacity = 1000;

export function initEvents() {
    const router = express.Router();
    const recent = new Map<string, number>();
    const pending = new Set<string>();
    let queue = Promise.resolve();
    router.post(
        '/:name/events',
        (req, res, next) => {
            const provider = registry.getState().registry[req.params.name];
            const token = provider?.configuration?.webhook?.token;
            if (!token) {
                res.sendStatus(404);
                return;
            }
            const actual = Buffer.from(req.get('Authorization') || '');
            const expected = Buffer.from(`Bearer ${token}`);
            if (
                actual.length !== expected.length ||
                !timingSafeEqual(actual, expected)
            ) {
                res.sendStatus(401);
                return;
            }
            res.locals.registry = provider;
            next();
        },
        express.json({
            limit: '256kb',
            type: [
                'application/json',
                'application/vnd.docker.distribution.events.v1+json',
                'application/vnd.docker.distribution.events.v2+json',
            ],
        }),
        async (req, res) => {
            let hints: RegistryPushHint[];
            try {
                hints = res.locals.registry.parseWebhook(req.body);
            } catch {
                log.warn('Malformed registry notification');
                res.sendStatus(400);
                return;
            }
            for (const [key, expires] of recent)
                if (expires <= Date.now()) recent.delete(key);
            const accepted = hints
                .map((hint) => ({
                    hint,
                    key: JSON.stringify([
                        req.params.name,
                        hint.host,
                        hint.repository,
                        hint.tag,
                        hint.digest,
                    ]),
                }))
                .filter(({ key }) => !recent.has(key) && !pending.has(key));
            const unique = [
                ...new Map(accepted.map((item) => [item.key, item])).values(),
            ];
            if (unique.length === 0) {
                log.debug(
                    'Registry notification ignored (duplicate or unrelated event)',
                );
                res.status(202).json({ accepted: 0 });
                return;
            }
            if (pending.size + unique.length > capacity) {
                res.sendStatus(429);
                return;
            }
            unique.forEach(({ key }) => pending.add(key));
            const task = queue.then(async () => {
                try {
                    const stored = store.getContainers({});
                    const watchers = Object.values(
                        registry.getState().watcher,
                    ).filter((watcher) =>
                        stored.some(
                            (container) =>
                                container.watcher === watcher.name &&
                                unique.some(({ hint }) =>
                                    matches(container, hint, req.params.name),
                                ),
                        ),
                    );
                    const checked = new Set<string>();
                    for (const watcher of watchers) {
                        const fresh = await watcher.getContainers();
                        const selected = fresh.filter((container) =>
                            unique.some(({ hint }) =>
                                matches(container, hint, req.params.name),
                            ),
                        );
                        const reports =
                            await watcher.processWatchContainers(selected);
                        unique.forEach(({ key, hint }) => {
                            if (
                                reports.some((report) =>
                                    matches(
                                        report.container,
                                        hint,
                                        req.params.name,
                                    ),
                                )
                            )
                                checked.add(key);
                        });
                        event.emitContainerReports(reports);
                        if (reports.some((report) => report.container.error))
                            throw new Error('Registry check failed');
                    }
                    checked.forEach((key) => recent.set(key, Date.now() + ttl));
                    if (checked.size === 0)
                        log.debug(
                            'No watched containers matched registry notification',
                        );
                    while (recent.size > capacity)
                        recent.delete(recent.keys().next().value);
                } catch {
                    log.warn(
                        'Registry notification check failed; polling remains available',
                    );
                } finally {
                    unique.forEach(({ key }) => pending.delete(key));
                }
            });
            queue = task;
            res.status(202).json({ accepted: unique.length });
        },
    );
    return router;
}
