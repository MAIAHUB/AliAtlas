const nextConfig = {
  output: process.env.ATLAS_STANDALONE === 'true' ? 'standalone' : undefined,
  serverExternalPackages: ['dicom-parser', 'busboy', 'yauzl', 'pdfkit'],
  // pdfkit reads its standard-font metrics from disk at runtime.
  outputFileTracingIncludes: {
    '/api/studies/*/report/pdf': ['./node_modules/pdfkit/js/data/**/*'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default nextConfig;
