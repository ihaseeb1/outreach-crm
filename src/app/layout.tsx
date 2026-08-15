import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Outreach CRM",
  description:
    "Cold outreach, mailbox warmup and link-building CRM — self-hosted.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
