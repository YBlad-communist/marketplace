'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingForm } from '@/components/ListingForm';
import { get } from '@/lib/api';
import { ListingDto } from '@/lib/types';

export default function EditListingPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['listing', params.id],
    queryFn: () => get<{ data: { listing: ListingDto } }>(`/api/listings/${params.id}`),
  });

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Редактирование объявления</h1>
        {isLoading && <div className="text-gray-500">Загрузка…</div>}
        {data && <ListingForm mode="edit" initial={data.data.listing} />}
      </main>
    </div>
  );
}
