import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabase } from './lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) => {
  const supabase = getSupabase();
  // 1) 插入（Create）
  const { data: inserted, error: e1 } = await supabase
    .from('orders')
    .insert({ user_id: 1, amount: 88.5 })
    .select();

  // 2) 查询（Read，带过滤、分页、排序）
  const { data: list, error: e2 } = await supabase
    .from('orders')
    .select('id, amount, created_at')
    .eq('user_id', 1)
    .order('created_at', { ascending: false })
    .range(0, 9);
   // 5) RPC 调用存储过程
  const { data: rpc } = await supabase.rpc('get_user_total', { uid: 1 });

  // 6) Storage 文件上传（Supabase 存储桶）
  await supabase.storage.from('avatars').upload(`u1/${Date.now()}.png`, req.body);

  return res.json({ list, rpc });
  //res.json({ ok: true, framework: 'express', flavor: 'listen', service: '留言板修改efc代码', message: '服务运行中' });
});

app.get('/api/users/:id', asyncHandler(async (req, res) => {
  const profile = await Promise.resolve({ name: `访客#${req.params.id}`, avatar: `/avatars/${req.params.id}.png` });
  res.json({ user: req.params.id, source: 'express', ...profile });
}));

app.post('/api/echo/', asyncHandler(async (req, res) => {
  res.json({ received: req.body, echoed: true, timestamp: new Date().toISOString() });
}));

app.get('/api/error-demo', asyncHandler(async () => {
  throw new Error('演示错误：Express 全局错误中间件已捕获');
}));

app.use((err, req, res, next) => {
  console.error('[error-handler]', err.message);
  res.status(500).json({ error: 'internal', message: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on port ${port}`);
});
