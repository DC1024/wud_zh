const apickli = require('apickli');
const { Before, setDefaultTimeout } = require('@cucumber/cucumber');
const configuration = require('../../config');

// 60s：上游新增 ECR / trueforge 等 registry 后，POST /api/containers/watch 的
// 全量扫描会依次等待多个 401，20s 在 CI runner 上会偶发超时。
setDefaultTimeout(60 * 1000);

Before(function initApickli() {
    this.apickli = new apickli.Apickli(configuration.protocol, `${configuration.host}:${configuration.port}`);
    this.apickli.addHttpBasicAuthorizationHeader(configuration.username, configuration.password);
    this.apickli.addRequestHeader('Connection', 'close');
});
