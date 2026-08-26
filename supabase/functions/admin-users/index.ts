// supabase/functions/admin-users/index.ts
//
// Edge Function：帳號管理裡唯二需要 service role key 的兩件事
// ──「建立全新帳號」「重設密碼」。純前端 + RLS 做不到這兩件事，因為
// 建立 Supabase Auth 使用者、幫別人改密碼都要呼叫 Auth Admin API，
// 這把 key 絕對不能出現在瀏覽器端，只能放在 Edge Function 這種
// 伺服器端執行的環境（見 supabase/MIGRATION_PLAN.md「Auth & RLS」那節）。
//
// 對照 apps-script/Service.gs 的 adminSaveUser()（沒帶 userId 的
// 新增分支）／adminResetPassword()。「修改已存在帳號的角色/狀態/
// 顯示名稱」不需要 service role，走一般的 admin_update_user() RPC
// （見 supabase/functions.sql），不是這支的責任。
//
// 部署方式見 supabase/MIGRATION_PLAN.md Phase 6 那節。

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// 跟 migrate-from-sheets.js 用的合成 email 網域保持一致——這兩個地方
// 都是「舊系統沒有 email、Supabase Auth 又非要不可」這個限制下的
// 折衷做法，域名選什麼不重要，重要的是全站只有一個，不能兩邊各用一個。
const EMAIL_DOMAIN = 'migrated.local';

// Edge Function 預設不會自動附加 CORS 標頭——前端是瀏覽器直接呼叫
// （不是伺服器對伺服器），跨網域的 POST + Authorization/apikey 標頭
// 一定會先觸發瀏覽器的 CORS 預檢（OPTIONS），沒處理的話真正的請求
// 根本送不出去；就算送出去了，回應沒帶 Access-Control-Allow-Origin
// 一樣會被瀏覽器擋下來讀不到內容——這時候後端其實已經執行完成
// （密碼真的改了、帳號真的建了），但前端會看到一個看似失敗的網路
// 錯誤，變成「畫面顯示失敗，但實際上成功了」這種最容易誤判的狀況。
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function assertPasswordStrength(password: string) {
  if (password.length < 6) throw new Error('密碼至少 6 個字');
  if (password.length > 64) throw new Error('密碼請在 64 字以內');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // 呼叫者的身分只能信 Authorization header 裡的 JWT，不能信 body
  // 裡任何「我是管理員」的宣稱——用呼叫者自己的 token 建一個 client，
  // 先確認真的登入、真的是 active 的管理員，才切去 service role 做
  // 真正的操作。
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ error: '未登入' }, 401);

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authErr } = await callerClient.auth.getUser();
  if (authErr || !authData.user) return json({ error: '請重新登入' }, 401);

  const { data: callerProfile } = await callerClient
    .from('profiles')
    .select('role, status')
    .eq('id', authData.user.id)
    .single();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'active') {
    return json({ error: '只有管理員能執行這個操作' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: '請求格式錯誤' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const action = String(body.action || '');

  try {
    if (action === 'createUser') {
      const username = String(body.username || '').trim();
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
        return json({ error: '帳號只能用英數字與 _ . -，長度 3~20' }, 400);
      }
      const role = String(body.role || '');
      if (!['admin', 'patrol', 'owner'].includes(role)) {
        return json({ error: '角色不正確' }, 400);
      }
      const password = String(body.password || '');
      assertPasswordStrength(password);
      const displayName = String(body.displayName || username).substring(0, 30);

      const { data: existing } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', username)
        .maybeSingle();
      if (existing) return json({ error: '這個帳號已經存在' }, 400);

      const email = username.toLowerCase() + '@' + EMAIL_DOMAIN;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username },
      });
      if (createErr) return json({ error: createErr.message }, 400);

      const { error: profileErr } = await admin.from('profiles').insert({
        id: created.user.id,
        username,
        display_name: displayName,
        role,
        status: 'active',
      });
      if (profileErr) {
        // profiles 寫失敗的話，Auth 那邊已經建立的帳號會變成孤兒——
        // 盡量清掉，清不掉也不擋著把錯誤回報出去（讓管理員知道發生
        // 什麼事，好過整個吞掉）。
        await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
        return json({ error: profileErr.message }, 400);
      }

      return json({ userId: created.user.id });
    }

    if (action === 'resetPassword') {
      const userId = String(body.userId || '');
      if (!userId) return json({ error: '缺少帳號 ID' }, 400);
      const password = String(body.password || '');
      assertPasswordStrength(password);

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);

      return json({ userId, sessionsCleared: true });
    }

    return json({ error: '不支援的操作：' + action }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
