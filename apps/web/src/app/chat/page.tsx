'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { get } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';
import { ConversationDto, MessageDto } from '@/lib/types';
import { cn, formatDateTime, formatPrice } from '@/lib/format';

function ChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = useAuthStore((s) => s.user?.id);
  const selectedId = searchParams.get('conv');

  const [activeId, setActiveId] = useState<string | null>(selectedId);
  const [messages, setMessages] = useState<Record<string, MessageDto[]>>({});
  const [text, setText] = useState('');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastTypingSent = useRef(0);
  const typingOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    socket.on('message:new', onNewMessage);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('typing', onTyping);
    };
  }, [activeId]);

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

  const activeMessages = activeId ? messages[activeId] ?? [] : [];
  const activeConv = conversations.find((c) => c.id === activeId);
  const otherName =
    activeConv?.participants.find((p) => p.id !== userId)?.name ?? 'Собеседник';

  return (
    <div>
      <Header />
      <main className="mx-auto flex max-w-6xl gap-4 px-4 py-6">
        <div className="w-72 shrink-0">
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
                      <span className="rounded-full bg-brand-600 px-2 text-xs font-medium text-white">{c.unreadCount}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-gray-500">{c.listing.title}</div>
                  <div className="mt-1 truncate text-xs text-gray-400">
                    {c.lastMessage ? c.lastMessage.text : 'Нет сообщений'}
                  </div>
                  {c.id === activeId && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-inset ring-brand-600"
                    />
                  )}
                </button>
              );
            })}
            {conversations.length === 0 && <div className="text-sm text-gray-500">Чатов пока нет</div>}
          </div>
        </div>

        <div className="card flex h-[70vh] flex-1 flex-col">
          {activeId ? (
            <>
              <div className="border-b border-gray-100 p-4 text-sm">
                <div className="font-medium">{otherName}</div>
                {activeConv && (
                  <div className="text-xs text-gray-500">
                    {activeConv.listing.title} · {formatPrice(activeConv.listing.price)}
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {activeMessages.map((m, i) => {
                  const mine = m.senderId === userId;
                  const prev = activeMessages[i - 1];
                  const showHeader = !prev || prev.senderId !== m.senderId;
                  const sender = activeConv?.participants.find((p) => p.id === m.senderId);
                  const name = sender?.name ?? 'Собеседник';
                  const avatar = sender?.avatarUrl;
                  return (
                    <div key={m.id} className={cn('flex items-end gap-2', mine ? 'justify-end' : 'justify-start')}>
                      {!mine && showHeader && (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">
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
                          <div className="mb-0.5 px-1 text-xs font-medium text-gray-500">{name}</div>
                        )}
                        <div
                          className={cn(
                            'break-words rounded-2xl px-3 py-2 text-sm shadow-sm',
                            mine
                              ? 'rounded-br-md bg-brand-600 text-white'
                              : 'rounded-bl-md border border-gray-100 bg-white text-gray-800'
                          )}
                        >
                          {m.text}
                          <div
                            className={cn(
                              'mt-1 text-right text-[10px] leading-none',
                              mine ? 'text-white/70' : 'text-gray-400'
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
              <div className="border-t border-gray-100 p-3">
                <div className="flex gap-2">
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
            <div className="flex flex-1 items-center justify-center text-gray-400">Выберите чат слева</div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div>
          <Header />
          <main className="mx-auto max-w-6xl px-4 py-6 text-gray-400">Загрузка…</main>
        </div>
      }
    >
      <ChatContent />
    </Suspense>
  );
}
