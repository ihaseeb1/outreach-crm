/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // imapflow / nodemailer are node-only; keep them out of the bundler's traced graph.
  // playwright is optional and only ever loaded by the standalone worker.
  serverExternalPackages: ["imapflow", "nodemailer", "playwright"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      {
        // The unsubscribe page is public and must never be indexed or cached.
        source: "/api/unsubscribe",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
