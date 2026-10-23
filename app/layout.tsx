import type { Metadata } from "next";
import "./design-tokens.css";
import "./globals.css";
import "./admin.css";

export const metadata: Metadata = {
  title: "Dink Vision | Your court. Your moment.",
  description:
    "Record your Dink Vision match and keep your favorite moments.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
