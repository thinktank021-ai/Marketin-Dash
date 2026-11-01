import { readFileSync, readdirSync } from 'node:fs';
import { derivePassword, guardAppRequest } from '../worker/app-auth.ts';

export async function authorizeTestEnv(env) {
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    env.DB.database.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const salt = '0123456789abcdef0123456789abcdef';
  env.DASHBOARD_ADMIN_PASSWORD_HASH = `scrypt-v1:${salt}:${(await derivePassword('test-only-password', salt)).toString('hex')}`;
  const response = await guardAppRequest(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Admin', password: 'test-only-password' }) }), env);
  if (response.status !== 200) throw new Error('Test login failed');
  return response.headers.get('set-cookie').split(';')[0];
}
