// src/pages/ItemDetailPage.tsx
import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MapPin, Clock, Tag, ChevronLeft, ChevronRight,
  MessageCircle, CheckCircle, Trash2, Zap, Sparkles,
  Share2, GitMerge,
} from 'lucide-react';
import { toast } from 'sonner';
import { itemsApi, chatApi } from '@/lib/api';
import { useStore } from '@/store';
import { CATEGORIES } from '@/types';
import { cn, formatRelativeTime, getInitials, getMatchBg, getMatchColor } from '@/lib/utils';
import { queryClient } from '@/lib/queryClient';
import ChatPanel from '@/components/chat/ChatPanel';
import { Skeleton } from '@/components/ui/Skeleton';

// ── helpers ────────────────────────────────────────────────────────────────────
// Backend returns images as { url, public_id, thumbnail } objects OR plain strings
function imgUrl(img: unknown): string {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (typeof img === 'object' && img !== null) {
    return (img as Record<string, string>).url || (img as Record<string, string>).thumbnail || '';
  }
  return '';
}

// Backend returns poster OR owner field
function getPoster(item: Record<string, unknown>) {
  const p = (item.poster || item.owner || {}) as Record<string, string>;
  return {
    id:          p.id          || (item.user_id as string) || '',
    name:        p.name        || 'Unknown',
    department:  p.department  || '',
    roll_number: p.roll_number || '',
    avatar_url:  p.avatar_url  || '',
  };
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.user);
  const [imgIdx, setImgIdx] = useState(0);
  const [showChat, setShowChat] = useState(false);
  const [chatRoomId, setChatRoomId] = useState<string | null>(null);
  const [claimMsg, setClaimMsg] = useState('');
  const [showClaimBox, setShowClaimBox] = useState(false);

  const { data: item, isLoading } = useQuery({
    queryKey: ['item', id],
    queryFn: () => itemsApi.get(id!),
    enabled: !!id,
  });

  const { mutate: resolve } = useMutation({
    mutationFn: () => itemsApi.markResolved(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      toast.success('Item marked as resolved! 🎉');
    },
  });

  const { mutate: deleteItem } = useMutation({
    mutationFn: () => itemsApi.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      toast.success('Item deleted');
      navigate('/items');
    },
  });

  const { mutate: claim, isPending: claiming } = useMutation({
    mutationFn: () => itemsApi.claim(id!, { message: claimMsg }),
    onSuccess: () => {
      toast.success('Claim submitted!');
      setShowClaimBox(false);
    },
    onError: (err: unknown) => toast.error((err as Error).message || 'Claim failed'),
  });

  const handleStartChat = async () => {
    if (!item) return;
    try {
      const poster = getPoster(item);
      const room = await chatApi.createRoom({
        item_id:        item.id || id,
        participant_id: poster.id,
      });
      setChatRoomId(room.id || room.room_id);
      setShowChat(true);
    } catch {
      toast.error('Could not start chat');
    }
  };

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied!');
  };

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-80 rounded-3xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <div className="text-5xl mb-4">😶</div>
        <h3 className="font-semibold text-foreground">Item not found</h3>
        <button onClick={() => navigate('/items')} className="mt-4 btn-emerald text-sm">
          Browse items
        </button>
      </div>
    );
  }

  // ── Normalise data from backend ───────────────────────────────────────────────
  const poster    = getPoster(item);
  const isOwner   = poster.id === currentUser?.id || item.user_id === currentUser?.id || item.is_mine;
  const category  = CATEGORIES.find((c) => c.id === item.category);
  const location  = item.location_name || item.campus_zone || item.location_id || '—';

  // Images: array of objects or strings
  const images: string[] = Array.isArray(item.images)
    ? item.images.map(imgUrl).filter(Boolean)
    : [];

  // Matches: backend embeds them in item.matches as { match_id, score, score_pct, highlights, item }
  const embeddedMatches: unknown[] = Array.isArray(item.matches) ? item.matches : [];

  // Tags
  const tags: string[] = Array.isArray(item.tags) ? item.tags : [];

  return (
    <div className="flex h-full">
      {/* ── Main content ── */}
      <div className="flex-1 overflow-y-auto p-6 md:p-8 max-w-4xl">

        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>

        {/* Image carousel */}
        <div className="relative rounded-3xl overflow-hidden bg-secondary/30 mb-8" style={{ aspectRatio: '16/9' }}>
          <AnimatePresence mode="wait">
            {images.length > 0 ? (
              <motion.img
                key={imgIdx}
                src={images[imgIdx]}
                alt={item.title}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-6xl bg-secondary/40">📦</div>
            )}
          </AnimatePresence>

          {images.length > 1 && (
            <>
              <button
                onClick={() => setImgIdx((i) => (i - 1 + images.length) % images.length)}
                className="absolute left-3 top-1/2 -translate-y-1/2 glass p-2 rounded-xl text-white"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={() => setImgIdx((i) => (i + 1) % images.length)}
                className="absolute right-3 top-1/2 -translate-y-1/2 glass p-2 rounded-xl text-white"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                {images.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setImgIdx(i)}
                    className={cn('w-2 h-2 rounded-full transition-all', i === imgIdx ? 'bg-white w-5' : 'bg-white/50')}
                  />
                ))}
              </div>
            </>
          )}

          {/* Status badges */}
          <div className="absolute top-4 left-4 flex gap-2">
            <span className={item.type === 'lost' ? 'badge-lost' : 'badge-found'}>
              {item.type === 'lost' ? '🔍 Lost' : '✅ Found'}
            </span>
            {item.status !== 'active' && (
              <span className={item.status === 'resolved' ? 'badge-resolved' : 'badge-claimed'}>
                {item.status}
              </span>
            )}
          </div>
        </div>

        {/* Thumbnail strip */}
        {images.length > 1 && (
          <div className="flex gap-2 mb-6">
            {images.map((src, i) => (
              <button
                key={i}
                onClick={() => setImgIdx(i)}
                className={cn('w-16 h-16 rounded-xl overflow-hidden border-2 transition-all', i === imgIdx ? 'border-emerald-500' : 'border-transparent')}
              >
                <img src={src} className="w-full h-full object-cover" alt="" />
              </button>
            ))}
          </div>
        )}

        {/* Title + Meta + Actions */}
        <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-2xl md:text-3xl text-foreground mb-2">{item.title}</h1>
            <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              {category && (
                <span className="flex items-center gap-1.5 bg-secondary/50 px-3 py-1 rounded-lg">
                  <span>{category.icon}</span> {category.label}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-emerald-400" />{location}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />{formatRelativeTime(item.created_at)}
              </span>
              {(item.view_count ?? 0) > 0 && (
                <span className="text-xs">{item.view_count} views</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <button
              onClick={handleShare}
              className="p-2.5 rounded-xl glass border border-border text-muted-foreground hover:text-foreground transition-all"
              title="Copy link"
            >
              <Share2 className="w-4 h-4" />
            </button>

            {!isOwner && item.status === 'active' && (
              <>
                <button
                  onClick={() => setShowClaimBox(!showClaimBox)}
                  className="px-4 py-2.5 rounded-xl bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 text-sm font-semibold hover:bg-yellow-500/25 transition-all"
                >
                  Claim Item
                </button>
                <button
                  onClick={handleStartChat}
                  className="btn-emerald flex items-center gap-2 text-sm py-2.5"
                >
                  <MessageCircle className="w-4 h-4" /> Chat
                </button>
              </>
            )}

            {isOwner && (
              <>
                {item.status === 'active' && (
                  <button
                    onClick={() => resolve()}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 text-sm font-semibold flex items-center gap-2 hover:bg-emerald-500/25 transition-all"
                  >
                    <CheckCircle className="w-4 h-4" /> Mark Resolved
                  </button>
                )}
                <button
                  onClick={() => { if (confirm('Delete this item?')) deleteItem(); }}
                  className="p-2.5 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Claim box */}
        <AnimatePresence>
          {showClaimBox && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="glass rounded-2xl p-4 border border-yellow-500/20 mb-6 overflow-hidden"
            >
              <h4 className="font-semibold text-foreground mb-2">Claim this item</h4>
              <textarea
                value={claimMsg}
                onChange={(e) => setClaimMsg(e.target.value)}
                placeholder="Describe why this is yours (serial number, photos, distinctive features)..."
                className="input-base resize-none mb-3"
                rows={2}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => claim()}
                  disabled={claiming || !claimMsg.trim()}
                  className="btn-emerald text-sm py-2 disabled:opacity-60"
                >
                  {claiming ? 'Submitting...' : 'Submit Claim'}
                </button>
                <button
                  onClick={() => setShowClaimBox(false)}
                  className="text-sm px-4 py-2 rounded-xl border border-border text-muted-foreground hover:text-foreground transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Description */}
        {item.description && (
          <div className="glass rounded-2xl p-5 border border-white/5 mb-6">
            <h3 className="font-semibold text-foreground mb-2">Description</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{item.description}</p>
          </div>
        )}

        {/* Details grid */}
        {(item.color || item.brand || tags.length > 0) && (
          <div className="glass rounded-2xl p-5 border border-white/5 mb-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
            {item.color && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Color</div>
                <div className="text-sm font-medium text-foreground capitalize">{item.color}</div>
              </div>
            )}
            {item.brand && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Brand</div>
                <div className="text-sm font-medium text-foreground">{item.brand}</div>
              </div>
            )}
            {tags.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <Tag className="w-3 h-3" /> Tags
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <span key={t} className="text-xs px-2.5 py-1 bg-secondary rounded-lg text-muted-foreground border border-border">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* AI Analysis */}
        {item.ai_analysis && (
          <details className="glass rounded-2xl border border-emerald-500/10 mb-6 overflow-hidden group">
            <summary className="p-5 flex items-center gap-2 cursor-pointer list-none">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold text-foreground text-sm">AI Analysis</span>
              <span className="ml-auto text-xs text-muted-foreground group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div className="px-5 pb-5 border-t border-border/30 pt-4 space-y-2">
              <p className="text-sm text-muted-foreground">
                {item.ai_analysis.gemini_summary || item.ai_analysis.suggested_description || ''}
              </p>
              {Array.isArray(item.ai_analysis.features) && item.ai_analysis.features.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {item.ai_analysis.features.map((f: string) => (
                    <span key={f} className="text-xs px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}

        {/* AI Matches — backend embeds as item.matches */}
        {embeddedMatches.length > 0 && (
          <div className="mb-6">
            <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
              <GitMerge className="w-4 h-4 text-emerald-400" />
              AI Matches ({embeddedMatches.length})
            </h3>
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
              {embeddedMatches.map((match: unknown) => {
                const m = match as Record<string, unknown>;
                const matchedItem = m.item as Record<string, unknown> | undefined;
                if (!matchedItem) return null;
                const scorePct = (m.score_pct as number) ?? Math.round((m.score as number) * 100);
                const thumb = imgUrl(
                  Array.isArray(matchedItem.images) ? matchedItem.images[0] : matchedItem.thumbnail
                ) || matchedItem.thumbnail as string || '';
                return (
                  <motion.div
                    key={m.match_id as string || matchedItem.id as string}
                    whileHover={{ scale: 1.02 }}
                    className="glass rounded-2xl border border-white/5 overflow-hidden flex-shrink-0 w-48 cursor-pointer"
                    onClick={() => navigate(`/items/${matchedItem.id}`)}
                  >
                    <div className="h-28 overflow-hidden bg-secondary/50">
                      {thumb
                        ? <img src={thumb} className="w-full h-full object-cover" alt="" />
                        : <div className="w-full h-full flex items-center justify-center text-3xl">📦</div>
                      }
                    </div>
                    <div className="p-3">
                      <p className="text-xs font-semibold text-foreground truncate mb-1.5">
                        {matchedItem.title as string}
                      </p>
                      <span className={cn('text-xs font-bold px-2 py-0.5 rounded-lg border', getMatchBg(scorePct), getMatchColor(scorePct))}>
                        <Zap className="w-2.5 h-2.5 inline mr-0.5" />{scorePct}% match
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}

        {/* Owner card */}
        <div className="glass rounded-2xl p-5 border border-white/5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center overflow-hidden flex-shrink-0">
            {poster.avatar_url ? (
              <img src={poster.avatar_url} className="w-full h-full object-cover" alt="" />
            ) : (
              <span className="font-bold text-emerald-400 text-sm">{getInitials(poster.name)}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-foreground text-sm">{poster.name}</p>
            {(poster.department || poster.roll_number) && (
              <p className="text-xs text-muted-foreground truncate">
                {[poster.department, poster.roll_number].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          {!isOwner && (
            <button
              onClick={handleStartChat}
              className="ml-auto btn-emerald flex items-center gap-2 text-sm py-2 flex-shrink-0"
            >
              <MessageCircle className="w-4 h-4" /> Message
            </button>
          )}
        </div>

      </div>

      {/* ── Chat panel ── */}
      <AnimatePresence>
        {showChat && chatRoomId && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="hidden md:flex border-l border-border/30 flex-shrink-0 overflow-hidden"
          >
            <ChatPanel roomId={chatRoomId} onClose={() => setShowChat(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}