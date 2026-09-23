import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import LoginForm from '../../components/LoginForm.js';
import { SESSION_COOKIE, userFromToken } from '../../lib/auth.js';
export const metadata = { title: 'Sign in · AliAtlas' };
export default async function LoginPage() {
  if (await userFromToken((await cookies()).get(SESSION_COOKIE)?.value)) redirect('/');
  return <LoginForm />;
}
