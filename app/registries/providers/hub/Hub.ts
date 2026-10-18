import axios, { AxiosRequestConfig, AxiosResponse, Method } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import Custom from '../custom/Custom';
import { BearerChallenge } from '../../DockerRegistryV2';
import { getUserAgent } from '../../Registry';
import { ContainerImage } from '../../../model/container';
import * as hubMirrorStore from '../../../store/hubMirror';
import { applyProxyConfig } from '../../../http/proxy';

/** Default Docker Hub registry API base. */
const DEFAULT_HUB_URL = 'https://registry-1.docker.io';
/** Default Docker Hub token endpoint (used to fetch pull tokens). */
const DEFAULT_HUB_AUTH_URL = 'https://auth.docker.io/token';
/** Default `service` parameter expected by the Docker Hub token endpoint. */
const DEFAULT_HUB_SERVICE = 'registry.docker.io';

/**
 * How long a mirror's (possibly missing) `WWW-Authenticate` challenge is
 * cached.
 *
 * Anonymous mirrors answer 200 on `/v2/`, i.e. they advertise no challenge at
 * all. Without this cache every registry call would pay an extra round trip to
 * re-discover that fact. The TTL is short enough that a mirror switching to
 * authenticated mode is picked up without a restart.
 */
const MIRROR_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * Docker Hub integration.
 *
 * The Hub may be unreachable from some networks (network-level blocking, rate
 * limiting, ...). The registry API base and its token endpoint can therefore be
 * overridden to point at a Docker Hub mirror:
 *
 * - `url`     : registry API base (default `https://registry-1.docker.io`)
 * - `authurl` : token endpoint (default `https://auth.docker.io/token`)
 * - `service` : `service` parameter sent to the token endpoint
 *
 * When a custom `url` is configured without an explicit `authurl`, the mirror is
 * considered anonymous and no `Authorization` header is sent.
 *
 * ## Multi-mirror failover (fork feature, 2026-09-21)
 *
 * `url` may be a comma-separated list of mirror base URLs. Each mirror is tried
 * in order; when one fails the next is tried (see `callRegistry`). The list can
 * also be edited from the web UI (persisted in the store); when a UI list
 * exists it takes priority over the env var.
 *
 * Authentication is per-mirror and auto-discovered: each mirror that
 * advertises a `WWW-Authenticate: Bearer realm=...` challenge on its `/v2/` is
 * used to fetch a pull token on its own token endpoint; a mirror that does not
 * advertise a realm is treated as anonymous (no `Authorization` header).
 */
class Hub extends Custom {
    /**
     * Mirror in effect for the current `callRegistry` attempt.
     *
     * The failover loop used to rewrite `this.configuration.url/authurl/service`
     * for the duration of an attempt and restore them in a `finally`. But
     * `Docker.ts` fans containers out with `Promise.all` (and the base class
     * allows a couple of concurrent requests per registry), so several
     * `callRegistry` calls interleave on the same provider instance. The
     * save/restore pairs then stop matching: a call can restore the temporary
     * value captured by another one, leaving `configuration.url` pointing at an
     * arbitrary mirror. That value is not cosmetic - `normalizeImage()` writes
     * it into `image.registry.url` (persisted with the container) and
     * `getImageFullName()` uses it to build the reference passed to
     * `docker pull`, so a corrupted value makes update triggers pull from the
     * wrong host.
     *
     * Carrying the mirror through `AsyncLocalStorage` keeps the provider
     * configuration immutable and gives every await chain its own value,
     * without serializing requests behind a lock.
     */
    private static readonly mirrorContext = new AsyncLocalStorage<string>();

    /**
     * Cache of per-mirror auth challenges (see `MIRROR_CHALLENGE_TTL_MS`).
     * `challenge` is undefined for mirrors that do not require auth.
     */
    private mirrorChallengeCache = new Map<
        string,
        { challenge?: BearerChallenge; expiresAt: number }
    >();

    /**
     * The mirror list from the env var (possibly comma-separated), captured
     * before `init()` collapses `configuration.url` to the first mirror.
     */
    private envMirrors: string[] = [];

