import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { RouteProgress } from '@/components/RouteProgress';
import { PageTransition } from '@/components/PageTransition';
import { SiteChrome } from '@/components/SiteChrome';
import { MobileNav } from '@/components/MobileNav';
import { ChatNotifier } from '@/components/ChatNotifier';
import { ToastProvider } from '@/components/ui/Toast';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'РынокRU — доска объявлений',
  description: 'Покупайте и продавайте. Безопасные сделки с эскроу.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className={inter.variable}>
        <RouteProgress />
        <QueryProvider>
          <ToastProvider>
            <ChatNotifier />
            <div className="flex min-h-screen flex-col">
              <PageTransition>{children}</PageTransition>
              <SiteChrome />
              <MobileNav />
            </div>
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
