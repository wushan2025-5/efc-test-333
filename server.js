// Express + app.listen 风格
// 演示：异步路由包装（asyncHandler）+ 全局错误处理中间件 + 静态文件托管
// 平台自动拦截 listen 端口；本地用 process.env.PORT || 3000
import OSS from 'ali-oss';
import Credential from '@alicloud/credentials';

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// async 路由包装器：把 Promise rejection 转给错误中间件
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, framework: 'express', flavor: 'listen', service: '留言板', message: '服务运行中' });
});

app.get('/api/users/:id', asyncHandler(async (req, res) => {
  // 模拟异步查库
  const profile = await Promise.resolve({ name: `访客#${req.params.id}`, avatar: `/avatars/${req.params.id}.png` });
  res.json({ user: req.params.id, source: 'express', ...profile });
}));

app.post('/api/echo', asyncHandler(async (req, res) => {
  res.json({ received: req.body, echoed: true, timestamp: new Date().toISOString() });
}));

// 演示全局错误处理：抛出异常会被下方错误中间件捕获
app.get('/api/error-demo', asyncHandler(async () => {
  throw new Error('演示错误：Express 全局错误中间件已捕获');
}));

// lib/oss.js —— 用运行时凭证链创建 OSS 客户端（默认内网）
// 凭证由平台动态下发并自动轮转，代码中不出现任何长期或静态密钥


// 凭证链：自动从平台凭证服务(ALIBABA_CLOUD_CREDENTIALS_URI)拉取 STS 并在过期前续期
const cred = new Credential();
export async function getOSS() {
  const c = await cred.getCredential(); // 每次取到的都是当前有效的临时凭证
  // <别名> 示例为 ASSETS；默认走内网，直接用 _INTERNAL（如需公网改用 _PUBLIC）
  return new OSS({
    region: process.env.OSS_ASSETS_REGION,
    bucket: process.env.OSS_ASSETS_BUCKET,
    endpoint: process.env.OSS_ASSETS_ENDPOINT_INTERNAL,   // 默认内网
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    stsToken: c.securityToken,                   // STS 必须带
    secure: true,
    // 长时间运行时，SDK 通过凭证链自动续期，避免用过期凭证
    refreshSTSToken: async () => {
      const n = await cred.getCredential();
      return { accessKeyId: n.accessKeyId, accessKeySecret: n.accessKeySecret, stsToken: n.securityToken };
    },
    refreshSTSTokenInterval: 15 * 60 * 1000,
  });
}

function handler(req) {
  const client = await getOSS();

  // 1) 写入对象（Put）
  await client.put('hello.txt', Buffer.from('hello oss'));

  // 2) 读取对象（Get）
  const res = await client.get('hello.txt');
  const content = res.content.toString();

  // 3) 列举对象（List）
  const listed = await client.list({ prefix: 'logs/', 'max-keys': 100 });

  // 4) 生成带签名的临时下载 URL（前端直传/直读）
  const url = client.signatureUrl('hello.txt', { expires: 3600 });

  // 5) 删除对象（Delete）
  await client.delete('hello.txt');

  // 6) 分片/流式上传大文件
  // await client.multipartUpload('big.zip', someStream);

  return Response.json({ content, count: listed.objects?.length, url });
}
