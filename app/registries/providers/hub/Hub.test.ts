// @ts-nocheck
import Hub from './Hub';
import { testRegistryProvider } from '../RegistryTestHelper';

// Mock axios
jest.mock('axios', () => jest.fn());

describe('Docker Hub Registry tests', () => {
    let hub;

    beforeEach(async () => {
        hub = new Hub();
        await hub.register('registry', 'hub', 'test', {});
        jest.clearAllMocks();
    });

    // testRegistryProvider boilerplate handles create instance
    test('should have correct registry url after init', async () => {
        expect(hub.configuration.url).toBe('https://registry-1.docker.io');
    });

    test('should match registry', async () => {
        expect(hub.match('registry-1.docker.io')).toBe(true);
        expect(hub.match('docker.io')).toBe(true);
        expect(hub.match(undefined)).toBe(true);
        expect(hub.match('other.registry.com')).toBe(false);
    });

    test('should normalize image name for official images', async () => {
        const image = { name: 'nginx', registry: {} };
        const normalized = hub.normalizeImage(image);
        expect(normalized.name).toBe('library/nginx');
        expect(normalized.registry.url).toBe('https://registry-1.docker.io/v2');
    });

    test('should not normalize image name for user images', async () => {
        const image = { name: 'user/nginx', registry: {} };
        const normalized = hub.normalizeImage(image);
        expect(normalized.name).toBe('user/nginx');
        expect(normalized.registry.url).toBe('https://registry-1.docker.io/v2');
    });

    test('should mask configuration with token', async () => {
        hub.configuration = { login: 'testuser', token: 'secret_token' };
        const masked = hub.maskConfiguration();
        expect(masked.login).toBe('testuser');
        expect(masked.token).toBe('s**********n');
    });

    test('should get image full name without registry prefix', async () => {
        const image = {
            name: 'library/nginx',
            registry: { url: 'https://registry-1.docker.io/v2' },
        };
        const fullName = hub.getImageFullName(image, '1.0.0');
        expect(fullName).toBe('nginx:1.0.0');
    });

    test('should get image full name for user images', async () => {
        const image = {
            name: 'user/nginx',
            registry: { url: 'https://registry-1.docker.io/v2' },
        };
        const fullName = hub.getImageFullName(image, '1.0.0');
        expect(fullName).toBe('user/nginx:1.0.0');
    });

    test('should initialize with token as password', async () => {
        const hubWithToken = new Hub();
        await hubWithToken.register('registry', 'hub', 'test', {
            token: 'mytoken',
        });
        expect(hubWithToken.configuration.password).toBe('mytoken');
    });

    test('should authenticate with credentials', async () => {
        const { default: axios } = await import('axios');
        axios.mockResolvedValue({ data: { token: 'auth-token' } });

        hub.getAuthCredentials = jest.fn().mockReturnValue('base64credentials');

        const image = { name: 'library/nginx' };
        const requestOptions = { headers: {} };

        const result = await hub.authenticate(image, requestOptions);

        expect(axios).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull&grant_type=password',
            headers: {
                Accept: 'application/json',
                'User-Agent': expect.stringMatching(/^wud\/.+/),
                Authorization: 'Basic base64credentials',
            },
        });
        expect(result.headers.Authorization).toBe('Bearer auth-token');
    });

    test('should authenticate without credentials', async () => {
        const { default: axios } = await import('axios');
        axios.mockResolvedValue({ data: { token: 'public-token' } });

        hub.getAuthCredentials = jest.fn().mockReturnValue(null);

        const image = { name: 'library/nginx' };
        const requestOptions = { headers: {} };

        const result = await hub.authenticate(image, requestOptions);

        expect(axios).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull&grant_type=password',
            headers: {
                Accept: 'application/json',
                'User-Agent': expect.stringMatching(/^wud\/.+/),
            },
        });
        expect(result.headers.Authorization).toBe('Bearer public-token');
    });

    test('should authenticate with proxy configured', async () => {
        const { default: axios } = await import('axios');
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        axios.mockResolvedValue({ data: { token: 'proxy-token' } });

        hub.configuration.proxy = 'http://hub-proxy:3128';
        hub.getAuthCredentials = jest.fn().mockReturnValue(null);

        const image = { name: 'library/nginx' };
        const requestOptions = { headers: {} };

        const result = await hub.authenticate(image, requestOptions);

        expect(axios).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'GET',
                url: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull&grant_type=password',
                httpsAgent: expect.any(HttpsProxyAgent),
                proxy: false,
            }),
        );
        expect(result.headers.Authorization).toBe('Bearer proxy-token');
    });

    // testRegistryProvider boilerplate handles validate string configuration
    test('should validate object configuration with auth', async () => {
        const config = {
            login: 'user',
            password: 'pass',
            auth: Buffer.from('user:pass').toString('base64'),
        };
        expect(() => hub.validateConfiguration(config)).not.toThrow();
    });

    test('should mask all configuration fields', async () => {
        hub.configuration = {
            url: 'https://registry-1.docker.io',
            login: 'testuser',
            password: 'testpass',
            token: 'testtoken',
            auth: 'dGVzdDp0ZXN0',
        };
        const masked = hub.maskConfiguration();
        expect(masked).toEqual({
            url: 'https://registry-1.docker.io',
            login: 'testuser',
            password: 't******s',
            token: 't*******n',
            auth: 'd**********0',
        });
    });

    describe('shouldWatchDigest', () => {
        test('should return false without label or config', () => {
            const result = hub.shouldWatchDigest(undefined, 'library/nginx');
            expect(result).toBe(false);
        });

        test('should return true when label is true (semver flag handled upstream)', () => {
            const result = hub.shouldWatchDigest('true', 'library/nginx');
            expect(result).toBe(true);
        });

        test('should return false for non-semver without label (throttling protection)', () => {
            const result = hub.shouldWatchDigest(undefined, 'library/nginx');
            expect(result).toBe(false);
        });

        test('should return true when label is true (non-semver)', () => {
            const result = hub.shouldWatchDigest('true', 'library/nginx');
            expect(result).toBe(true);
        });

        test('should return true when watchdigest config is true', async () => {
            const hubWithWatchDigest = new Hub();
            await hubWithWatchDigest.register('registry', 'hub', 'test', {
                watchdigest: true,
            });
            const result = hubWithWatchDigest.shouldWatchDigest(
                undefined,
                'library/nginx',
            );
            expect(result).toBe(true);
        });

        test('should return false when label is false despite watchdigest config', async () => {
            const hubWithWatchDigest = new Hub();
            await hubWithWatchDigest.register('registry', 'hub', 'test', {
                watchdigest: true,
            });
            const result = hubWithWatchDigest.shouldWatchDigest(
                'false',
                'library/nginx',
            );
            expect(result).toBe(false);
        });

        test('should return watchDigestDefault if no label and no watchdigest config', () => {
            expect(
                hub.shouldWatchDigest(undefined, 'library/nginx', false),
            ).toBe(false);
            expect(
                hub.shouldWatchDigest(undefined, 'library/nginx', true),
            ).toBe(true);
        });

        test('should prefer watchdigest config over watchDigestDefault', async () => {
            const hubWithWatchDigest = new Hub();
            await hubWithWatchDigest.register('registry', 'hub', 'test', {
                watchdigest: false,
            });
            expect(
                hubWithWatchDigest.shouldWatchDigest(
                    undefined,
                    'library/nginx',
                    true,
                ),
            ).toBe(false);
        });

        test('should log warning when watching digest without suppressdigestwatchwarning', async () => {
            const hubWithWatchDigest = new Hub();
            await hubWithWatchDigest.register('registry', 'hub', 'test', {
                watchdigest: true,
            });
            const mockWarn = jest.fn();
            hubWithWatchDigest.log = { warn: mockWarn };

            hubWithWatchDigest.shouldWatchDigest(undefined, 'library/nginx');

            expect(mockWarn).toHaveBeenCalledWith(
                expect.stringContaining('throttled requests'),
            );
        });

        test('should not log warning when suppressdigestwatchwarning is true', async () => {
            const hubWithWatchDigest = new Hub();
            await hubWithWatchDigest.register('registry', 'hub', 'test', {
                watchdigest: true,
                suppressdigestwatchwarning: true,
            });
            const mockWarn = jest.fn();
            hubWithWatchDigest.log = { warn: mockWarn };

            hubWithWatchDigest.shouldWatchDigest(undefined, 'library/nginx');

            expect(mockWarn).not.toHaveBeenCalled();
        });
    });

    describe('mirror configuration', () => {
        test('should auto-discover a custom mirror without authurl (probe /v2/, no Bearer realm => anonymous)', async () => {
            const { default: axios } = await import('axios');
            axios.mockClear();
            // Anonymous mirror: /v2/ returns no WWW-Authenticate header.
            axios.mockResolvedValue({ headers: {} });

            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://docker.1panel.live',
            });

            // Default Hub token endpoint must NOT be used for a custom mirror.
            expect(mirror.configuration.url).toBe('https://docker.1panel.live');
            expect(mirror.configuration.authurl).toBeUndefined();
            // `service` defaults to the mirror host when not explicitly set.
            expect(mirror.configuration.service).toBe('docker.1panel.live');

            mirror.getAuthCredentials = jest.fn().mockReturnValue(null);
            const image = { name: 'library/nginx' };
            const requestOptions = { headers: {} };

            const result = await mirror.authenticate(image, requestOptions);

            // The mirror was probed for its Bearer realm.
            expect(axios).toHaveBeenCalledWith({
                method: 'GET',
                url: 'https://docker.1panel.live/v2/',
                validateStatus: expect.any(Function),
                timeout: expect.any(Number),
            });
            // No Bearer realm advertised => treated as anonymous.
            expect(result.headers.Authorization).toBeUndefined();
        });

        test('should auto-discover a Bearer token from a mirror advertising a realm', async () => {
            const { default: axios } = await import('axios');
            axios.mockClear();
            // First call = /v2/ probe advertising the realm.
            // Second call = token exchange returning the pull token.
            axios
                .mockResolvedValueOnce({
                    headers: {
                        'www-authenticate':
                            'Bearer realm="https://m.daocloud.io/auth/token",service="docker.m.daocloud.io"',
                    },
                })
                .mockResolvedValueOnce({ data: { token: 'daocloud-token' } });

            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://docker.m.daocloud.io',
            });
            expect(mirror.configuration.authurl).toBeUndefined();

            mirror.getAuthCredentials = jest.fn().mockReturnValue(null);
            const image = { name: 'library/nginx' };
            const requestOptions = { headers: {} };

            const result = await mirror.authenticate(image, requestOptions);

            expect(axios).toHaveBeenNthCalledWith(1, {
                method: 'GET',
                url: 'https://docker.m.daocloud.io/v2/',
                validateStatus: expect.any(Function),
                timeout: expect.any(Number),
            });
            expect(axios).toHaveBeenNthCalledWith(2, {
                method: 'GET',
                url: 'https://m.daocloud.io/auth/token?scope=repository%3Alibrary%2Fnginx%3Apull&service=docker.m.daocloud.io',
                headers: { Accept: 'application/json' },
                validateStatus: expect.any(Function),
                timeout: expect.any(Number),
            });
            expect(result.headers.Authorization).toBe('Bearer daocloud-token');
        });

        test('should fetch a token from the configured authurl/service for an authenticated mirror', async () => {
            const { default: axios } = await import('axios');
            axios.mockClear();
            axios.mockResolvedValue({ data: { token: 'mirror-token' } });

            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://docker.1panel.live',
                authurl: 'https://docker.1panel.live/token',
                service: 'docker.1panel.live',
            });
            expect(mirror.configuration.authurl).toBe(
                'https://docker.1panel.live/token',
            );

            mirror.getAuthCredentials = jest.fn().mockReturnValue(null);
            const image = { name: 'library/nginx' };
            const requestOptions = { headers: {} };

            const result = await mirror.authenticate(image, requestOptions);

            expect(axios).toHaveBeenCalledWith({
                method: 'GET',
                url: 'https://docker.1panel.live/token?service=docker.1panel.live&scope=repository:library/nginx:pull&grant_type=password',
                headers: {
                    Accept: 'application/json',
                    'User-Agent': expect.stringMatching(/^wud\/.+/),
                },
            });
            expect(result.headers.Authorization).toBe('Bearer mirror-token');
        });

        test('should strip the mirror host from the image full name', async () => {
            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://docker.1panel.live',
            });
            const image = {
                name: 'library/nginx',
                registry: { url: 'https://docker.1panel.live/v2' },
            };
            expect(mirror.getImageFullName(image, '1.21.0')).toBe(
                'nginx:1.21.0',
            );
        });

        test('should fail over to the next mirror when the first one fails', async () => {
            const { default: axios } = await import('axios');
            axios.mockClear();
            // Mirror 1: anonymous /v2/ probe succeeds (no realm) but the
            // manifest call fails with 401. Mirror 2: succeeds.
            axios
                .mockResolvedValueOnce({ headers: {} }) // probe mirror1 /v2/
                .mockRejectedValueOnce({ response: { status: 401 } }) // mirror1 manifest
                .mockResolvedValueOnce({ headers: {} }) // probe mirror2 /v2/
                .mockResolvedValueOnce({
                    data: { name: 'nginx', tags: ['latest'] },
                }); // mirror2 manifest

            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://bad.example.com,https://good.example.com',
            });
            // First mirror is the registry base.
            expect(mirror.configuration.url).toBe('https://bad.example.com');
            const image = {
                name: 'library/nginx',
                registry: { url: 'https://bad.example.com/v2' },
            };

            const tags = await mirror.getTags(image);

            expect(tags).toEqual(['latest']);
            // 4 axios calls total: probe1 + fail1 + probe2 + ok2.
            expect(axios).toHaveBeenCalledTimes(4);
            // The second manifest call targeted the good mirror.
            expect(axios).toHaveBeenNthCalledWith(
                4,
                expect.objectContaining({
                    url: 'https://good.example.com/v2/library/nginx/tags/list?n=1000',
                }),
            );
        });

        test('should re-throw when every mirror fails', async () => {
            const { default: axios } = await import('axios');
            axios.mockClear();
            axios.mockResolvedValue({ headers: {} }); // every probe anonymous
            axios.mockRejectedValue({ response: { status: 404 } }); // every manifest 404

            const mirror = new Hub();
            await mirror.register('registry', 'hub', 'test', {
                url: 'https://a.example.com,https://b.example.com',
            });
            const image = {
                name: 'library/nginx',
                registry: { url: 'https://a.example.com/v2' },
            };

            await expect(mirror.getTags(image)).rejects.toBeDefined();
        });
    });
});

testRegistryProvider(Hub, { login: 'testuser', token: 'testtoken' });
