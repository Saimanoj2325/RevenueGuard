import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SwRegister } from '@/components/SwRegister';

const base = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const metadata: Metadata = {
  title: 'RevenueGuard — money you delivered but did not bill',
  description: 'Finds deliveries that were never billed, chases overdue payments, and asks you before every invoice or message.',
  manifest: `${base}/manifest.webmanifest`,
  icons: { icon: `${base}/icon.svg`, apple: `${base}/icon-192.png` },
  appleWebApp: { capable: true, title: 'RevenueGuard', statusBarStyle: 'default' },
};
export const viewport: Viewport = { themeColor: '#F5F2EA', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-screen">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
