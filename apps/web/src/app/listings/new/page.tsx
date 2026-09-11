'use client';

import { Header } from '@/components/Header';
import { ListingForm } from '@/components/ListingForm';

export default function NewListingPage() {
  return (
    <div>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Новое объявление</h1>
        <ListingForm mode="create" />
      </main>
    </div>
  );
}
