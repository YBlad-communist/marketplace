'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { get, post } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';
import { ConversationDto, MessageDto } from '@/lib/types';
import { cn, formatDateTime, formatPrice } from '@/lib/format';

interface ContextMenuState {
  x: number;
  y: number;
  message: MessageDto;
}

function ChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const selectedId = searchParams.get('conv');

  const [activeId, setActiveId] = useState<string | null>(selectedId);
  const [messages, setMessages] = useState<Record<string, MessageDto[]>>({});
  const [text, setText] = useState('');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastTypingSent = useRef(0);
  const typingOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => get<{ data: { items: ConversationDto[] } }>('/api/conversations'),
  });
  const conversations = conversationsQuery.data?.data.items ?? [];

  const selectConversation = useCallback(
    (id: string) => {
      setActiveId(id);
      router.replace(`/chat?conv=${id}`, { scroll: false });
      const socket = connectSocket();
      socket.emit('conversation:join', id);
      socket.emit('message:read', id);
    },
    [router]
  );

  useEffect(() => {
    if (selectedId && selectedId !== activeId) setActiveId(selectedId);
  }, [selectedId, activeId]);

  // Удаление чата собеседником: убираем из списка и закрываем, если открыт.
  useEffect(() => {
    const socket = connectSocket();
    const onConversationDeleted = (p: { conversationId: string }) => {
      queryClient.setQueryData<{ data: { items: ConversationDto[] } }>(['conversations'], (old) =>
        old ? { data: { items: old.data.items.filter((c) => c.id !== p.conversationId) } } : old
      );
      setMessages((m) => {
        const next = { ...m };
        delete next[p.conversationId];
        return next;
      });
      setActiveId((current) => {
        if (current === p.conversationId) {
          router.replace('/chat', { scroll: false });
          return null;
        }
        return current;
      });
    };
    socket.on('conversation:deleted', onConversationDeleted);
    return () => {
      socket.off('conversation:deleted', onConversationDeleted);
    };
  }, [queryClient, router]);

  useEffect(() => {
    if (!activeId) return;
    const socket = connectSocket();
    socket.emit('conversation:join', activeId);
    socket.emit('message:read', activeId);

    get<{ data: { items: MessageDto[] } }>(`/api/conversations/${activeId}/messages?limit=100`).then((r) =>
      setMessages((m) => ({ ...m, [activeId]: r.data.items }))
    );

    const onNewMessage = (msg: MessageDto) => {
      if (msg.conversationId !== activeId) return;
      setMessages((m) => ({ ...m, [msg.conversationId]: [...(m[msg.conversationId] ?? []), msg] }));
      socket.emit('message:read', msg.conversationId);
    };
    const onTyping = (p: { conversationId: string; isTyping: boolean }) => {
      setTyping((t) => ({ ...t, [p.conversationId]: p.isTyping }));
    };
    const onMessageDeleted = (p: { conversationId: string; messageId: string }) => {
      setMessages((m) => ({
        ...m,
        [p.conversationId]: (m[p.conversationId] ?? []).map((msg) =>
          msg.id === p.messageId
            ? { ...msg, text: 'Сообщение удалено', deletedAt: new Date().toISOString() }
            : msg
        ),
      }));
    };
    const onMessageEdited = (msg: MessageDto) => {
      if (msg.conversationId !== activeId) return;
      setMessages((m) => ({
        ...m,
        [msg.conversationId]: (m[msg.conversationId] ?? []).map((x) => (x.id === msg.id ? msg : x)),
      }));
    };

    socket.on('message:new', onNewMessage);
    socket.on('typing', onTyping);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('message:edited', onMessageEdited);
    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('typing', onTyping);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('message:edited', onMessageEdited);
    };
  }, [activeId]);

  // Закрытие ПКМ-меню по клику мимо, скроллу и Escape.
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeId]);

  const send = () => {
    if (!activeId || !text.trim()) return;
    const socket = connectSocket();
    const body = { conversationId: activeId, text };
    setText('');
    socket.emit('message:send', body, (res: { ok: boolean; message?: MessageDto }) => {
      if (res.ok && res.message) {
        setMessages((m) => ({ ...m, [activeId]: [...(m[activeId] ?? []), res.message!] }));
      } else {
        setText(body.text);
      }
    });
  };

  const extFor = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() ?? 'jpg';
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(`.${ext}`) ? `.${ext}` : '.jpg';
  };

  const sendPhoto = async (file: File) => {
    if (!activeId) return;
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
        { conversationId: activeId, text: caption, imageKey: presign.data.key },
        (ack: { ok: boolean; error?: string; message?: MessageDto }) => {
          if (ack.ok && ack.message) {
            setMessages((m) => ({ ...m, [activeId]: [...(m[activeId] ?? []), ack.message!] }));
          } else {
            if (caption) setText(caption);
            alert(ack.error ?? 'Не удалось отправить фото');
          }
        }
      );
    } catch {
      alert('Не удалось загрузить фото');
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
    // Меню не вылезает за правый/нижний край экрана.
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 140),
      message,
    });
  };

  const startEdit = (message: MessageDto) => {
    setEditingId(message.id);
    setEditText(message.text);
    setMenu(null);
  };

  const saveEdit = () => {
    if (!activeId || !editingId || !editText.trim()) return;
    const socket = connectSocket();
    const id = editingId;
    const newText = editText.trim();
    setEditingId(null);
    socket.emit(
      'message:edit',
      { conversationId: activeId, messageId: id, text: newText },
      (res: { ok: boolean; error?: string; message?: MessageDto }) => {
        if (res.ok && res.message) {
          const updated = res.message;
          setMessages((m) => ({
            ...m,
            [activeId]: (m[activeId] ?? []).map((x) => (x.id === id ? updated : x)),
          }));
        } else {
          alert(res.error ?? 'Не удалось отредактировать сообщение');
        }
      }
    );
  };

  const deleteMessage = (message: MessageDto) => {
    if (!activeId) return;
    setMenu(null);
    if (!confirm('Удалить сообщение?')) return;
    const socket = connectSocket();
    socket.emit(
      'message:delete',
      { conversationId: activeId, messageId: message.id },
      (res: { ok: boolean }) => {
        if (res.ok) {
          setMessages((m) => ({
            ...m,
            [activeId]: (m[activeId] ?? []).map((msg) =>
              msg.id === message.id
                ? { ...msg, text: 'Сообщение удалено', deletedAt: new Date().toISOString() }
                : msg
            ),
          }));
        }
      }
    );
  };

  const deleteConversation = () => {
    if (!activeId) return;
    if (!confirm('Удалить чат для обоих участников? Сообщения и фото будут удалены безвозвратно.')) return;
    const socket = connectSocket();
    const id = activeId;
    socket.emit('conversation:delete', id, (res: { ok: boolean; error?: string }) => {
      if (res.ok) {
        queryClient.setQueryData<{ data: { items: ConversationDto[] } }>(['conversations'], (old) =>
          old ? { data: { items: old.data.items.filter((c) => c.id !== id) } } : old
        );
        setMessages((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        setActiveId(null);
        router.replace('/chat', { scroll: false });
      } else {
        alert(res.error ?? 'Не удалось удалить чат');
      }
    });
  };

  const onTypingStart = () => {
    if (!activeId) return;
    // Троттлинг: шлём isTyping:true не чаще раза в 1.5с, чтобы не ддосить сокет каждым кейстроком.
    const now = Date.now();
    const socket = connectSocket();
    if (now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now;
      socket.emit('typing', { conversationId: activeId, isTyping: true });
    }
    if (typingOffTimer.current) clearTimeout(typingOffTimer.current);
    typingOffTimer.current = setTimeout(
      () => socket.emit('typing', { conversationId: activeId, isTyping: false }),
      1500
    );
  };

  const previewText = (c: ConversationDto): string => {
    if (!c.lastMessage) return 'Нет сообщений';
    if (c.lastMessage.deletedAt) return 'Сообщение удалено';
    if (c.lastMessage.text) return c.lastMessage.text;
    return '📷 Фото';
  };

  const activeMessages = activeId ? messages[activeId] ?? [] : [];
  const activeConv = conversations.find((c) => c.id === activeId);
  const otherParticipant = activeConv?.participants.find((p) => p.id !== userId);
  const otherName = otherParticipant?.name ?? 'Собеседник';

  return (
    <div>
      <Header />
      <main className="mx-auto flex max-w-container flex-col gap-4 px-4 py-6 md:flex-row">
        <div className="w-full shrink-0 md:w-72">
          <h1 className="mb-4 text-lg font-bold">Чаты</h1>
          <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
            {conversations.map((c) => {
              const name = c.participants.find((p) => p.id !== userId)?.name ?? 'Чат';
              return (
                <button
                  key={c.id}
                  onClick={() => selectConversation(c.id)}
                  className="card relative w-full p-3 text-left"
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {c.unreadCount > 0 && (
                      <span className="rounded-full bg-accent px-2 text-xs font-medium text-white">{c.unreadCount}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-textSecondary">{c.listing.title}</div>
                  <div className="mt-1 truncate text-xs text-textMuted">{previewText(c)}</div>
                  {c.id === activeId && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-inset ring-accent"
                    />
                  )}
                </button>
              );
            })}
            {conversations.length === 0 && <div className="text-sm text-textSecondary">Чатов пока нет</div>}
          </div>
        </div>

        <div className="card flex h-[70vh] flex-1 flex-col">
          {activeId ? (
            <>
              <div className="flex items-center justify-between border-b border-border p-4 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  {otherParticipant && (
                    <Link
                      href={`/users/${otherParticipant.id}`}
                      aria-label={`Профиль пользователя ${otherName}`}
                      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surfaceMuted text-sm font-bold text-textSecondary transition-colors hover:ring-2 hover:ring-focus"
                    >
                      {otherParticipant.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={otherParticipant.avatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (otherName[0] ?? '?').toUpperCase()
                      )}
                    </Link>
                  )}
                  <div className="min-w-0">
                    {otherParticipant ? (
                      <Link
                        href={`/users/${otherParticipant.id}`}
                        title="Открыть профиль"
                        className="block truncate font-medium hover:text-accentHover hover:underline"
                      >
                        {otherName}
                      </Link>
                    ) : (
                      <div className="font-medium">{otherName}</div>
                    )}
                    {activeConv && (
                      <div className="truncate text-xs text-textSecondary">
                        {activeConv.listing.title} · {formatPrice(activeConv.listing.price)}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={deleteConversation}
                  className="text-xs text-textMuted hover:text-danger"
                  title="Удалить чат для обоих участников"
                >
                  Удалить чат
                </button>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {activeMessages.map((m, i) => {
                  const mine = m.senderId === userId;
                  const prev = activeMessages[i - 1];
                  const showHeader = !prev || prev.senderId !== m.senderId;
                  const sender = activeConv?.participants.find((p) => p.id === m.senderId);
                  const name = sender?.name ?? 'Собеседник';
                  const avatar = sender?.avatarUrl;
                  const isEditing = editingId === m.id;
                  return (
                    <div key={m.id} className={cn('flex items-end gap-2', mine ? 'justify-end' : 'justify-start')}>
                      {!mine && showHeader && (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surfaceMuted text-xs font-semibold text-textSecondary">
                          {avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                          ) : (
                            (name[0] ?? '?').toUpperCase()
                          )}
                        </div>
                      )}
                      {!mine && !showHeader && <div className="w-8 shrink-0" />}
                      <div className={cn('flex max-w-[70%] flex-col', mine ? 'items-end' : 'items-start')}>
                        {!mine && showHeader && (
                          <div className="mb-0.5 px-1 text-xs font-medium text-textSecondary">{name}</div>
                        )}
                        <div
                          onContextMenu={(e) => openMenu(e, m)}
                          className={cn(
                            'break-words rounded-2xl px-3 py-2 text-sm shadow-sm',
                            mine
                              ? 'rounded-br-md bg-accent text-white'
                              : 'rounded-bl-md border border-border bg-surface text-textPrimary',
                            m.deletedAt && 'italic opacity-60'
                          )}
                        >
                          {(m.imageThumbUrl ?? m.imageUrl) && !m.deletedAt && (
                            <a
                              href={m.imageUrl ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={m.imageThumbUrl ?? m.imageUrl ?? ''}
                                alt=""
                                className="mb-1 max-h-64 rounded-lg object-cover"
                              />
                            </a>
                          )}
                          {isEditing ? (
                            <div className="min-w-48" onClick={(e) => e.stopPropagation()}>
                              <textarea
                                autoFocus
                                className="w-full rounded-lg border border-white/40 bg-surface/10 p-2 text-sm text-inherit outline-none"
                                rows={2}
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    saveEdit();
                                  }
                                }}
                              />
                              <div className="mt-1 flex gap-2 text-xs">
                                <button type="button" className="underline" onClick={saveEdit}>
                                  Сохранить
                                </button>
                                <button type="button" className="underline opacity-70" onClick={() => setEditingId(null)}>
                                  Отмена
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {m.text}
                              {m.editedAt && !m.deletedAt && (
                                <span className={cn('ml-1 text-[10px]', mine ? 'text-white/70' : 'text-textMuted')}>
                                  (изм.)
                                </span>
                              )}
                            </>
                          )}
                          <div
                            className={cn(
                              'mt-1 text-right text-[10px] leading-none',
                              mine ? 'text-white/70' : 'text-textMuted'
                            )}
                          >
                            {formatDateTime(m.createdAt)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {typing[activeId] && (
                  <div className="flex items-center gap-1 py-1" aria-label="Собеседник печатает">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              <div className="border-t border-border p-3">
                <div className="flex gap-2">
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void sendPhoto(f);
                  }} />
                  <button
                    type="button"
                    className="btn-secondary shrink-0"
                    title="Прикрепить фото"
                    disabled={uploadingPhoto}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploadingPhoto ? '…' : '📷'}
                  </button>
                  <input
                    className="input"
                    placeholder="Сообщение…"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') send();
                      else onTypingStart();
                    }}
                  />
                  <button className="btn-primary" onClick={send}>
                    Отправить
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-textMuted">Выберите чат слева</div>
          )}
        </div>
      </main>

      {menu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.message.senderId === userId && (
            <>
              <button
                type="button"
                className="block w-full px-4 py-2 text-left text-sm hover:bg-surfaceMuted"
                onClick={() => startEdit(menu.message)}
              >
                Редактировать
              </button>
              <button
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
              type="button"
              className="block w-full px-4 py-2 text-left text-sm hover:bg-surfaceMuted"
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

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div>
          <Header />
          <main className="container-x py-6 text-textMuted">Загрузка…</main>
        </div>
      }
    >
      <ChatContent />
    </Suspense>
  );
}
