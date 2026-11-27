// Express + app.listen 风格（统一 ESM）
// 演示：异步路由包装 + 全局错误处理 + 静态托管 + OSS 读写 demo
// 平台自动拦截 listen 端口；本地用 process.env.PORT || 3000
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OSS from 'ali-oss';
import CredentialMod from '@alicloud/credentials';
// CJS/ESM 互操作：类在 .default 上
const Credential = CredentialMod.default || CredentialMod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, framework: 'express', flavor: 'listen', service: '留言板', message: '服务运行中' });
});

app.get('/api/users/:id', asyncHandler(async (req, res) => {
  const profile = await Promise.resolve({ name: `访客#${req.params.id}`, avatar: `/avatars/${req.params.id}.png` });
  res.json({ user: req.params.id, source: 'express', ...profile });
}));

app.post('/api/echo', asyncHandler(async (req, res) => {
  res.json({ received: req.body, echoed: true, timestamp: new Date().toISOString() });
}));

app.get('/api/error-demo', asyncHandler(async () => {
  throw new Error('演示错误：Express 全局错误中间件已捕获');
}));

// ===== OSS：运行时凭证链创建客户端（默认内网），目标由 I3X5_* 环境变量配置 =====
// 凭证由平台动态下发并自动轮转（ALIBABA_CLOUD_CREDENTIALS_URI），代码中无静态密钥
// 懒加载：避免无凭证源时顶层构造抛错导致进程起不来
let cred = null;
async function getOSS() {
  if (!cred) cred = new Credential();
  const c = await cred.getCredential();
  return new OSS({
    region: process.env.P36L_OSS_ASSETS_REGION,
    bucket: process.env.P36L_OSS_ASSETS_BUCKET,
    endpoint: process.env.P36L_OSS_ASSETS_ENDPOINT_INTERNAL, // 默认内网；公网改 _PUBLIC
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    stsToken: c.securityToken,
    secure: true,
    refreshSTSToken: async () => {
      const n = await cred.getCredential();
      return { accessKeyId: n.accessKeyId, accessKeySecret: n.accessKeySecret, stsToken: n.securityToken };
    },
    refreshSTSTokenInterval: 15 * 60 * 1000,
  });
}

// OSS 读写 demo：put / get / list / 签名URL / delete
app.get('/api/oss-demo', asyncHandler(async (req, res) => {
  const client = await getOSS();
  await client.put('hello.txt', Buffer.from('hello oss'));
  const got = await client.get('hello.txt');
  const content = got.content.toString();
  const listed = await client.list({ prefix: 'logs/', 'max-keys': 100 });
  const url = client.signatureUrl('hello.txt', { expires: 3600 });
  await client.delete('hello.txt');
  res.json({ ok: true, content, count: listed.objects?.length ?? 0, url });
}));

// 全局错误处理中间件（四参数，Express 识别为错误处理器）
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: '请求体必须是合法的 JSON 对象或数组' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'body_too_large', message: '请求体超过大小限制' });
    return;
  }
  console.error('[error-handler]', err.message);
  res.status(500).json({ error: 'internal', message: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on port ${port}`);
});
