// src/components/chat/ChatPanel.tsx
// FIXES:
//   1. Socket event names: backend emits "new_message"/"user_typing" — frontend was
//      listening for "message:new"/"user:typing". Now aligned.
//   2. Socket room events: backend uses "join_room"/"leave_room" with {item_id},
//      frontend was sending "room:join"/"room:leave" with {room_id}. Now fixed.
//   3. Message content field: backend stores as "text", frontend expected "content".
//      Now reads both.
//   4. Socket connects once on mount with current token — no more auth failures.

import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, MoreVertical, Lock } from 'lucide-react';
import { chatApi } from '@/lib/api';
import { connectSocket, getSocket } from '@/lib/socket';
import { useStore } from '@/store';
import { cn, formatRelativeTime, getInitials } from '@/lib/utils';
import type { Message } from '@/types';

interface ChatPanelProps {
  roomId: string;
  onClose?: () => void;
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-4 py-3 glass rounded-2xl rounded-bl-sm w-fit">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="w-1.5 h-1.5 bg-muted-foreground rounded-full"
          animate={{ y: [0, -5, 0] }}
          transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </div>
  );
}

// Normalise a raw message from either REST or socket into a consistent shape
function normaliseMsg(raw: unknown): Message & { _text: string } {
  const m = raw as Record<string, unknown>;
  return {
    ...(m as unknown as Message),
    id:         (m.id ?? m._id ?? `opt-${Date.now()}`) as string,
    room_id:    (m.item_id ?? m.room_id ?? '') as string,
    content:    (m.content ?? m.text ?? '') as string,
    _text:      (m.text ?? m.content ?? '') as string,
    created_at: (m.created_at ?? new Date().toISOString()) as string,
    sender: m.sender as Message['sender'] ?? {
      id:         (m.sender_id ?? '') as string,
      name:       (m.sender_name ?? 'Unknown') as string,
      avatar_url: (m.sender_avatar ?? undefined) as string | undefined,
    } as unknown as Message['sender'],
  };
}

