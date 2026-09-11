import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { RouteProgress } from '@/components/RouteProgress';
import { PageTransition } from '@/components/PageTransition';
import { Footer } from '@/components/Footer';

export const metadata: Metadata = {
  title: 'Marketplace — доска объявлений',
  description: 'Покупайте и продавайте. Безопасные сделки с эскроу.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <RouteProgress />
        <QueryProvider>
          <div className="min-h-screen flex flex-col">
            <PageTransition>{children}</PageTransition>
            <Footer />
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
