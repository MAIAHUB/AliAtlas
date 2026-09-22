const nextConfig = {
  output: process.env.ATLAS_STANDALONE === 'true' ? 'standalone' : undefined,
  serverExternalPackages: ['dicom-parser', 'busboy', 'yauzl'],
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