export default function ChatPanel({ roomId, onClose }: ChatPanelProps) {
  const currentUser   = useStore((s) => s.user);
  const qc            = useQueryClient();
  const bottomRef     = useRef<HTMLDivElement>(null);
  const [input, setInput]         = useState('');
  const [typing, setTyping]       = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const typingTimer   = useRef<ReturnType<typeof setTimeout>>();

  // ── Fetch room info (for "other" participant name/avatar) ──────────────────
  const { data: room, error: roomError } = useQuery({
    queryKey: ['chat-room', roomId],
    queryFn:  () => chatApi.room(roomId),
    retry:    false,
  });

  // ── Fetch messages ──────────────────────────────────────────────────────────
  const { data: msgData, error: msgError } = useQuery({
    queryKey: ['chat-messages', roomId],
    queryFn:  () => chatApi.messages(roomId),
    refetchInterval: 8000,
    retry: false,
  });

  const rawMessages: unknown[] = msgData?.items ?? [];
  const messages = rawMessages.map(normaliseMsg);

  // Find other participant — room.participants[] or fall back to item poster
  const other = (room?.participants as { id: string; name: string; avatar_url?: string }[] | undefined)
    ?.find((p) => p.id !== currentUser?.id);

  // ── 403 detection ─────────────────────────────────────────────────────────
  const is403 =
    (roomError as Error)?.message?.includes('403') ||
    (roomError as Error)?.message?.toLowerCase().includes('authoris') ||
    (msgError  as Error)?.message?.includes('403') ||
    (msgError  as Error)?.message?.toLowerCase().includes('authoris');

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Socket: connect + join room + listen ───────────────────────────────────
  useEffect(() => {
    // Ensure socket is connected (it may not be if token wasn't ready at app boot)
    const socket = connectSocket();

    // FIX: backend event is "join_room" with { item_id }, NOT "room:join" with { room_id }
    socket.emit('join_room', { item_id: roomId });

    // FIX: backend emits "new_message", NOT "message:new"
    const onNewMessage = (raw: unknown) => {
      const msg = normaliseMsg(raw);
      qc.setQueryData(['chat-messages', roomId], (old: typeof msgData) => {
        if (!old) return { items: [msg], count: 1 };
        // Deduplicate by id
        const existing = (old.items ?? []) as unknown[];
        const ids = new Set(existing.map((m) => (m as Record<string,string>).id));
        if (ids.has(msg.id)) return old;
        return { ...old, items: [...existing, msg] };
      });
    };

    // FIX: backend emits "user_typing" with { user_id, is_typing }, NOT "user:typing"
    const onUserTyping = (data: { user_id: string; is_typing: boolean }) => {
      if (data.user_id !== currentUser?.id) {
        setOtherTyping(data.is_typing);
        // Auto-clear after 3s in case stop event is missed
        if (data.is_typing) {
          setTimeout(() => setOtherTyping(false), 3000);
        }
      }
    };

    socket.on('new_message', onNewMessage);
    socket.on('user_typing', onUserTyping);
    // Also listen to camelCase variants just in case
    socket.on('message:new',     onNewMessage);
    socket.on('user:typing',     (d: { room_id: string }) => {
      if (d.room_id === roomId) setOtherTyping(true);
    });
    socket.on('user:stop-typing',(d: { room_id: string }) => {
      if (d.room_id === roomId) setOtherTyping(false);
    });

    return () => {
      // FIX: backend event is "leave_room" with { item_id }
      socket.emit('leave_room', { item_id: roomId });
      socket.off('new_message',      onNewMessage);
      socket.off('user_typing',      onUserTyping);
      socket.off('message:new',      onNewMessage);
      socket.off('user:typing');
      socket.off('user:stop-typing');
    };
  }, [roomId, qc, currentUser?.id]);

  // ── Send message ───────────────────────────────────────────────────────────
  const { mutate: send } = useMutation({
    mutationFn: (content: string) => chatApi.sendMessage(roomId, { text: content }),
    onMutate: async (content) => {
      // Optimistic update
      const optimistic = normaliseMsg({
        id:         `opt-${Date.now()}`,
        item_id:    roomId,
        sender_id:  currentUser?.id,
        sender_name: currentUser?.name,
        text:       content,
        created_at: new Date().toISOString(),
      });
      qc.setQueryData(['chat-messages', roomId], (old: typeof msgData) => {
        if (!old) return { items: [optimistic], count: 1 };
        return { ...old, items: [...(old.items ?? []), optimistic] };
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-messages', roomId] }),
    onError: () => qc.invalidateQueries({ queryKey: ['chat-messages', roomId] }),
  });

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    send(msg);
    stopTyping();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const startTyping = () => {
    if (!typing) {
      setTyping(true);
      // FIX: backend event is "typing" with { item_id, is_typing }, NOT "user:typing"
      getSocket().emit('typing', { item_id: roomId, is_typing: true });
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2000);
  };

  const stopTyping = () => {
    setTyping(false);
    getSocket().emit('typing', { item_id: roomId, is_typing: false });
    clearTimeout(typingTimer.current);
  };

  // ── 403 — not authorized ───────────────────────────────────────────────────
  if (is403) {
    return (
      <div className="flex flex-col h-full w-full">
        <div className="flex items-center gap-3 p-4 border-b border-border/30">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground text-sm">Chat</p>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary/50 flex items-center justify-center">
            <Lock className="w-7 h-7 text-muted-foreground" />
          </div>
          <div>
            <p className="font-semibold text-foreground text-sm mb-1">Chat is restricted</p>
            <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
              Only the item poster and claimants can access this chat.
              Submit a claim on the item page to unlock the conversation.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main chat UI ───────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border/30">
        <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center overflow-hidden flex-shrink-0">
          {other?.avatar_url ? (
            <img src={other.avatar_url} className="w-full h-full object-cover" alt="" />
          ) : (
            <span className="text-xs font-bold text-emerald-400">
              {getInitials(other?.name || 'U')}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground text-sm truncate">
            {other?.name ?? room?.item_title ?? 'Chat'}
          </p>
          <p className="text-xs text-emerald-400">
            {otherTyping ? 'Typing…' : 'Active'}
          </p>
        </div>
        <button className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground">
          <MoreVertical className="w-4 h-4" />
        </button>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 no-scrollbar">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 py-12">
            <p className="text-muted-foreground text-sm">No messages yet</p>
            <p className="text-xs text-muted-foreground">Start the conversation below</p>
          </div>
        )}

        {messages.map((msg) => {
          const isMine =
            msg.sender?.id === currentUser?.id ||
            (msg as unknown as Record<string, string>).sender_id === currentUser?.id;
          const senderName =
            msg.sender?.name ||
            (msg as unknown as Record<string, string>).sender_name ||
            'Unknown';
          // FIX: backend stores text in "text" field, not "content"
          const content = msg._text || msg.content || '';

          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={cn('flex items-end gap-2', isMine ? 'flex-row-reverse' : '')}
            >
              {!isMine && (
                <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mb-1">
                  <span className="text-[10px] font-bold text-foreground">
                    {getInitials(senderName)}
                  </span>
                </div>
              )}
              <div className={cn('max-w-[75%] flex flex-col gap-1', isMine ? 'items-end' : 'items-start')}>
                <div className={isMine ? 'bubble-sent' : 'bubble-received'}>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
                </div>
                <span className="text-[10px] text-muted-foreground px-1">
                  {formatRelativeTime(msg.created_at)}
                </span>
              </div>
            </motion.div>
          );
        })}

        {/* Typing indicator */}
        <AnimatePresence>
          {otherTyping && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="flex items-end gap-2"
            >
              <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center">
                <span className="text-[10px] font-bold">{getInitials(other?.name || 'U')}</span>
              </div>
              <TypingDots />
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-border/30">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => { setInput(e.target.value); startTyping(); }}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…"
            rows={1}
            className="flex-1 input-base resize-none min-h-[44px] max-h-32"
            style={{ lineHeight: '1.5' }}
          />
          <motion.button
            onClick={handleSend}
            disabled={!input.trim()}
            whileTap={{ scale: 0.95 }}
            className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center text-white disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 transition-all hover:bg-emerald-400"
          >
            <Send className="w-4 h-4" />
          </motion.button>
        </div>
      </div>
    </div>
  );
}