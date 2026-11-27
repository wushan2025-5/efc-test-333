// MNS 主题模型 demo（ESA RegionFunction / express，统一 ESM）
// 参考 PRD 第六章：接入链路默认内网 + STS 凭证链；推送链路 MNS 从公网 POST 到本函数 /api/mns/callback。
// 仅主题（Topic）模式，不做队列拉取。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MNSClient from '@alicloud/mns';
import CredentialMod from '@alicloud/credentials';

const Credential = CredentialMod.default || CredentialMod;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 推送回调是 XML/JSON 文本，单独用 text 解析；其余路由用 json
app.use('/api/mns/callback', express.text({ type: () => true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ===== MNS 客户端：运行时凭证链（STS 自动轮转），env 名按平台实际注入 KGQ4_* =====
// 注入值只有公网 endpoint（不带 scheme），这里补 http://；accountId 从 endpoint host 首段解析
function mnsEndpoint() {
  const ep = process.env.KGQ4_MNS_ASSETS_ENDPOINT_PUBLIC || '';
  return /^https?:\/\//i.test(ep) ? ep : 'http://' + ep;
}
function mnsAccountId() {
  return mnsEndpoint().replace(/^https?:\/\//i, '').split('/')[0].split('.')[0];
}
let cred = null;
async function getMNS() {
  if (!cred) cred = new Credential();
  const c = await cred.getCredential();
  const ep = mnsEndpoint();
  return new MNSClient(mnsAccountId(), {
    region: process.env.KGQ4_MNS_REGION,
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    securityToken: c.securityToken,
    endpoint: ep,
    internal: false, // 注入的是公网接入点
    secure: ep.startsWith('https'),
    refreshSTSToken: async () => {
      const n = await cred.getCredential();
      return { accessKeyId: n.accessKeyId, accessKeySecret: n.accessKeySecret, securityToken: n.securityToken };
    },
  });
}

const topic = () => process.env.KGQ4_MNS_QUEUE_NAME || 'demo-topic';
const XMLNS = 'http://mns.aliyuncs.com/doc/v1/';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'mns-demo', model: 'topic' }));

// 6.1 发布消息（接入链路）
app.post('/api/mns/publish', asyncHandler(async (req, res) => {
  const client = await getMNS();
  const body = req.body?.message ?? JSON.stringify({ orderId: 1001, ts: Date.now() });
  const params = { MessageBody: typeof body === 'string' ? body : JSON.stringify(body) };
  if (req.body?.tag) params.MessageTag = String(req.body.tag);
  const r = await client.publishMessage(topic(), params);
  res.json({ ok: true, messageId: r.body.MessageId });
}));

// 6.2 创建主题 + 把云函数公网地址订阅为 HTTP 推送端点
// SDK 的 subscribe 是空 stub，这里用底层 put 拼 XML 实现
app.post('/api/mns/setup', asyncHandler(async (req, res) => {
  const client = await getMNS();
  const endpoint = req.body?.endpoint || process.env.MNS_EVENTS_CALLBACK_URL;
  if (!endpoint) return res.status(400).json({ ok: false, error: '需要推送端点：body.endpoint 或 env MNS_EVENTS_CALLBACK_URL（必须公网，形如 https://<函数公网域名>/api/mns/callback）' });
  try { await client.createTopic(topic(), {}); } catch (e) {
    if (!/TopicAlreadyExist/i.test(`${e.name} ${e.message}`)) throw e;
  }
  const subName = req.body?.subName || 'sub-to-cloudfn';
  const xml = Buffer.from(`<Subscription xmlns="${XMLNS}"><Endpoint>${esc(endpoint)}</Endpoint><NotifyContentFormat>JSON</NotifyContentFormat><NotifyStrategy>EXPONENTIAL_DECAY_RETRY</NotifyStrategy></Subscription>`);
  await client.put(`/topics/${topic()}/subscriptions/${encodeURIComponent(subName)}`, 'Subscription', xml);
  res.json({ ok: true, topic: topic(), subName, endpoint });
}));

// 6.3 接收推送（推送链路）：存内存 inbox，返回 201 + 规范 XML，否则 MNS 重试
const inbox = [];
app.post('/api/mns/callback', (req, res) => {
  inbox.unshift({ time: new Date().toISOString(), raw: String(req.body || '') });
  if (inbox.length > 50) inbox.length = 50;
  res.status(201).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Notification><ReceiptHandle>ok</ReceiptHandle></Notification>');
});

app.get('/api/mns/pushed', (req, res) => res.json({ ok: true, messages: inbox }));

app.use((err, req, res, next) => {
  console.error('[error-handler]', err.message);
  res.status(500).json({ error: 'internal', message: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on port ${port}`));