    async init() {
        this.envMirrors = this.parseMirrorCsv(this.configuration.url);

        const firstMirror = this.getMirrors()[0];
        this.configuration.url = firstMirror || DEFAULT_HUB_URL;

        const isDefaultRegistry = this.configuration.url === DEFAULT_HUB_URL;

        // Token endpoint:
        // - default registry => the real Docker Hub token endpoint
        // - custom registry  => undefined => mirror token auto-discovery
        if (!this.configuration.authurl) {
            this.configuration.authurl = isDefaultRegistry
                ? DEFAULT_HUB_AUTH_URL
                : undefined;
        }

        // `service` parameter expected by the token endpoint.
        if (!this.configuration.service) {
            this.configuration.service = isDefaultRegistry
                ? DEFAULT_HUB_SERVICE
                : this.getRegistryHost();
        }

        if (this.configuration.token) {
            this.configuration.password = this.configuration.token;
        }
    }

    /**
     * Split a raw env value on commas into trimmed, non-empty mirror URLs.
     */
    private parseMirrorCsv(value: unknown): string[] {
        const raw = String(value || '').trim();
        if (!raw) {
            return [];
        }
        return raw
            .split(',')
            .map((m) => m.trim())
            .filter((m) => m.length > 0)
            .map((m) => Hub.trimTrailingSlash(m));
    }

    /**
     * Ordered list of mirror base URLs to try, first one wins.
     *
     * Priority (agreed with product owner 2026-09-21):
     *   1. the UI-managed list persisted in the store (source of truth);
     *   2. the env `url` value, which may itself be comma-separated;
     *   3. the default Docker Hub.
     */
    getMirrors(): string[] {
        const uiMirrors = hubMirrorStore.getMirrors();
        if (uiMirrors && uiMirrors.length > 0) {
            return uiMirrors.map((m) => Hub.trimTrailingSlash(m));
        }
        if (this.envMirrors.length > 0) {
            return this.envMirrors;
        }
        return [DEFAULT_HUB_URL];
    }

    private static trimTrailingSlash(url: string): string {
        return String(url || '').replace(/\/+$/, '');
    }

    /**
     * Mirror to use for the request currently being processed. Falls back to
     * the configured base when called outside of a `callRegistry` attempt.
     */
    private currentMirror(): string {
        return (
            Hub.mirrorContext.getStore() ||
            this.configuration.url ||
            DEFAULT_HUB_URL
        );
    }

    /**
     * Override of the registry HTTP entry point to add mirror failover.
     *
     * Each mirror is tried in order; the first success is returned. Every
     * failure (network error, 4xx, 5xx) is recorded and the next mirror is
     * tried; if every mirror fails the last error is re-thrown.
     *
     * The mirror is passed down through `AsyncLocalStorage` rather than by
     * mutating `this.configuration`, so concurrent calls cannot observe each
     * other's mirror.
     */
    async callRegistry<T = any>(options: {
        image: ContainerImage;
        url: string;
        method?: Method;
        headers?: any;
        resolveWithFullResponse: true;
    }): Promise<AxiosResponse<T>>;
    async callRegistry<T = any>(options: {
        image: ContainerImage;
        url: string;
        method?: Method;
        headers?: any;
        resolveWithFullResponse?: false;
    }): Promise<T>;
    async callRegistry<T = any>({
        image,
        url,
        method,
        headers,
        resolveWithFullResponse,
    }: {
        image: ContainerImage;
        url: string;
        method?: Method;
        headers?: any;
        resolveWithFullResponse?: boolean;
    }): Promise<T | AxiosResponse<T>> {
        const mirrors = this.getMirrors();
        let lastError: any;

        for (const mirror of mirrors) {
            try {
                // The base class overloads require literal true/false; we carry
                // the caller's boolean through via a cast to preserve the
                // return shape.
                const result = await Hub.mirrorContext.run(mirror, () =>
                    super.callRegistry({
                        image,
                        url: Hub.rewriteUrlForMirror(url, mirror),
                        method,
                        headers,
                        resolveWithFullResponse,
                    } as any),
                );
                return result;
            } catch (e: any) {
                lastError = e;
                this.log.warn(
                    `Mirror ${mirror} failed for ${image && image.name} (${e && e.message}); trying next mirror`,
                );
            }
        }
        throw lastError;
    }

