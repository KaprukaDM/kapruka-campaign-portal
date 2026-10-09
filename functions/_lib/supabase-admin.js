// functions/_lib/supabase-admin.js
// Minimal server-side Supabase REST client using the SERVICE ROLE key.
// Only ever call this from functions/api/*.js (server-side). The service
// role key bypasses Row Level Security, so it must never reach the browser —
// it is read from env.SUPABASE_SERVICE_ROLE_KEY, a Cloudflare secret, never
// from a file under js/.

function baseUrl(env) {
  // Same project as js/supabase-api.js (window.SUPABASE_URL there), but set
  // independently here as a Cloudflare env var/secret since this code runs
  // server-side in a Worker, where `window` doesn't exist.
  const url = env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not configured');
  return url;
}

function headers(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

// query is a Supabase PostgREST query string, e.g. "username=eq.lahiru&select=*"
export async function sbSelect(env, table, query = '') {
  const res = await fetch(`${baseUrl(env)}/rest/v1/${table}?${query}`, {
    headers: headers(env),
  });
  if (!res.ok) throw new Error(`Supabase select ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function sbInsert(env, table, rows) {
  const res = await fetch(`${baseUrl(env)}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(env), Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// query selects which rows to update, e.g. "id=eq.5"
export async function sbUpdate(env, table, query, patch) {
  const res = await fetch(`${baseUrl(env)}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...headers(env), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase update ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function sbDelete(env, table, query) {
  const res = await fetch(`${baseUrl(env)}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: headers(env),
  });
  if (!res.ok) throw new Error(`Supabase delete ${table} failed: ${res.status} ${await res.text()}`);
}
