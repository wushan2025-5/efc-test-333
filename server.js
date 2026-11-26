// Express + app.listen 风格
// 演示：异步路由包装（asyncHandler）+ 全局错误处理中间件 + 静态文件托管
// 平台自动拦截 listen 端口；本地用 process.env.PORT || 3000
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

// ---------------------------------------------------------------------------
// RDS Supabase 读写路由（supabase-js SDK / Data API 通道）
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.XIEU_SUPABASE_URL_HTTP;
const supabaseKey = process.env.XIEU_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// 可访问的表：public 下的业务表；其余为 Supabase 内置表。
// '*' 表示该 schema 下所有表，public 新建表自动进入访问范围。
const TABLE_ACL = {
  public: '*',
  mem0: ['memories', 'memories_raw_data', 'memory_async_tasks', 'memory_migrations'],
  storage: ['buckets', 'objects'],
  edge_function: ['functions', 'templates'],
  auth: ['users'],
};
// 只读 schema：禁止 INSERT/UPDATE/DELETE
const READ_ONLY_SCHEMAS = new Set(['auth']);

function dbReady(res) {
  if (!supabase) {
    res.status(503).json({
      error: 'db_not_configured',
      message: '缺少环境变量：SUPABASE_URL / SUPABASE_SERVICE_KEY',
    });
    return false;
  }
  return true;
}

// 白名单校验：schema/table 只允许取自 TABLE_ACL；service_role 绕过 RLS，故 ACL 是唯一访问边界
function aclCheck(schema, table, write, res) {
  const allow = TABLE_ACL[schema];
  if (!allow) {
    res.status(404).json({ error: 'schema_not_allowed', message: `schema 不在白名单：${schema}` });
    return false;
  }
  if (allow !== '*' && !allow.includes(table)) {
    res.status(404).json({ error: 'table_not_allowed', message: `表不在白名单：${schema}.${table}` });
    return false;
  }
  if (write && READ_ONLY_SCHEMAS.has(schema)) {
    res.status(403).json({ error: 'read_only_schema', message: `schema 只读：${schema}` });
    return false;
  }
  return true;
}

// PostgREST / Storage / 网络错误 → HTTP 状态
// 列名合法性由 PostgREST 服务端校验（未知列报 PGRST204），不再本地 introspect
function dbErrorStatus(err) {
  switch (err.code) {
    case '23505': return 409; // unique_violation
    case '23502': case '23514': case '22P02': return 400; // 参数 / 约束错误
    case '42P01': case '42703': return 404; // undefined_table / undefined_column
    case '42501': return 403; // insufficient_privilege（含 RLS / storage 删除保护）
    case 'PGRST204': return 400; // 列不在 schema cache（未知列 / 表无 id 列）
    case 'PGRST301': case 'PGRST302': return 502; // JWT 缺失 / 失效
    default: break;
  }
  const sc = Number(err.statusCode || err.status);
  if (sc >= 400 && sc < 600) return sc; // Storage API 等自带 HTTP 状态
  if (err instanceof TypeError) return 502; // fetch 网络失败
  return 500;
}
const dbHandler = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.code || err.statusCode || err.status || err instanceof TypeError) {
      console.error('[db-error]', err.code || err.statusCode || err.status, err.message);
      res.status(dbErrorStatus(err)).json({ error: 'db_error', code: err.code || err.statusCode || err.status, message: err.message });
      return;
    }
    throw err;
  }
});
// supabase-js 不抛异常而是返回 { error }，统一转 throw 交给 dbHandler
const unwrap = ({ data, error, count }) => {
  if (error) throw error;
  return { data, count };
};

// 连通性检查：对 storage.buckets 做 head count，验证 Data API 链路
app.get('/api/db/health', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { count } = unwrap(await supabase.schema('storage').from('buckets').select('id', { count: 'exact', head: true }));
  res.json({ ok: true, via: 'supabase-js', url: supabaseUrl, buckets: count });
}));

