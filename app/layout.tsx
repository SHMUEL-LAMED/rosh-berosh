import type { Metadata } from "next";
import "./globals.css";
import { PlayerProvider } from "./player-context";

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "ראש בראש",
  alternateName: "מצעד 25 שנות מוזיקה יהודית",
  url: "https://rosh-berosh.smwlyqswkwt232.workers.dev/",
  inLanguage: "he-IL",
  description: "מצביעים ובוחרים את האלבומים, השירים והזמרים הגדולים של 25 שנות מוזיקה יהודית.",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://rosh-berosh.smwlyqswkwt232.workers.dev"),
  title: {
    default: "ראש בראש | מצעד 25 שנות מוזיקה יהודית",
    template: "%s | ראש בראש",
  },
  description: "מצביעים ובוחרים את האלבומים, השירים והזמרים הגדולים של 25 שנות מוזיקה יהודית.",
  keywords: ["ראש בראש", "מצעד מוזיקה יהודית", "מוזיקה חסידית", "אלבומים", "שירים", "זמרים", "הצבעה"],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "he_IL",
    url: "/",
    siteName: "ראש בראש",
    title: "ראש בראש | מצעד 25 שנות מוזיקה יהודית",
    description: "מצביעים ובוחרים את האלבומים, השירים והזמרים הגדולים של 25 שנות מוזיקה יהודית.",
    images: [{ url: "/badge.jpg", width: 1200, height: 1200, alt: "ראש בראש – מצעד 25 שנות מוזיקה יהודית" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ראש בראש | מצעד 25 שנות מוזיקה יהודית",
    description: "מצביעים ובוחרים את האלבומים, השירים והזמרים הגדולים של 25 שנות מוזיקה יהודית.",
    images: ["/badge.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
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
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }} />
        <PlayerProvider>{children}</PlayerProvider>
      </body>
    </html>
  );
}
