import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import AtlasWorkspace from '../components/AtlasWorkspace.js';
import { SESSION_COOKIE, userFromToken } from '../lib/auth.js';
export default async function Page() {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  return <AtlasWorkspace user={{ email: user.email, name: user.name }} />;
}
