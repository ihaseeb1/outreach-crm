/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // imapflow / nodemailer are node-only; keep them out of the bundler's traced graph
  serverExternalPackages: ["imapflow", "nodemailer"],
};

export default nextConfig;
