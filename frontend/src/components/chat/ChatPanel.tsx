// src/components/chat/ChatPanel.tsx
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, MoreVertical, Lock } from 'lucide-react';
import { chatApi } from '@/lib/api';
import { getSocket } from '@/lib/socket';
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

export default function ChatPanel({ roomId, onClose }: ChatPanelProps) {
  const currentUser = useStore((s) => s.user);
  const qc = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();

  const { data: room, error: roomError } = useQuery({
    queryKey: ['chat-room', roomId],
    queryFn: () => chatApi.room(roomId),
    retry: false,
  });

  const { data: msgData, error: msgError } = useQuery({
    queryKey: ['chat-messages', roomId],
    queryFn: () => chatApi.messages(roomId),
    refetchInterval: 5000,
    retry: false,
  });

  const messages: Message[] = (msgData?.items ?? []) as Message[];
  const other = room?.participants?.find((p: { id: string }) => p.id !== currentUser?.id);

  const is403 =
    (roomError as Error)?.message?.includes('403') ||
    (roomError as Error)?.message?.toLowerCase().includes('authoris') ||
    (msgError as Error)?.message?.includes('403') ||
    (msgError as Error)?.message?.toLowerCase().includes('authoris');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Socket listeners
  useEffect(() => {
    const socket = getSocket();
    socket.emit('room:join', { room_id: roomId });

    socket.on('message:new', (msg) => {
      qc.setQueryData(['chat-messages', roomId], (old: typeof msgData) => {
        if (!old) return old;
        return { ...old, items: [...(old.items ?? []), msg as Message] };
      });
    });

    socket.on('user:typing', (data: { room_id: string }) => {
      if (data.room_id === roomId) setOtherTyping(true);
    });

    socket.on('user:stop-typing', (data: { room_id: string }) => {
      if (data.room_id === roomId) setOtherTyping(false);
    });

    return () => {
      socket.emit('room:leave', { room_id: roomId });
      socket.off('message:new');
      socket.off('user:typing');
      socket.off('user:stop-typing');
    };
  }, [roomId, qc]);

  const { mutate: send } = useMutation({
    // FIX: backend expects { text: "..." } — NOT content, NOT a plain string
    mutationFn: (content: string) => chatApi.sendMessage(roomId, { text: content }),
    onMutate: async (content) => {
      // Optimistic update
      const optimistic: Message = {
        id:         `opt-${Date.now()}`,
        room_id:    roomId,
        sender:     currentUser!,
        content,
        type:       'text',
        read_by:    [currentUser!.id],
        created_at: new Date().toISOString(),
      };
      qc.setQueryData(['chat-messages', roomId], (old: typeof msgData) => {
        if (!old) return { items: [optimistic], count: 1 };
        return { ...old, items: [...(old.items ?? []), optimistic] };
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-messages', roomId] }),
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
      getSocket().emit('user:typing', { room_id: roomId });
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2000);
  };

  const stopTyping = () => {
    setTyping(false);
    getSocket().emit('user:stop-typing', { room_id: roomId });
    clearTimeout(typingTimer.current);
  };

  // ── 403 — not authorized to chat (not poster or claimant) ────────────────────
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
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-secondary/50 flex items-center justify-center">
            <Lock className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="font-semibold text-foreground text-sm">Chat is restricted</p>
          <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
            Only the item poster and accepted claimants can access this chat.
            Submit a claim first to unlock the conversation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border/30">
        <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center overflow-hidden">
          {other?.avatar_url ? (
            <img src={other.avatar_url} className="w-full h-full object-cover" alt="" />
          ) : (
            <span className="text-xs font-bold text-emerald-400">{getInitials(other?.name || 'U')}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground text-sm truncate">{other?.name ?? 'Chat'}</p>
          <p className="text-xs text-emerald-400">Active</p>
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
            <p className="text-xs text-muted-foreground">Start the conversation</p>
          </div>
        )}
        {messages.map((msg) => {
          const isMine = msg.sender?.id === currentUser?.id ||
                        (msg as unknown as Record<string,string>).sender_id === currentUser?.id;
          const senderName = msg.sender?.name ||
                            (msg as unknown as Record<string,string>).sender_name || 'Unknown';
          const content = msg.content ||
                         (msg as unknown as Record<string,string>).text || '';
          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={cn('flex items-end gap-2', isMine ? 'flex-row-reverse' : '')}
            >
              {!isMine && (
                <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mb-1">
                  <span className="text-[10px] font-bold text-foreground">{getInitials(senderName)}</span>
                </div>
              )}
              <div className={cn('max-w-[75%] flex flex-col gap-1', isMine ? 'items-end' : 'items-start')}>
                <div className={isMine ? 'bubble-sent' : 'bubble-received'}>
                  <p className="text-sm leading-relaxed">{content}</p>
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
            placeholder="Type a message..."
            rows={1}
            className="flex-1 input-base resize-none min-h-[44px] max-h-32"
            style={{ lineHeight: '1.5' }}
          />
          <motion.button
            onClick={handleSend}
            disabled={!input.trim()}
            whileTap={{ scale: 0.95 }}
            className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center text-white shadow-emerald-sm disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 transition-all hover:bg-emerald-400"
          >
            <Send className="w-4 h-4" />
          </motion.button>
        </div>
      </div>
    </div>
  );
}