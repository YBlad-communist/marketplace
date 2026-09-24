'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatListPane } from '@/components/chat/ChatListPane';
import { Composer } from '@/components/chat/Composer';
import { MessageBubble, BubbleStatus } from '@/components/chat/MessageBubble';
import { ChevronDownIcon, MessageCircleIcon } from '@/components/chat/icons';
import { EmptyState } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { ApiError, get, post } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';
import { ConversationDto, MessageDto } from '@/lib/types';
import { cn, dayLabel } from '@/lib/format';

type LocalMessage = MessageDto & { _failed?: boolean };

interface ContextMenuState {
  x: number;
  y: number;
  message: MessageDto;
}

const GROUP_WINDOW_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 50;
const DOWN_BUTTON_PX = 200;

function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export default function ChatConversationPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userId = useAuthStore((s) => s.user?.id);

  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [showDown, setShowDown] = useState(false);
  const [newBelow, setNewBelow] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTypingSent = useRef(0);
  const typingOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // DECISION: страница чата — ровно один экран без внешнего скролла: лочим body,
  // иначе клавиатура/свайпы сдвигают шапку и кнопку назад. scrollIntoView на фокусе
  // поля ввода НЕ делаем — он и был причиной «съезжания» верха (скроллил документ).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => get<{ data: { items: ConversationDto[] } }>('/api/conversations'),
  });
  const conv = conversationsQuery.data?.data.items.find((c) => c.id === id);
  const other = conv?.participants.find((p) => p.id !== userId);
  const otherName = other?.name ?? 'Собеседник';

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowDown(dist > DOWN_BUTTON_PX);
    if (dist < NEAR_BOTTOM_PX) setNewBelow(0);
  }, []);

  // Первичная загрузка + подписки сокета (логика без изменений).
  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    const socket = connectSocket();
    socket.emit('conversation:join', id);
    socket.emit('message:read', id);

    get<{ data: { items: MessageDto[] } }>(`/api/conversations/${id}/messages?limit=100`)
      .then((r) => {
        setMessages(r.data.items);
        setLoaded(true);
        requestAnimationFrame(() => scrollToBottom(false));
      })
      .catch((err) => {
        setLoaded(true);
        setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить сообщения');
      });

    const onNewMessage = (msg: MessageDto) => {
      if (msg.conversationId !== id) return;
      // DECISION: сервер шлёт message:new дважды (комната чата + личная комната юзера),
      // сокет состоит в обеих — отсекаем повтор по id, иначе сообщение двоится до перезагрузки.
      let duplicate = false;
      setMessages((m) => {
        if (m.some((x) => x.id === msg.id)) {
          duplicate = true;
          return m;
        }
        return [...m, msg];
      });
      if (duplicate) return;
      if (isNearBottom()) {
        requestAnimationFrame(() => scrollToBottom(true));
      } else {
        setNewBelow((n) => n + 1);
      }
      socket.emit('message:read', msg.conversationId);
    };
    const onTyping = (p: { conversationId: string; isTyping: boolean }) => {
      if (p.conversationId === id) setTyping(p.isTyping);
    };
    const onMessageDeleted = (p: { conversationId: string; messageId: string }) => {
      if (p.conversationId !== id) return;
      setMessages((m) =>
        m.map((msg) =>
          msg.id === p.messageId
            ? { ...msg, text: 'Сообщение удалено', deletedAt: new Date().toISOString() }
            : msg
        )
      );
    };
    const onMessageEdited = (msg: MessageDto) => {
      if (msg.conversationId !== id) return;
      setMessages((m) => m.map((x) => (x.id === msg.id ? msg : x)));
    };
    const onConversationDeleted = (p: { conversationId: string }) => {
      if (p.conversationId !== id) return;
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      toast('Собеседник удалил чат', 'info');
      router.push('/chat');
    };

    socket.on('message:new', onNewMessage);
    socket.on('typing', onTyping);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('message:edited', onMessageEdited);
    socket.on('conversation:deleted', onConversationDeleted);
    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('typing', onTyping);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('message:edited', onMessageEdited);
      socket.off('conversation:deleted', onConversationDeleted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Команды из меню шапки чата.
  useEffect(() => {
    const onClear = () => {
      setMessages([]);
      toast('История очищена локально', 'info');
    };
    const onDelete = () => {
      if (!confirm('Удалить чат для обоих участников? Сообщения и фото будут удалены безвозвратно.')) return;
      const socket = connectSocket();
      socket.emit('conversation:delete', id, (res: { ok: boolean; error?: string }) => {
        if (res.ok) {
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          router.push('/chat');
        } else {
          toast(res.error ?? 'Не удалось удалить чат', 'error');
        }
      });
    };
    window.addEventListener('chat:clear-history', onClear);
    window.addEventListener('chat:delete', onDelete);
    return () => {
      window.removeEventListener('chat:clear-history', onClear);
      window.removeEventListener('chat:delete', onDelete);
    };
  }, [id, queryClient, router, toast]);

  // Закрытие ПКМ-меню.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        setEditingId(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const addFailed = (failedText: string) => {
    const temp: LocalMessage = {
      id: `failed-${Date.now()}`,
      conversationId: id,
      senderId: userId ?? '',
      text: failedText,
      createdAt: new Date().toISOString(),
      _failed: true,
    };
    setMessages((m) => [...m, temp]);
    requestAnimationFrame(() => scrollToBottom(true));
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    const socket = connectSocket();
    setText('');
    socket.emit(
      'message:send',
      { conversationId: id, text: body },
      (res: { ok: boolean; error?: string; message?: MessageDto }) => {
        if (res.ok && res.message) {
          setMessages((m) => [...m, res.message!]);
          requestAnimationFrame(() => scrollToBottom(true));
        } else {
          addFailed(body);
          toast(res.error ?? 'Не удалось отправить', 'error');
        }
      }
    );
  };

  const retryFailed = (tempId: string, failedText: string) => {
    setMessages((m) => m.filter((x) => x.id !== tempId));
    const socket = connectSocket();
    socket.emit(
      'message:send',
      { conversationId: id, text: failedText },
      (res: { ok: boolean; error?: string; message?: MessageDto }) => {
        if (res.ok && res.message) {
          setMessages((m) => [...m, res.message!]);
          requestAnimationFrame(() => scrollToBottom(true));
        } else {
          addFailed(failedText);
        }
      }
    );
  };

  const extFor = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() ?? 'jpg';
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(`.${ext}`) ? `.${ext}` : '.jpg';
  };

  const sendPhoto = async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return;
    if (file.size > 5 * 1024 * 1024) return;
    setUploadingPhoto(true);
    try {
      const presign = await post<{ data: { key: string; uploadUrl: string } }>(
        '/api/uploads/images/presign',
        { scope: 'chat', mime: file.type, extension: extFor(file.name), sizeBytes: file.size }
      );
      const res = await fetch(presign.data.uploadUrl, { method: 'PUT', body: file });
      if (!res.ok) throw new Error('upload failed');
      const caption = text.trim();
      setText('');
      const socket = connectSocket();
      socket.emit(
        'message:send',
        { conversationId: id, text: caption, imageKey: presign.data.key },
        (ack: { ok: boolean; error?: string; message?: MessageDto }) => {
          if (ack.ok && ack.message) {
            setMessages((m) => [...m, ack.message!]);
            requestAnimationFrame(() => scrollToBottom(true));
          } else {
            if (caption) addFailed(caption);
            toast(ack.error ?? 'Не удалось отправить фото', 'error');
          }
        }
      );
    } catch {
      toast('Не удалось загрузить фото', 'error');
    } finally {
      setUploadingPhoto(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openMenu = (e: React.MouseEvent, message: MessageDto) => {
    e.preventDefault();
    if (message.deletedAt) return;
    const mine = message.senderId === userId;
    if (!mine && !message.text) return;
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 160),
      message,
    });
  };

  const saveEdit = () => {
    if (!editingId || !editText.trim()) return;
    const socket = connectSocket();
    const mid = editingId;
    const newText = editText.trim();
    setEditingId(null);
    socket.emit(
      'message:edit',
      { conversationId: id, messageId: mid, text: newText },
      (res: { ok: boolean; error?: string; message?: MessageDto }) => {
        if (res.ok && res.message) {
          const updated = res.message;
          setMessages((m) => m.map((x) => (x.id === mid ? updated : x)));
        } else {
          toast(res.error ?? 'Не удалось отредактировать сообщение', 'error');
        }
      }
    );
  };

  const deleteMessage = (message: MessageDto) => {
    setMenu(null);
    if (!confirm('Удалить сообщение?')) return;
    const socket = connectSocket();
    socket.emit(
      'message:delete',
      { conversationId: id, messageId: message.id },
      (res: { ok: boolean }) => {
        if (res.ok) {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === message.id
                ? { ...msg, text: 'Сообщение удалено', deletedAt: new Date().toISOString() }
                : msg
            )
          );
        }
      }
    );
  };

  const onTypingStart = () => {
    const now = Date.now();
    const socket = connectSocket();
    if (now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now;
      socket.emit('typing', { conversationId: id, isTyping: true });
    }
    if (typingOffTimer.current) clearTimeout(typingOffTimer.current);
    typingOffTimer.current = setTimeout(
      () => socket.emit('typing', { conversationId: id, isTyping: false }),
      1500
    );
  };

  // DECISION: сервер не отдаёт статусы доставки/прочтения — «прочитано» считаем,
  // если собеседник написал что-то позже (явно видел переписку).
  const otherAfter = useMemo(() => {
    let max = 0;
    for (const m of messages) {
      if (m.senderId !== userId && !m._failed) {
        max = Math.max(max, new Date(m.createdAt).getTime());
      }
    }
    return max;
  }, [messages, userId]);

  const statusOf = (m: LocalMessage): BubbleStatus => {
    if (m._failed) return 'failed';
    if (new Date(m.createdAt).getTime() < otherAfter) return 'read';
    return 'delivered';
  };

  return (
    <div>
      <Header />
      <main className="h-[calc(100dvh-var(--header-h))] overflow-hidden md:container-x md:py-6">
        <div className="grid h-full overflow-hidden md:grid-cols-[340px_1fr] md:gap-4">
          <div className="hidden min-h-0 flex-col overflow-hidden border-r border-border md:flex">
            <h1 className="shrink-0 px-4 pb-2 pt-4 text-2xl font-semibold text-textPrimary">Сообщения</h1>
            <div className="min-h-0 flex-1">
              <ChatListPane activeId={id} />
            </div>
          </div>

          <div className="flex h-full min-h-0 flex-col overflow-hidden overflow-x-hidden bg-surface md:rounded-2xl md:border md:border-border">
            <ChatHeader otherId={other?.id} otherName={otherName} otherAvatar={other?.avatarUrl} />

            <div className="relative flex min-h-0 flex-1 flex-col bg-surfaceMuted">
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="nice-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
                role="log"
                aria-label="Сообщения"
                aria-live="off"
              >
                {!loaded && (
                  <div className="space-y-2" role="status" aria-label="Загрузка сообщений">
                    {[70, 45, 60, 35, 55].map((w, i) => (
                      <div key={i} className={cn('flex', i % 2 ? 'justify-start' : 'justify-end')} aria-hidden>
                        <div className="skeleton h-10 rounded-2xl" style={{ width: `${w}%` }} />
                      </div>
                    ))}
                  </div>
                )}
                {loaded && loadError && (
                  <EmptyState
                    title="Не удалось загрузить сообщения"
                    hint={loadError}
                    action={
                      <Link href="/chat" className="btn-secondary text-sm">
                        Назад к спискам
                      </Link>
                    }
                  />
                )}
                {loaded && !loadError && messages.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface text-textMuted" aria-hidden>
                      <MessageCircleIcon />
                    </div>
                    <p className="mt-3 font-medium text-textPrimary">Начните переписку</p>
                    <p className="muted mt-1">Напишите первое сообщение ниже</p>
                  </div>
                )}
                {loaded &&
                  !loadError &&
                  messages.map((m, i) => {
                    const prev = messages[i - 1];
                    const next = messages[i + 1];
                    const showDate = !prev || !sameDay(prev.createdAt, m.createdAt);
                    const groupedPrev =
                      !!prev &&
                      prev.senderId === m.senderId &&
                      sameDay(prev.createdAt, m.createdAt) &&
                      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
                    const groupedNext =
                      !!next &&
                      next.senderId === m.senderId &&
                      sameDay(next.createdAt, m.createdAt) &&
                      new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime() < GROUP_WINDOW_MS;
                    const mine = m.senderId === userId;
                    return (
                      <div key={m.id}>
                        {showDate && (
                          <div className="my-2 flex justify-center" role="separator" aria-label={dayLabel(m.createdAt)}>
                            <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs text-textSecondary">
                              {dayLabel(m.createdAt)}
                            </span>
                          </div>
                        )}
                        <div className={groupedPrev ? 'mt-0.5' : 'mt-3'}>
                          <MessageBubble
                            message={m}
                            mine={mine}
                            groupStart={!groupedPrev}
                            groupEnd={!groupedNext}
                            status={mine ? statusOf(m) : 'delivered'}
                            editing={editingId === m.id}
                            editText={editText}
                            onEditText={setEditText}
                            onSaveEdit={saveEdit}
                            onCancelEdit={() => setEditingId(null)}
                            onContextMenu={openMenu}
                            onRetry={() => retryFailed(m.id, m.text)}
                          />
                        </div>
                      </div>
                    );
                  })}
                {typing && (
                  <div className="mt-3 flex justify-start" aria-label="Собеседник печатает">
                    <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-surface px-3 py-2.5 shadow-card">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  </div>
                )}
              </div>

              {showDown && (
                <button
                  type="button"
                  onClick={() => {
                    scrollToBottom(true);
                    setNewBelow(0);
                  }}
                  aria-label={newBelow > 0 ? `Вниз, новых сообщений: ${newBelow}` : 'Прокрутить вниз'}
                  className="absolute bottom-20 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-surface text-textSecondary shadow-modal transition-transform hover:scale-105"
                >
                  <ChevronDownIcon />
                  {newBelow > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-white">
                      {newBelow > 99 ? '99+' : newBelow}
                    </span>
                  )}
                </button>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void sendPhoto(f);
              }}
            />
            <Composer
              value={text}
              onChange={setText}
              onSend={send}
              onAttach={() => fileRef.current?.click()}
              onTyping={onTypingStart}
              uploading={uploadingPhoto}
            />
          </div>
        </div>
      </main>

      {menu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-modal"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
          aria-label="Действия с сообщением"
        >
          {menu.message.senderId === userId && !menu.message.deletedAt && (
            <>
              <button
                role="menuitem"
                type="button"
                className="block w-full px-4 py-2 text-left text-sm text-textPrimary hover:bg-surfaceMuted"
                onClick={() => {
                  setEditingId(menu.message.id);
                  setEditText(menu.message.text);
                  setMenu(null);
                }}
              >
                Редактировать
              </button>
              <button
                role="menuitem"
                type="button"
                className="block w-full px-4 py-2 text-left text-sm text-danger hover:bg-surfaceMuted"
                onClick={() => deleteMessage(menu.message)}
              >
                Удалить
              </button>
            </>
          )}
          {menu.message.text && (
            <button
              role="menuitem"
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-textPrimary hover:bg-surfaceMuted"
              onClick={() => {
                void navigator.clipboard?.writeText(menu.message.text).catch(() => undefined);
                setMenu(null);
              }}
            >
              Копировать текст
            </button>
          )}
        </div>
      )}
    </div>
  );
}
