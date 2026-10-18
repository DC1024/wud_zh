// @ts-nocheck
import Alibaba from './Alibaba';
import { testRegistryProvider } from '../RegistryTestHelper';

// The Bearer handshake lives in DockerRegistryV2 and issues plain axios calls.
jest.mock('axios', () => jest.fn());

const validConfig = {
    username: 'aliyun-user',
    password: 'aliyun-password',
};

const alibaba = new Alibaba();
alibaba.configuration = validConfig;

test('validateConfiguration should accept empty string', () => {
    expect(() => {
        alibaba.validateConfiguration('' as any);
    }).not.toThrow();
});

test('validateConfiguration should accept username and password config', () => {
    expect(() => {
        alibaba.validateConfiguration(validConfig);
    }).not.toThrow();
});

testRegistryProvider(Alibaba, validConfig, {
    matchingUrls: [
        'registry.cn-hangzhou.aliyuncs.com',
        'registry.ap-southeast-1.aliyuncs.com',
        'my-ns.aliyuncs.com',
    ],
    // `evilaliyuncs.com` must not be swallowed by the `.*` prefix.
    nonMatchingUrls: ['docker.io', 'ghcr.io', 'aliyun.com', 'evilaliyuncs.com'],
    sampleImage: {
        input: {
            name: 'my-ns/my-app',
            registry: {
                url: 'registry.cn-hangzhou.aliyuncs.com/my-ns/my-app',
            },
        },
        expected: {
            name: 'my-ns/my-app',
            registry: {
                url: 'https://registry.cn-hangzhou.aliyuncs.com/my-ns/my-app/v2',
            },
        },
    },
    maskConfig: {
        input: {
            username: 'aliyun-user',
            password: 'secret-password-1234',
            other: 'clear',
        },
        expected: {
            username: 'aliyun-user',
            password: 's******************4',
            other: 'clear',
        },
    },
    authPullConfig: {
        input: validConfig,
        expected: {
            username: 'aliyun-user',
            password: 'aliyun-password',
        },
    },
});

describe('Alibaba Bearer authentication', () => {
    const image = {
        name: 'my-ns/my-app',
        registry: { url: 'https://registry.cn-hangzhou.aliyuncs.com/v2' },
    };
    const challengeHeader =
        'Bearer realm="https://dockerauth.cn-hangzhou.aliyuncs.com/auth",service="registry.aliyuncs.com:cn-hangzhou:26842"';

    let provider;

    beforeEach(async () => {
        const { default: axios } = await import('axios');
        axios.mockReset();
        provider = new Alibaba();
        await provider.register('registry', 'alibaba', 'test', {});
    });

    test('should exchange the ACR challenge for a Bearer token', async () => {
        const { default: axios } = await import('axios');
        axios.mockRejectedValueOnce({
            response: {
                status: 401,
                headers: { 'www-authenticate': challengeHeader },
            },
        });
        axios.mockResolvedValueOnce({ data: { access_token: 'acr-token' } });
        provider.getAuthCredentials = jest.fn().mockReturnValue(null);

        const result = await provider.authenticate(image, { headers: {} });

        // The image URL carries a `/v2` suffix; the probe must hit `/v2/` once.
        expect(axios).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                method: 'GET',
                url: 'https://registry.cn-hangzhou.aliyuncs.com/v2/',
                timeout: expect.any(Number),
            }),
        );
        expect(axios).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                method: 'GET',
                url: 'https://dockerauth.cn-hangzhou.aliyuncs.com/auth?service=registry.aliyuncs.com%3Acn-hangzhou%3A26842&scope=repository%3Amy-ns%2Fmy-app%3Apull',
            }),
        );
        expect(result.headers.Authorization).toBe('Bearer acr-token');
    });

    test('should send Basic credentials to the token endpoint for private repositories', async () => {
        const { default: axios } = await import('axios');
        axios.mockRejectedValueOnce({
            response: {
                status: 401,
                headers: { 'www-authenticate': challengeHeader },
            },
        });
        axios.mockResolvedValueOnce({ data: { token: 'private-token' } });
        provider.getAuthCredentials = jest
            .fn()
            .mockReturnValue('YmFzZTY0LWNyZWRz');

        const result = await provider.authenticate(image, { headers: {} });

        expect(axios).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Basic YmFzZTY0LWNyZWRz',
                }),
            }),
        );
        expect(result.headers.Authorization).toBe('Bearer private-token');
    });

    test('should stay anonymous when the registry advertises no challenge', async () => {
        const { default: axios } = await import('axios');
        axios.mockResolvedValueOnce({ status: 200 });
        provider.getAuthCredentials = jest.fn().mockReturnValue(null);

        const requestOptions = { headers: {} };
        const result = await provider.authenticate(image, requestOptions);

        expect(axios).toHaveBeenCalledTimes(1);
        expect(result.headers.Authorization).toBeUndefined();
    });

    test('should fall back to Basic auth when the challenge cannot be read', async () => {
        const { default: axios } = await import('axios');
        axios.mockRejectedValueOnce({ response: { status: 500 } });
        provider.getAuthCredentials = jest
            .fn()
            .mockReturnValue('YmFzZTY0LWNyZWRz');

        const result = await provider.authenticate(image, { headers: {} });

        expect(result.headers.Authorization).toBe('Basic YmFzZTY0LWNyZWRz');
    });
});
