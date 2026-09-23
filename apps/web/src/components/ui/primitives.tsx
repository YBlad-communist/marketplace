'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/format';

// ---------- Badge ----------

type BadgeTone = 'green' | 'red' | 'gray' | 'amber' | 'blue';

const badgeTones: Record<BadgeTone, string> = {
  green: 'badge-green',
  red: 'badge-red',
  gray: 'badge-gray',
  amber: 'badge-amber',
  blue: 'badge-blue',
};

export function Badge({ tone = 'gray', children, className }: { tone?: BadgeTone; children: React.ReactNode; className?: string }) {
  return <span className={cn(badgeTones[tone], className)}>{children}</span>;
}

// ---------- Avatar ----------

export function Avatar({ name, src, size = 'md', className }: { name: string; src?: string | null; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizes = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-16 w-16 text-xl' } as const;
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surfaceMuted font-bold text-textSecondary', sizes[size], className)}
      aria-hidden={src ? undefined : true}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        (name[0] ?? '?').toUpperCase()
      )}
    </div>
  );
}

// ---------- EmptyState ----------

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && (
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-surfaceMuted text-2xl text-textMuted" aria-hidden>
          {icon}
        </div>
      )}
      <p className="font-semibold text-textPrimary">{title}</p>
      {hint && <p className="muted mt-1">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------- Skeleton ----------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function CardSkeleton() {
  return (
    <div className="card overflow-hidden" aria-hidden>
      <Skeleton className="aspect-[4/3] !rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

// ---------- Tabs ----------

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs({ tabs, value, onChange, ariaLabel }: { tabs: TabItem[]; value: string; onChange: (id: string) => void; ariaLabel: string }) {
  return (
    <div className="tabs-list" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          className="tab-btn"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Pagination ----------

export function Pagination({ hasMore, onMore, label = 'Показать ещё' }: { hasMore: boolean; onMore: () => void; label?: string }) {
  if (!hasMore) return null;
  return (
    <div className="mt-8 flex justify-center">
      <button type="button" className="btn-secondary" onClick={onMore}>
        {label}
      </button>
    </div>
  );
}

// ---------- Breadcrumbs ----------

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Хлебные крошки" className="mb-4 text-sm text-textSecondary">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="text-textMuted">/</span>}
            {item.href ? (
              <Link href={item.href} className="hover:text-accentHover">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-textPrimary">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------- Accordion ----------

export function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between py-3 text-left text-sm font-medium text-textPrimary"
      >
        {title}
        <span aria-hidden className={cn('text-textMuted transition-transform', open && 'rotate-180')}>
          ⌄
        </span>
      </button>
      {open && <div className="pb-4 text-sm leading-body text-textSecondary">{children}</div>}
    </div>
  );
}

// ---------- RangeSlider ----------

export function RangeSlider({
  label,
  min,
  max,
  value,
  onChange,
  unit,
}: {
  label: string;
  min: number;
  max: number;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
}) {
  const shown = value === '' ? min : value;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium text-textPrimary">{label}</span>
        <span className="text-textSecondary">
          {shown}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        className="w-full accent-accent"
        min={min}
        max={max}
        value={value === '' ? String(min) : value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ---------- Dropdown ----------

export function Dropdown({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-2 min-w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-modal">
          {children}
        </div>
      )}
    </div>
  );
}
