export interface ListingImageDto {
  id: string;
  url: string;
  thumbUrl?: string | null;
  position: number;
}

export interface SellerDto {
  id: string;
  name: string;
  avatarUrl: string | null;
  city: string | null;
  rating: number;
  ratingCount: number;
  isVerified: boolean;
}

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  icon?: string | null;
  parentId?: string | null;
  attributes?: CategoryAttributeDto[];
  children?: CategoryDto[];
}

export interface CategoryAttributeDto {
  id: string;
  key: string;
  label: string;
  type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT' | 'RANGE';
  unit?: string | null;
  required: boolean;
  options?: unknown;
  min?: number | null;
  max?: number | null;
}

export interface ListingDto {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  status: string;
  city: string;
  lat?: number | null;
  lng?: number | null;
  attributes: Record<string, string | number | boolean | null>;
  viewsCount: number;
  isFavorite?: boolean;
  createdAt: string;
  updatedAt: string;
  images: ListingImageDto[];
  seller: SellerDto;
  category?: {
    id: string;
    name: string;
    slug: string;
    parent?: { id: string; name: string; slug: string } | null;
    attributes?: CategoryAttributeDto[];
  };
  similar?: ListingDto[];
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface ConversationDto {
  id: string;
  listing: { id: string; title: string; price: number; images: ListingImageDto[] };
  participants: Array<{ id: string; name: string; avatarUrl: string | null }>;
  lastMessage: MessageDto | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  sender?: { id: string; name: string };
  text: string;
  createdAt: string;
}

export interface OrderDto {
  id: string;
  listingId: string;
  buyerId: string;
  amount: number;
  currency: string;
  status: 'PENDING' | 'PAID' | 'RELEASED' | 'REFUNDED' | 'DISPUTED';
  createdAt: string;
  listing?: ListingDto;
  buyer?: { id: string; name: string };
}
