import { AxiosRequestConfig } from 'axios';
import DockerRegistryV2 from '../../DockerRegistryV2';
import { ContainerImage } from '../../../model/container';

/**
 * Alibaba Cloud Container Registry (ACR / Aliyun) integration.
 *
 * ACR requires a Bearer token for every registry API call, and the token
 * endpoint is advertised by the registry itself through the `WWW-Authenticate`
 * header, e.g.
 *
 *   Bearer realm="https://dockerauth.cn-hangzhou.aliyuncs.com/auth",
 *          service="registry.aliyuncs.com:cn-hangzhou:26842"
 *
 * The generic `DockerRegistryV2` implementation only sends Basic credentials
 * when they are configured, and sends no `Authorization` header at all
 * otherwise. That makes public repositories unusable: every call answers 401
 * ("Request failed with status code 401") even though `docker pull` works
 * anonymously, because the Docker CLI performs the Bearer handshake below.
 *
 * The handshake itself is implemented once in `DockerRegistryV2`
 * (`getBearerChallenge` + `getBearerToken`), which also caches tokens per
 * `(registryUrl, image, credentials)` with their `expires_in` and applies the
 * configured proxy. This provider only wires the two calls together; an earlier
 * fork-local copy of the handshake had no timeout, no expiry and ignored the
 * proxy configuration.
 *
 * Any failure degrades to the previous behaviour instead of throwing, so a
 * registry that does not advertise a realm keeps working as before.
 */
class Alibaba extends DockerRegistryV2 {
    protected registryPattern = /^(?:[\w-]+\.)*aliyuncs\.com$/;

    getConfigurationSchema() {
        return this.joi.alternatives([
            this.joi.string().allow(''),
            this.joi.object().keys({
                username: this.joi.string(),
                password: this.joi.string(),
                token: this.joi.string(),
                auth: this.joi.string(),
            }),
        ]);
    }

    /**
     * Registry API origin (e.g. `https://registry.cn-hangzhou.aliyuncs.com`).
     *
     * `normalizeImage()` stores the base with a `/v2` suffix, and the image may
     * carry a repository path; both must be dropped because
     * `getBearerChallenge()` appends `/v2/` to the origin itself.
     */
    private getRegistryApiBase(image: ContainerImage): string {
        const url = String(
            (this.configuration && this.configuration.url) ||
                (image.registry && image.registry.url) ||
                '',
        ).trim();
        if (!url) {
            return '';
        }
        try {
            return new URL(url).origin;
        } catch {
            const host = url
                .replace(/^\/+/, '')
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, '');
            return host ? `https://${host}` : '';
        }
    }

    async authenticate(
        image: ContainerImage,
        requestOptions: AxiosRequestConfig,
    ): Promise<AxiosRequestConfig> {
        const credentials = this.getAuthCredentials();
        const registryUrl = this.getRegistryApiBase(image);

        if (!registryUrl) {
            return credentials
                ? this.authenticateBasic(requestOptions, credentials)
                : requestOptions;
        }

        try {
            const challenge = await this.getBearerChallenge(registryUrl);
            if (!challenge?.realm) {
                // No Bearer challenge (anonymous registry, or Basic auth):
                // keep the previous behaviour.
                return credentials
                    ? this.authenticateBasic(requestOptions, credentials)
                    : requestOptions;
            }

            const token = await this.getBearerToken(
                image,
                registryUrl,
                credentials,
                challenge,
            );
            if (!token) {
                throw new Error(
                    `No token returned by the Alibaba token endpoint ${challenge.realm}`,
                );
            }
            return this.authenticateBearer(requestOptions, token);
        } catch (e) {
            // Degrade to the previous behaviour instead of breaking the watcher.
            this.log.warn(
                `Unable to get an Alibaba Bearer token for ${image.name} (${
                    (e as any).message
                }) => falling back to basic authentication`,
            );
            return credentials
                ? this.authenticateBasic(requestOptions, credentials)
                : requestOptions;
        }
    }
}

export default Alibaba;