    /**
     * Point an absolute registry URL at another mirror, keeping the path and
     * query untouched:
     * `https://a.example.com/v2/foo/tags/list?n=1` -> `https://b/v2/foo/...`.
     *
     * Deriving the base from the URL itself (instead of assuming the first
     * configured mirror) also keeps requests correct when the mirror list is
     * edited in the UI after the provider was initialized.
     */
    private static rewriteUrlForMirror(url: string, mirror: string): string {
        const base = /^https?:\/\/[^/]+\/v2(?=\/|$)/.exec(String(url || ''));
        if (!base) {
            return url;
        }
        return `${mirror}/v2${String(url).slice(base[0].length)}`;
    }

    private isDefaultHub(url: string): boolean {
        return (
            Hub.trimTrailingSlash(url) ===
            Hub.trimTrailingSlash(DEFAULT_HUB_URL)
        );
    }

    /**
     * Whether `mirror` is the primary one, i.e. the one `init()` configured the
     * provider with (`authurl`/`service` belong to it).
     */
    private isPrimaryMirror(mirror: string): boolean {
        return (
            Hub.trimTrailingSlash(mirror) ===
            Hub.trimTrailingSlash(String(this.configuration.url || ''))
        );
    }

    /**
     * Token endpoint to use for a given mirror.
     *
     * `configuration.authurl` only applies to the primary mirror; secondary
     * mirrors must auto-discover their own realm (the previous implementation
     * achieved the same by resetting `authurl` to undefined on every attempt).
     */
    private authUrlForMirror(mirror: string): string | undefined {
        if (this.isDefaultHub(mirror)) {
            return DEFAULT_HUB_AUTH_URL;
        }
        if (this.isPrimaryMirror(mirror)) {
            return this.configuration.authurl;
        }
        return undefined;
    }

    /**
     * `service` parameter to send to a mirror's token endpoint.
     */
    private serviceForMirror(mirror: string): string {
        if (this.isDefaultHub(mirror)) {
            return DEFAULT_HUB_SERVICE;
        }
        if (this.isPrimaryMirror(mirror) && this.configuration.service) {
            return this.configuration.service;
        }
        return this.getHostOf(mirror);
    }

    private getHostOf(url: string): string {
        try {
            return new URL(url).host;
        } catch {
            return String(url || '')
                .replace(/^https?:\/\//, '')
                .split('/')[0];
        }
    }

    /**
     * Host of the configured registry (used for canonical image names and as
     * the default token `service` parameter when a mirror is configured).
     *
     * `configuration.url` is immutable once `init()` has run, so this is
     * stable even under concurrent requests.
     */
    getRegistryHost(): string {
        try {
            return new URL(this.configuration.url).host;
        } catch {
            return String(this.configuration.url || '')
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, '');
        }
    }

    /**
     * Get the Hub configuration schema.
     */
    getConfigurationSchema() {
        return this.joi.alternatives([
            this.joi.string().allow(''),
            this.joi.object().keys({
                url: this.joi.string().uri(),
                authurl: this.joi.string().uri(),
                service: this.joi.string(),
                login: this.joi.string(),
                password: this.joi.string(),
                token: this.joi.string(),
                auth: this.joi.string().base64(),
                watchdigest: this.joi.bool().optional(),
                suppressdigestwatchwarning: this.joi.bool().default(false),
            }),
        ]);
    }

    shouldWatchDigest(
        wudWatchDigestLabelValue: string,
        image: string,
        watchDigestDefault?: boolean,
    ) {
        let shouldWatch: boolean;
        if (wudWatchDigestLabelValue !== undefined) {
            shouldWatch = wudWatchDigestLabelValue.toLowerCase() === 'true';
        } else if (this.configuration.watchdigest !== undefined) {
            shouldWatch = this.configuration.watchdigest === true;
        } else {
            shouldWatch =
                watchDigestDefault !== undefined ? watchDigestDefault : false;
        }
        if (shouldWatch && !this.configuration.suppressdigestwatchwarning) {
            this.log.warn(
                `Watching digest for image ${image} may result in throttled requests`,
            );
        }

        return shouldWatch;
    }

