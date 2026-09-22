'use client';

import { useEffect, useState } from 'react';
import { ApiError, del, get, post } from '@/lib/api';
import { ImageUploader } from '@/components/ImageUploader';
import { ListingImageDto } from '@/lib/types';

function ExistingImagesEditor({ listingId }: { listingId: string }) {
  const [images, setImages] = useState<ListingImageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [newKeys, setNewKeys] = useState<{ key: string; position: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ data: { listing: { images: ListingImageDto[] } } }>(`/api/listings/${listingId}`).then((r) => {
      setImages(r.data.listing.images ?? []);
      setLoading(false);
    });
  }, [listingId]);

  const removeImage = async (imageId: string) => {
    if (!confirm('Удалить фото?')) return;
    try {
      const res = await del<{ data: { images: ListingImageDto[] } }>(
        `/api/listings/${listingId}/images/${imageId}`
      );
      setImages(res.data.images);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить фото');
    }
  };

  const saveNewImages = async () => {
    if (newKeys.length === 0) return;
    try {
      const res = await post<{ data: { images: ListingImageDto[] } }>(
        `/api/listings/${listingId}/images/done`,
        {
          imageKeys: newKeys,
        }
      );
      setImages(res.data.images);
      setNewKeys([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить фото');
    }
  };

  if (loading) return <p className="text-sm text-gray-500">Загрузка фото…</p>;

  return (
    <div>
      <div className="grid grid-cols-4 gap-3">
        {images.map((img) => (
          <div key={img.id} className="relative aspect-square overflow-hidden rounded-lg bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.thumbUrl ?? img.url} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => removeImage(img.id)}
              className="absolute right-1 top-1 rounded-full bg-black/60 px-2 text-xs text-white"
              aria-label="Удалить фото"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <p className="mb-2 text-sm text-gray-500">Добавить новые фото:</p>
        <ImageUploader value={newKeys} onChange={setNewKeys} onUploadingChange={setUploading} />
        {newKeys.length > 0 && (
          <button type="button" className="btn-secondary mt-2 text-xs" onClick={saveNewImages} disabled={uploading}>
            Применить новые фото
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

export { ExistingImagesEditor };