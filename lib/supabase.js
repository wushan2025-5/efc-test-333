// lib/supabase.js —— 统一创建客户端（默认内网，直接读该实例的 _INTERNAL 变量）
import { createClient } from '@supabase/supabase-js';

export function getSupabase() {
  // <别名> 示例为 MAINDB；默认走内网，直接用 _INTERNAL（如需公网改用 _PUBLIC）
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL_V98T;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_V98T; // 服务端云函数用 service_role
  return createClient(url, key, { auth: { persistSession: false } });
}
