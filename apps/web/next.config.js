/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*',
      },
      {
        source: '/webhook/:path*',
        destination: 'http://localhost:3001/webhook/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
