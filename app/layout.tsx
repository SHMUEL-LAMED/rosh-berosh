import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ראש בראש | מצעד 25 שנות מוזיקה",
  description: "בוחרים את האלבומים, השירים והזמרים הגדולים של המוזיקה היהודית.",
  icons: {
    icon: "favicon.svg",
    shortcut: "favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
