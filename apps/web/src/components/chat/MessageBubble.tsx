'use client';

import { MessageDto } from '@/lib/types';
import { cn, formatBubbleTime } from '@/lib/format';
import { AlertCircleIcon, CheckCheckIcon, CheckIcon } from './icons';

export type BubbleStatus = 'sent' | 'delivered' | 'read' | 'failed';

function Ticks({ status }: { status: BubbleStatus }) {
  if (status === 'failed') {
    return <AlertCircleIcon className="h-4 w-4 text-danger" />;
  }
  if (status === 'read') {
    return <CheckCheckIcon className="h-4 w-4 text-info" />;
  }
  if (status === 'delivered') {
    return <CheckCheckIcon className="h-4 w-4" />;
  }
  return <CheckIcon className="h-4 w-4" />;
}

interface Props {
  message: MessageDto & { _failed?: boolean };
  mine: boolean;
  /** Первое сообщение группы одного отправителя (показать имя/аватар снаружи). */
  groupStart: boolean;
  /** Последнее сообщение группы (хвостик скругления). */
  groupEnd: boolean;
  status: BubbleStatus;
  editing: boolean;
  editText: string;
  onEditText: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onContextMenu: (e: React.MouseEvent, m: MessageDto) => void;
  onRetry: () => void;
}

export function MessageBubble({
  message: m,
  mine,
  groupStart,
  groupEnd,
  status,
  editing,
  editText,
  onEditText,
  onSaveEdit,
  onCancelEdit,
  onContextMenu,
  onRetry,
}: Props) {
  const failed = status === 'failed';

  const bubble = (
    <div
      onContextMenu={(e) => onContextMenu(e, m)}
      className={cn(
        'w-fit max-w-[75%] break-words px-3 py-1.5 text-sm leading-relaxed shadow-card md:max-w-[60%]',
        'rounded-2xl',
        mine ? 'ml-auto rounded-br-md bg-accentSoft text-textPrimary' : 'rounded-bl-md bg-surface text-textPrimary',
        !groupEnd && (mine ? '!rounded-br-2xl' : '!rounded-bl-2xl'),
        m.deletedAt && 'italic opacity-60',
        failed && 'border border-danger'
      )}
    >
      {(m.imageThumbUrl ?? m.imageUrl) && !m.deletedAt && (
        <a
          href={m.imageUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={m.imageThumbUrl ?? m.imageUrl ?? ''}
            alt=""
            loading="lazy"
            className="mb-1 max-h-64 w-full rounded-lg object-cover"
          />
        </a>
      )}
      {editing ? (
        <div className="min-w-48" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            aria-label="Редактирование сообщения"
            className="w-full rounded-lg border border-border bg-surface p-2 text-sm text-textPrimary outline-none"
            rows={2}
            value={editText}
            onChange={(e) => onEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSaveEdit();
              }
            }}
          />
          <div className="mt-1 flex gap-3 text-xs">
            <button type="button" className="font-medium text-accentHover underline" onClick={onSaveEdit}>
              Сохранить
            </button>
            <button type="button" className="text-textSecondary underline" onClick={onCancelEdit}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="whitespace-pre-wrap break-words">{m.text}</span>
          {m.editedAt && !m.deletedAt && <span className="ml-1 text-[11px] text-textMuted">(изм.)</span>}
        </>
      )}
      <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none text-textMuted">
        {formatBubbleTime(m.createdAt)}
        {mine && !m.deletedAt && <Ticks status={status} />}
      </span>
    </div>
  );

  if (failed) {
    return (
      <div className={cn('flex items-center gap-1', mine ? 'justify-end' : 'justify-start')}>
        <button
          type="button"
          onClick={onRetry}
          aria-label="Повторить отправку"
          title="Повторить отправку"
          className="rounded-full p-1 text-danger hover:bg-surfaceMuted"
        >
          <AlertCircleIcon />
        </button>
        {bubble}
      </div>
    );
  }
  void groupStart;
  return bubble;
}
