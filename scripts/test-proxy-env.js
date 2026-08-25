// 验证两个运行模式共用的 Node 环境代理开关，避免代理变量存在但 fetch 仍直连。
const assert = require('node:assert/strict')
const {
  nodeProxyAssignment,
  withNodeEnvironmentProxy,
} = require('../dist/main/dsh.js')

const original = {
  HTTP_PROXY: 'http://127.0.0.1:7897',
  NODE_USE_ENV_PROXY: '0',
}
const resolved = withNodeEnvironmentProxy(original)

assert.equal(nodeProxyAssignment(), 'NODE_USE_ENV_PROXY=1')
assert.equal(resolved.HTTP_PROXY, original.HTTP_PROXY)
assert.equal(resolved.NODE_USE_ENV_PROXY, '1')
assert.equal(original.NODE_USE_ENV_PROXY, '0', '不得原地修改调用方的环境对象')

console.log('PROXY_ENV_TEST_OK')
