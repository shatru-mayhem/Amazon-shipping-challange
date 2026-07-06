import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASCS Portal | Amazon Supply Chain Services",
  description:
    "Dual-entrance access for Amazon Supply Chain Services: Client Portal and Amazon Employee Portal.",
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
