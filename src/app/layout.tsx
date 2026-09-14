import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deaddrop — shared context",
  description: "A private inbox for your AI apps.",
  robots: { index: false, follow: false },
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