    /**
     * Return true if image has no registry url.
     */
    match(imageUrl: string) {
        return !imageUrl || /^.*\.?docker.io$/.test(imageUrl);
    }

    /**
     * Normalize images according to Hub characteristics.
     */
    normalizeImage(image: ContainerImage) {
        const imageNormalized = super.normalizeImage(image);
        if (imageNormalized.name) {
            imageNormalized.name = imageNormalized.name.includes('/')
                ? imageNormalized.name
                : `library/${imageNormalized.name}`;
        }
        return imageNormalized;
    }

    /**
     * Authenticate to Hub (or to the configured mirror).
     *
     * When no token endpoint is configured for the mirror in effect, the
     * mirror's own `WWW-Authenticate: Bearer realm` challenge is used to fetch
     * a pull token; if no realm is advertised the mirror is treated as
     * anonymous (no `Authorization` header, and in particular no Basic
     * credentials leaked to a third-party mirror).
     */
    async authenticate(
        image: ContainerImage,
        requestOptions: AxiosRequestConfig,
    ) {
        const mirror = this.currentMirror();
        const authUrl = this.authUrlForMirror(mirror);

        if (!authUrl) {
            const token = await this.getMirrorToken(mirror, image);
            return token
                ? this.authenticateBearer(requestOptions, token)
                : requestOptions;
        }

        const credentials = this.getAuthCredentials();
        const axiosConfig: AxiosRequestConfig = {
            method: 'GET',
            url: `${authUrl}?service=${this.serviceForMirror(
                mirror,
            )}&scope=repository:${image.name}:pull&grant_type=password`,
            headers: {
                Accept: 'application/json',
                'User-Agent': getUserAgent(),
            },
        };

        // Add Authorization if any
        if (credentials) {
            axiosConfig.headers.Authorization = `Basic ${credentials}`;
        }

        if (this.configuration?.proxy) {
            applyProxyConfig(axiosConfig, this.configuration.proxy);
        }

        const response = await axios(axiosConfig);
        return this.authenticateBearer(requestOptions, response.data.token);
    }

    /**
     * Pull token for a mirror, or undefined when the mirror is anonymous.
     *
     * Delegates the token exchange (and its cache) to the base class, which
     * keys entries by `(registryUrl, image.name, credentials)` and honours
     * `expires_in`. The previous fork-local cache was keyed by mirror URL only,
     * even though tokens are scoped to `repository:<image>:pull` - so a token
     * obtained for one image was reused for another and answered 401 - and it
     * never expired.
     *
     * Credentials are deliberately **not** forwarded: the realm is advertised
     * by the mirror itself, and a third-party mirror must not be handed the
     * Docker Hub credentials just because it answered the probe. Operators who
     * do want an authenticated mirror configure `authurl` explicitly, in which
     * case `authenticate()` takes the trusted, user-supplied endpoint instead.
     */
    private async getMirrorToken(
        mirror: string,
        image: ContainerImage,
    ): Promise<string | undefined> {
        const challenge = await this.getMirrorChallenge(mirror);
        if (!challenge?.realm) {
            return undefined;
        }
        return this.getBearerToken(image, mirror, undefined, challenge);
    }

    /**
     * `WWW-Authenticate` challenge advertised by a mirror, cached for
     * `MIRROR_CHALLENGE_TTL_MS`.
     */
    private async getMirrorChallenge(
        mirror: string,
    ): Promise<BearerChallenge | undefined> {
        const cached = this.mirrorChallengeCache.get(mirror);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.challenge;
        }
        const challenge = await this.getBearerChallenge(mirror);
        this.mirrorChallengeCache.set(mirror, {
            challenge,
            expiresAt: Date.now() + MIRROR_CHALLENGE_TTL_MS,
        });
        return challenge;
    }

    getImageFullName(image: ContainerImage, tagOrDigest: string) {
        let fullName = super.getImageFullName(image, tagOrDigest);
        fullName = fullName.replace(`${this.getRegistryHost()}/`, '');
        fullName = fullName.replace(/library\//, '');
        return fullName;
    }
}

export default Hub;
