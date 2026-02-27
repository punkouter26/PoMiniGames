import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
  // Environment variables for API connection
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5002',
  },
};

export default nextConfig;
