import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AtlasWorkspace from '../components/AtlasWorkspace.js';
import { currentUser } from '../lib/auth.js';
import { maiaEnabled, maiaSignInUrl } from '../lib/maia.js';
export default async function Page() {
  const user = await currentUser(await headers());
  if (!user) redirect(maiaEnabled() ? maiaSignInUrl() : '/login');
  return <AtlasWorkspace user={{ email: user.email, name: user.name }} />;
}
