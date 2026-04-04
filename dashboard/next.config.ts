import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  env: {
    STORE_DIR: path.join(__dirname, '..', 'store'),
  },
};
export default nextConfig;
