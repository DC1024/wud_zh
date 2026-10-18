import express from 'express';
import request from 'supertest';
import axios from 'axios';
import * as registryApi from './registry';
import * as registry from '../registry';
import Registry from '../registries/Registry';
import * as hubMirrorStore from '../store/hubMirror';
import * as dns from 'dns';

jest.mock('../registry', () => ({
    getState: jest.fn(() => ({
        registry: {
            'mock.test': {
                type: 'mock',
                name: 'test',
                maskConfiguration: () => ({ mockConfig: true }),
            },
        },
    })),
}));

jest.mock('../store/hubMirror', () => ({
    getMirrors: jest.fn(),
    setMirrors: jest.fn(),
}));

jest.mock('axios', () => {
    const fn = jest.fn();
    fn.mockResolvedValue({
        status: 200,
        headers: { 'www-authenticate': 'Bearer realm="https://x/v2/token"' },
    });
    return fn;
});

jest.mock('dns', () => {
    const lookup = jest.fn((_host: string, _opts: any) =>
        Promise.resolve({ address: '93.184.216.34', family: 4 }),
    );
    return { lookup };
});

describe('API Registry', () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.get('/', registryApi.getRegistries);
        app.get('/:type/:name', registryApi.getRegistry);
    });

    test('should get all registries', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            {
                id: 'mock.test',
                type: 'mock',
                name: 'test',
                configuration: { mockConfig: true },
            },
        ]);
    });

    test('should get registry by type and name', async () => {
        const res = await request(app).get('/mock/test');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            id: 'mock.test',
            type: 'mock',
            name: 'test',
            configuration: { mockConfig: true },
        });
    });

    test('registry API masks nested webhook credentials', async () => {
        const provider = new Registry();
        provider.type = 'mock';
        provider.name = 'test';
        provider.configuration = { webhook: { token: 'private-secret' } };
        jest.mocked(registry.getState).mockReturnValueOnce({
            registry: { 'mock.test': provider },
        } as unknown as registry.RegistryState);
        const response = await request(app).get('/');
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain('private-secret');
        expect(provider.configuration.webhook.token).toBe('private-secret');
    });
    test('should return 404 for unknown registry', async () => {
        const res = await request(app).get('/mock/unknown');
        expect(res.status).toBe(404);
    });

    describe('hub mirror endpoints', () => {
        let mirrorApp: express.Express;

        beforeEach(() => {
            jest.clearAllMocks();
            (axios as any).mockReset();
            (axios as any).mockResolvedValue({
                status: 200,
                headers: {
                    'www-authenticate': 'Bearer realm="https://x/v2/token"',
                },
            });
            mirrorApp = express();
            mirrorApp.use(express.json());
            // Auth stub: pretend a logged-in admin (requireRole reads req.user.role).
            mirrorApp.use((req, res, next) => {
                (req as any).user = { role: 'admin' };
                next();
            });
            mirrorApp.use(registryApi.init());
        });

        test('GET /hub/mirrors returns ui, effective and probed health', async () => {
            (hubMirrorStore.getMirrors as any).mockReturnValue([
                'https://mirror-a.example.com',
            ]);
            const res = await request(mirrorApp).get('/hub/mirrors');
            expect(res.status).toBe(200);
            expect(res.body.ui).toEqual(['https://mirror-a.example.com']);
            expect(res.body.effective).toEqual([
                'https://mirror-a.example.com',
            ]);
            expect(res.body.health).toHaveLength(1);
            expect(res.body.health[0].url).toBe('https://mirror-a.example.com');
            expect(res.body.health[0].ok).toBe(true);
            expect(res.body.health[0].kind).toBe('bearer');
        });

        test('PUT /hub/mirrors stores the sanitized list', async () => {
            (hubMirrorStore.getMirrors as any).mockReturnValue([
                'https://mirror-b.example.com',
            ]);
            (hubMirrorStore.setMirrors as any).mockImplementation((m) => m);
            const res = await request(mirrorApp)
                .put('/hub/mirrors')
                .send({ mirrors: [' https://mirror-b.example.com ', ''] });
            expect(res.status).toBe(200);
            expect(hubMirrorStore.setMirrors).toHaveBeenCalledWith([
                'https://mirror-b.example.com',
            ]);
            expect(res.body.ui).toEqual(['https://mirror-b.example.com']);
            expect(res.body.effective).toEqual([
                'https://mirror-b.example.com',
            ]);
        });

        test('PUT /hub/mirrors rejects non-array body', async () => {
            const res = await request(mirrorApp)
                .put('/hub/mirrors')
                .send({ mirrors: 'x' });
            expect(res.status).toBe(400);
        });

        test('POST /hub/mirrors/test probes a single mirror', async () => {
            const res = await request(mirrorApp)
                .post('/hub/mirrors/test')
                .send({ url: 'https://mirror-c.example.com' });
            expect(res.status).toBe(200);
            expect(res.body.url).toBe('https://mirror-c.example.com');
            expect(res.body.kind).toBe('bearer');
            expect(res.body.ok).toBe(true);
        });

        test('POST /hub/mirrors/test requires a url', async () => {
            const res = await request(mirrorApp)
                .post('/hub/mirrors/test')
                .send({});
            expect(res.status).toBe(400);
        });

        test('GET /hub/mirrors reports unreachable mirror as unhealthy', async () => {
            (hubMirrorStore.getMirrors as any).mockReturnValue([
                'https://mirror-dead.example.com',
            ]);
            (axios as any).mockRejectedValue(new Error('ECONNREFUSED'));
            const res = await request(mirrorApp).get('/hub/mirrors');
            expect(res.status).toBe(200);
            expect(res.body.health[0].ok).toBe(false);
            expect(res.body.health[0].kind).toBe('unreachable');
        });

        test('POST /hub/mirrors/test rejects non-http(s) schemes', async () => {
            const res = await request(mirrorApp)
                .post('/hub/mirrors/test')
                .send({ url: 'file:///etc/passwd' });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(false);
            expect(res.body.kind).toBe('invalid');
            expect(res.body.error).toMatch(/scheme/i);
            expect(axios).not.toHaveBeenCalled();
        });

        test('POST /hub/mirrors/test blocks private/internal targets by default', async () => {
            (dns.lookup as any).mockResolvedValueOnce({
                address: '127.0.0.1',
                family: 4,
            });
            const res = await request(mirrorApp)
                .post('/hub/mirrors/test')
                .send({ url: 'http://localhost:5000' });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(false);
            expect(res.body.kind).toBe('private');
            expect(res.body.status).toBe('BLOCKED');
            expect(axios).not.toHaveBeenCalled();
        });

        test('POST /hub/mirrors/test permits private target when ALLOW_PRIVATE is set', async () => {
            const prev = process.env.WUD_REGISTRY_MIRROR_ALLOW_PRIVATE;
            process.env.WUD_REGISTRY_MIRROR_ALLOW_PRIVATE = 'true';
            (dns.lookup as any).mockResolvedValueOnce({
                address: '127.0.0.1',
                family: 4,
            });
            try {
                const res = await request(mirrorApp)
                    .post('/hub/mirrors/test')
                    .send({ url: 'http://localhost:5000' });
                expect(res.status).toBe(200);
                expect(res.body.ok).toBe(true);
                expect(res.body.kind).toBe('bearer');
            } finally {
                if (prev === undefined)
                    delete process.env.WUD_REGISTRY_MIRROR_ALLOW_PRIVATE;
                else process.env.WUD_REGISTRY_MIRROR_ALLOW_PRIVATE = prev;
            }
        });

        test('POST /hub/mirrors/test treats DNS failure as not-blocked', async () => {
            (dns.lookup as any).mockRejectedValueOnce(new Error('ENOTFOUND'));
            const res = await request(mirrorApp)
                .post('/hub/mirrors/test')
                .send({ url: 'https://mirror-unknown.example.com' });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
        });
    });
});
