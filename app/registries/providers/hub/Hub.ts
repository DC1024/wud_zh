import axios, { AxiosRequestConfig, AxiosResponse, Method } from 'axios';
import Custom from '../custom/Custom';
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

/** How long to wait when probing a mirror's `/v2/` for its Bearer realm. */
const MIRROR_PROBE_TIMEOUT_MS = 8000;

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
 * in order; when one fails (network error, 401, 404, 429) the next is tried.
 * The list can also be edited from the web UI (persisted in the store); when a
 * UI list exists it takes priority over the env var.
 *
 * Authentication is per-mirror and auto-discovered: each mirror that
 * advertises a `WWW-Authenticate: Bearer realm=...` challenge on its `/v2/` is
 * used to fetch a pull token on its own token endpoint; a mirror that does not
 * advertise a realm is treated as anonymous (no `Authorization` header).
 */
class Hub extends Custom {
    /** Cache of per-mirror pull tokens: baseUrl -> token | null (null = anonymous). */
    private tokenCache = new Map<string, string | null>();
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
     * Base `/v2` URL of the first mirror, used to rewrite request URLs when
     * switching between mirrors (the image is normalized against the first one).
     */
    private getFirstV2Base(): string {
        return `${this.getMirrors()[0]}/v2`;
    }

    /**
     * Override of the registry HTTP entry point to add mirror failover.
     *
     * Each mirror is tried in order; the first success is returned. On failure
     * (network error, 401, 404, 429) the error is recorded and the next mirror
     * is tried. If every mirror fails the last error is re-thrown.
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
        const firstV2Base = this.getFirstV2Base();
        let lastError: any;

        for (const mirror of mirrors) {
            const prevUrl = this.configuration.url;
            const prevAuthurl = this.configuration.authurl;
            const prevService = this.configuration.service;
            try {
                // Point the provider at this mirror for this attempt.
                this.configuration.url = mirror;
                this.configuration.authurl = this.isDefaultHub(mirror)
                    ? DEFAULT_HUB_AUTH_URL
                    : undefined;
                if (this.isDefaultHub(mirror)) {
                    this.configuration.service = DEFAULT_HUB_SERVICE;
                } else {
                    this.configuration.service = this.getHostOf(mirror);
                }
                const rewrittenUrl = url.replace(firstV2Base, `${mirror}/v2`);
                // The base class overloads require literal true/false; we carry the
                // caller's boolean through via a cast to preserve the return shape.
                const result = await super.callRegistry({
                    image,
                    url: rewrittenUrl,
                    method,
                    headers,
                    resolveWithFullResponse,
                } as any);
                return result;
            } catch (e: any) {
                lastError = e;
                this.log.warn(
                    `Mirror ${mirror} failed for ${image && image.name} (${e && e.message}); trying next mirror`,
                );
            } finally {
                this.configuration.url = prevUrl;
                this.configuration.authurl = prevAuthurl;
                this.configuration.service = prevService;
            }
        }
        throw lastError;
    }

    private isDefaultHub(url: string): boolean {
        return (
            Hub.trimTrailingSlash(url) ===
            Hub.trimTrailingSlash(DEFAULT_HUB_URL)
        );
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
     * When no token endpoint is configured (custom mirror), the mirror's own
     * `WWW-Authenticate: Bearer realm` challenge is auto-discovered on its
     * `/v2/` and used to fetch a pull token; if no realm is advertised the
     * mirror is treated as anonymous.
     */
    async authenticate(
        image: ContainerImage,
        requestOptions: AxiosRequestConfig,
    ) {
        const credentials = this.getAuthCredentials();

        // Custom mirror without an explicit token endpoint: auto-discover.
        if (!this.configuration.authurl && this.configuration.url) {
            if (!this.isDefaultHub(this.configuration.url)) {
                const token = await this.discoverMirrorToken(
                    this.configuration.url,
                    image,
                );
                if (token) {
                    requestOptions.headers.Authorization = `Bearer ${token}`;
                }
                return requestOptions;
            }
        }

        // No token endpoint configured and not a mirror to auto-discover:
        // anonymous (or basic-auth if credentials were explicitly configured).
        if (!this.configuration.authurl) {
            return credentials
                ? this.authenticateBasic(requestOptions, credentials)
                : requestOptions;
        }

        const axiosConfig: AxiosRequestConfig = {
            method: 'GET',
            url: `${this.configuration.authurl}?service=${this.configuration.service}&scope=repository:${image.name}:pull&grant_type=password`,
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
        const requestOptionsWithAuth = requestOptions;
        requestOptionsWithAuth.headers.Authorization = `Bearer ${response.data.token}`;
        return requestOptionsWithAuth;
    }

    /**
     * Discover a pull token for a mirror by probing its `/v2/` for a Bearer
     * realm, then exchanging it for a token. Result is cached per base URL.
     * @returns the pull token, or null when the mirror is anonymous/unreachable.
     */
    private async discoverMirrorToken(
        baseUrl: string,
        image: ContainerImage,
    ): Promise<string | null> {
        if (this.tokenCache.has(baseUrl)) {
            return this.tokenCache.get(baseUrl) ?? null;
        }
        try {
            const probe = await axios({
                method: 'GET',
                url: `${baseUrl}/v2/`,
                validateStatus: () => true,
                timeout: MIRROR_PROBE_TIMEOUT_MS,
            });
            const www = String(
                (probe.headers && probe.headers['www-authenticate']) || '',
            );
            const realmMatch = /realm="([^"]+)"/.exec(www);
            if (!realmMatch) {
                this.tokenCache.set(baseUrl, null);
                return null;
            }
            const realm = realmMatch[1];
            const serviceMatch = /service="([^"]+)"/.exec(www);
            const service = serviceMatch ? serviceMatch[1] : '';
            let tokenUrl =
                realm +
                (realm.includes('?') ? '&' : '?') +
                `scope=${encodeURIComponent(`repository:${image.name}:pull`)}`;
            if (service) {
                tokenUrl += `&service=${encodeURIComponent(service)}`;
            }
            const tokenResponse = await axios({
                method: 'GET',
                url: tokenUrl,
                headers: { Accept: 'application/json' },
                validateStatus: () => true,
                timeout: MIRROR_PROBE_TIMEOUT_MS,
            });
            const token =
                (tokenResponse.data && tokenResponse.data.token) ||
                (tokenResponse.data && tokenResponse.data.access_token);
            if (token) {
                this.tokenCache.set(baseUrl, token);
                return token;
            }
            this.tokenCache.set(baseUrl, null);
            return null;
        } catch (e: any) {
            this.log.debug(
                `Unable to auto-discover Bearer token for mirror ${baseUrl} (${e && e.message}); treating as anonymous`,
            );
            this.tokenCache.set(baseUrl, null);
            return null;
        }
    }

    getImageFullName(image: ContainerImage, tagOrDigest: string) {
        let fullName = super.getImageFullName(image, tagOrDigest);
        fullName = fullName.replace(`${this.getRegistryHost()}/`, '');
        fullName = fullName.replace(/library\//, '');
        return fullName;
    }
}

export default Hub;