// 白名单清单（静态）：PostgREST 不暴露 information_schema，无法运行时枚举表
app.get('/api/db/tables', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const tables = [];
  for (const [schema, allow] of Object.entries(TABLE_ACL)) {
    if (allow === '*') tables.push({ table_schema: schema, table_name: '*' });
    else allow.forEach((t) => tables.push({ table_schema: schema, table_name: t }));
  }
  res.json({ count: tables.length, tables, note: '静态白名单；public.* 为通配，包含新建表，不是实时表清单' });
}));

// 读：列表（limit/offset 分页）
app.get('/api/db/:schema/:table', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { schema, table } = req.params;
  if (!aclCheck(schema, table, false, res)) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { data, count } = unwrap(await supabase.schema(schema).from(table).select('*', { count: 'exact' }).range(offset, offset + limit - 1));
  res.json({ schema, table, limit, offset, count: count == null ? data.length : count, rows: data });
}));

// 读：按 id 单行
app.get('/api/db/:schema/:table/:id', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { schema, table, id } = req.params;
  if (!aclCheck(schema, table, false, res)) return;
  const { data } = unwrap(await supabase.schema(schema).from(table).select('*').eq('id', id).maybeSingle());
  if (!data) {
    res.status(404).json({ error: 'not_found', message: `${schema}.${table} id=${id} 不存在` });
    return;
  }
  res.json({ schema, table, row: data });
}));

// 写：插入（列名由 PostgREST 服务端校验，未知列 PGRST204 → 400）
app.post('/api/db/:schema/:table', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { schema, table } = req.params;
  if (!aclCheck(schema, table, true, res)) return;
  if (!req.body || Object.keys(req.body).length === 0) {
    res.status(400).json({ error: 'empty_body', message: '请求体至少包含一个列字段' });
    return;
  }
  const { data } = unwrap(await supabase.schema(schema).from(table).insert(req.body).select());
  res.status(201).json({ schema, table, row: data[0] });
}));

// 写：按 id 更新（PUT，仅更新请求体提供的字段）
app.put('/api/db/:schema/:table/:id', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { schema, table, id } = req.params;
  if (!aclCheck(schema, table, true, res)) return;
  if (!req.body || Object.keys(req.body).length === 0) {
    res.status(400).json({ error: 'empty_body', message: '请求体至少包含一个列字段' });
    return;
  }
  const { data } = unwrap(await supabase.schema(schema).from(table).update(req.body).eq('id', id).select());
  if (!data || data.length === 0) {
    res.status(404).json({ error: 'not_found', message: `${schema}.${table} id=${id} 不存在` });
    return;
  }
  res.json({ schema, table, row: data[0] });
}));

// 写：按 id 删除
// storage.* 走 Storage API（Supabase 删除保护触发器禁止直删 SQL，Storage API 是官方通道）：
//   buckets → deleteBucket；objects → 先读 bucket_id/name 再 remove
// 其余 schema 走 PostgREST delete
app.delete('/api/db/:schema/:table/:id', dbHandler(async (req, res) => {
  if (!dbReady(res)) return;
  const { schema, table, id } = req.params;
  if (!aclCheck(schema, table, true, res)) return;
  if (schema === 'storage') {
    const { data: row } = unwrap(await supabase.schema('storage').from(table).select('*').eq('id', id).maybeSingle());
    if (!row) {
      res.status(404).json({ error: 'not_found', message: `${schema}.${table} id=${id} 不存在` });
      return;
    }
    if (table === 'buckets') {
      unwrap(await supabase.storage.deleteBucket(id));
    } else {
      unwrap(await supabase.storage.from(row.bucket_id).remove([row.name]));
    }
    res.json({ schema, table, deleted: row });
    return;
  }
  const { data } = unwrap(await supabase.schema(schema).from(table).delete().eq('id', id).select());
  if (!data || data.length === 0) {
    res.status(404).json({ error: 'not_found', message: `${schema}.${table} id=${id} 不存在` });
    return;
  }
  res.json({ schema, table, deleted: data[0] });
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
