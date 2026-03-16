// src/pages/ChatPage.tsx
// FIXES:
//   1. Backend returns rooms as { id, item_id, item_title, participants[], last_message.text }
//      — ChatPage was reading room.item.title and room.last_message.content which don't exist
//   2. Normalise room shape before rendering so it works with both old and new backend shapes
//   3. Search works on item_title and participant names

import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { MessageCircle, Search } from 'lucide-react';
import { useState } from 'react';
import { chatApi } from '@/lib/api';
import { useStore } from '@/store';
import { cn, formatRelativeTime, getInitials } from '@/lib/utils';
import ChatPanel from '@/components/chat/ChatPanel';

// Normalise a raw room object from the backend into a consistent shape
function normaliseRoom(r: Record<string, unknown>, myId: string) {
  // Support both shapes: old (item.title) and new (item_title)
  const itemTitle = (r.item_title as string)
    || ((r.item as Record<string, unknown>)?.title as string)
    || 'Unknown item';

  const itemId = (r.item_id as string) || (r.id as string) || '';
  const roomId = (r.id as string) || itemId;

  const participants = Array.isArray(r.participants)
    ? (r.participants as Record<string, string>[])
    : [];

  const other = participants.find((p) => p.id !== myId)
    ?? { id: '', name: 'Unknown', avatar_url: undefined };

  const lastMsg = r.last_message as Record<string, string> | null | undefined;
  const lastText = lastMsg?.text || lastMsg?.content || null;
  const lastTime = lastMsg?.created_at || null;

  return {
    id:           roomId,
    itemId,
    itemTitle,
    other,
    lastText,
    lastTime,
    unreadCount:  (r.unread_count as number) ?? 0,
    thumbnail:    r.thumbnail as string | null,
  };
}

export default function ChatPage() {
  const { roomId } = useParams<{ roomId?: string }>();
  const navigate    = useNavigate();
  const currentUser = useStore((s) => s.user);
  const [search, setSearch] = useState('');

  const { data: rawRooms = [], isLoading } = useQuery({
    queryKey: ['chat-rooms'],
    queryFn:  chatApi.rooms,
    refetchInterval: 10_000,
  });

  const rooms = (rawRooms as Record<string, unknown>[]).map((r) =>
    normaliseRoom(r, currentUser?.id ?? '')
  );

  const filtered = rooms.filter((r) =>
    r.itemTitle.toLowerCase().includes(search.toLowerCase()) ||
    r.other.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-full">
      {/* ── Rooms sidebar ── */}
      <div className={cn(
        'flex flex-col border-r border-border/30',
        roomId ? 'hidden md:flex w-80' : 'flex-1 md:w-80'
      )}>
        <div className="p-4 border-b border-border/30 space-y-3">
          <h2 className="font-display font-bold text-lg text-foreground">Messages</h2>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              className="input-base pl-9 text-xs py-2"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <div className="skeleton w-10 h-10 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton h-3.5 w-2/3 rounded" />
                    <div className="skeleton h-3 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-center p-4 gap-2">
              <MessageCircle className="w-10 h-10 text-muted-foreground/30" />
              <p className="text-muted-foreground text-sm">No conversations yet</p>
              <p className="text-xs text-muted-foreground">
                Claim an item to start chatting with its poster
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filtered.map((room) => {
                const isActive = room.id === roomId;
                return (
                  <motion.button
                    key={room.id}
                    onClick={() => navigate(`/chat/${room.id}`)}
                    whileHover={{ x: 2 }}
                    className={cn(
                      'w-full flex items-center gap-3 p-3 rounded-2xl transition-all text-left',
                      isActive
                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                        : 'hover:bg-secondary/50'
                    )}
                  >
                    {/* Avatar */}
                    <div className="relative flex-shrink-0">
                      <div className="w-10 h-10 rounded-full bg-secondary border border-border flex items-center justify-center overflow-hidden">
                        {room.other.avatar_url ? (
                          <img src={room.other.avatar_url} className="w-full h-full object-cover" alt="" />
                        ) : (
                          <span className="text-xs font-bold text-foreground">
                            {getInitials(room.other.name || 'U')}
                          </span>
                        )}
                      </div>
                      {room.unreadCount > 0 && (
                        <div className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-emerald-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">
                          {room.unreadCount > 9 ? '9+' : room.unreadCount}
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <p className={cn(
                          'text-sm font-semibold truncate',
                          isActive ? 'text-emerald-400' : 'text-foreground'
                        )}>
                          {room.other.name || 'Unknown'}
                        </p>
                        {room.lastTime && (
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">
                            {formatRelativeTime(room.lastTime)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {room.lastText
                          ? room.lastText.slice(0, 45) + (room.lastText.length > 45 ? '…' : '')
                          : `Re: ${room.itemTitle}`}
                      </p>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Chat area ── */}
      <div className={cn('flex-1', !roomId && 'hidden md:flex')}>
        {roomId ? (
          <ChatPanel roomId={roomId} onClose={() => navigate('/chat')} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4">
            <div className="w-20 h-20 rounded-3xl bg-emerald-500/10 flex items-center justify-center">
              <MessageCircle className="w-10 h-10 text-emerald-400" />
            </div>
            <div>
              <h3 className="font-display font-bold text-xl text-foreground mb-1">Your messages</h3>
              <p className="text-muted-foreground text-sm">Select a conversation to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}