import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/*
  Archivo is a grotesque in the Swiss lineage with a usable 900 weight, which
  is what Exaggerated Minimalism needs: a headline set at 8rem has to hold the
  page on its own. Inter would be the safe pick and reads as every other
  AI-built SaaS page.
*/
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Colophon — retrieval you can audit",
  description:
    "Hybrid search, cross-encoder reranking, and grounded answers that cite the passage behind every claim.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
