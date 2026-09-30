import './globals.css';
import './findings.css';
import './maia-theme.css';
export const metadata = {
  title: 'Ali CT · Anatomy workspace',
  description: 'Explore CT anatomy, one slice at a time.',
};
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f2fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0b1f' },
  ],
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="aurora" aria-hidden="true">
          <div className="aurora__field">
            <span className="aurora__blob aurora__blob--1" />
            <span className="aurora__blob aurora__blob--2" />
            <span className="aurora__blob aurora__blob--3" />
            <span className="aurora__blob aurora__blob--4" />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
