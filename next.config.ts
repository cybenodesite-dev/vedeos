import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone للخدمة الذاتية/الساندبوكس؛ على Vercel نترك الإعداد الافتراضي
  output: process.env.VERCEL ? undefined : "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
