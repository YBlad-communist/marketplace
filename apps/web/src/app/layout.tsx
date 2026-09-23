import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { RouteProgress } from '@/components/RouteProgress';
import { PageTransition } from '@/components/PageTransition';
import { Footer } from '@/components/Footer';
import { MobileNav } from '@/components/MobileNav';
import { ToastProvider } from '@/components/ui/Toast';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Marketplace — доска объявлений',
  description: 'Покупайте и продавайте. Безопасные сделки с эскроу.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className={inter.variable}>
        <RouteProgress />
        <QueryProvider>
          <ToastProvider>
            <div className="flex min-h-screen flex-col">
              <PageTransition>
                <div className="pb-20 md:pb-0">{children}</div>
              </PageTransition>
              <Footer />
              <MobileNav />
            </div>
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
