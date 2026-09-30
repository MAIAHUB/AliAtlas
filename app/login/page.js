import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import LoginForm from '../../components/LoginForm.js';
import { currentUser } from '../../lib/auth.js';
import { maiaEnabled, maiaSignInUrl } from '../../lib/maia.js';
export const metadata = { title: 'Sign in · Ali CT' };
// With MAIA connected, sign-in happens on MAIA (Google); this page only serves local accounts.
export default async function LoginPage() {
  if (maiaEnabled()) redirect(maiaSignInUrl());
  if (await currentUser(await headers())) redirect('/');
  return <LoginForm />;
}
