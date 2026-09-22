import './globals.css';
export const metadata = {
  title: 'AliAtlas · Anatomy workspace',
  description: 'Explore CT anatomy, one slice at a time.',
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
