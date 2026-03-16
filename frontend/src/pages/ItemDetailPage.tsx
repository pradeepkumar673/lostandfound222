// src/pages/ItemDetailPage.tsx
// FIXES:
//   1. Matches: now fetched via GET /api/items/:id/matches (not item.matches[] which is never embedded)
//   2. AI Analysis: shows fallback state with "Run Analysis" button when ai_analysis is null
//   3. AI Analysis: percentage confidence shown for category

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MapPin, Clock, Tag, ChevronLeft, ChevronRight,
  MessageCircle, CheckCircle, Trash2, Zap, Sparkles,
  Share2, GitMerge, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { itemsApi, chatApi } from '@/lib/api';
import { useStore } from '@/store';
import { CATEGORIES } from '@/types';
import { cn, formatRelativeTime, getInitials, getMatchBg, getMatchColor } from '@/lib/utils';
import { queryClient } from '@/lib/queryClient';
import ChatPanel from '@/components/chat/ChatPanel';
import { Skeleton } from '@/components/ui/Skeleton';
import api from '@/lib/api';

// ── helpers ────────────────────────────────────────────────────────────────────
function imgUrl(img: unknown): string {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (typeof img === 'object' && img !== null) {
    return (img as Record<string, string>).url || (img as Record<string, string>).thumbnail || '';
  }
  return '';
}

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
  const [triggeringAnalysis, setTriggeringAnalysis] = useState(false);

  // ── Item detail ──────────────────────────────────────────────────────────────
  const { data: item, isLoading } = useQuery({
    queryKey: ['item', id],
    queryFn: () => itemsApi.get(id!),
    enabled: !!id,
  });

  // ── Matches: FIX — call GET /api/items/:id/matches directly ─────────────────
  // Previously relying on item.matches[] which is NEVER embedded in GET /items/:id
  const { data: fetchedMatches = [], isLoading: matchesLoading, refetch: refetchMatches } = useQuery({
    queryKey: ['item-matches', id],
    queryFn: () => itemsApi.getMatches(id!),
    enabled: !!id,
    staleTime: 1000 * 60,
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

  // ── Trigger AI analysis manually ─────────────────────────────────────────────
  const handleTriggerAnalysis = async () => {
    if (!id) return;
    setTriggeringAnalysis(true);
    try {
      await api.post(`/items/${id}/analyze`);
      toast.success('AI analysis started! Refresh in a moment.');
      // Refetch item after a short delay so ai_analysis is populated
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['item', id] });
      }, 3000);
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Could not start analysis');
    } finally {
      setTriggeringAnalysis(false);
    }
  };

  const handleStartChat = async () => {
    if (!item) return;
    try {
      const poster = getPoster(item as Record<string, unknown>);
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
  const itemData = item as Record<string, unknown>;
  const poster    = getPoster(itemData);
  const isOwner   = poster.id === currentUser?.id || itemData.user_id === currentUser?.id || itemData.is_mine;
  const category  = CATEGORIES.find((c) => c.id === itemData.category);
  const location  = (itemData.location_name || itemData.campus_zone || itemData.location_id || '—') as string;

  const images: string[] = Array.isArray(itemData.images)
    ? (itemData.images as unknown[]).map(imgUrl).filter(Boolean)
    : [];

  // FIX: Use fetchedMatches from the dedicated /matches endpoint instead of item.matches[]
  const matches = Array.isArray(fetchedMatches) ? fetchedMatches as Record<string, unknown>[] : [];

  const tags: string[] = Array.isArray(itemData.tags) ? itemData.tags as string[] : [];

  const aiAnalysis = itemData.ai_analysis as Record<string, unknown> | null | undefined;

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
                alt={itemData.title as string}
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
            <span className={(itemData.type as string) === 'lost' ? 'badge-lost' : 'badge-found'}>
              {(itemData.type as string) === 'lost' ? '🔍 Lost' : '✅ Found'}
            </span>
            {(itemData.status as string) !== 'active' && (
              <span className={(itemData.status as string) === 'resolved' ? 'badge-resolved' : 'badge-claimed'}>
                {itemData.status as string}
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
            <h1 className="font-display font-bold text-2xl md:text-3xl text-foreground mb-2">{itemData.title as string}</h1>
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
                <Clock className="w-4 h-4" />{formatRelativeTime(itemData.created_at as string)}
              </span>
              {((itemData.view_count as number) ?? 0) > 0 && (
                <span className="text-xs">{itemData.view_count as number} views</span>
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

            {!isOwner && (itemData.status as string) === 'active' && (
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
                {(itemData.status as string) === 'active' && (
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
        {itemData.description && (
          <div className="glass rounded-2xl p-5 border border-white/5 mb-6">
            <h3 className="font-semibold text-foreground mb-2">Description</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{itemData.description as string}</p>
          </div>
        )}

        {/* Details grid */}
        {(itemData.color || itemData.brand || tags.length > 0) && (
          <div className="glass rounded-2xl p-5 border border-white/5 mb-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
            {itemData.color && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Color</div>
                <div className="text-sm font-medium text-foreground capitalize">{itemData.color as string}</div>
              </div>
            )}
            {itemData.brand && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Brand</div>
                <div className="text-sm font-medium text-foreground">{itemData.brand as string}</div>
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

        {/* ── AI Analysis (FIX: show even when null, with trigger button) ── */}
        <details className="glass rounded-2xl border border-emerald-500/10 mb-6 overflow-hidden group" open={!!aiAnalysis}>
          <summary className="p-5 flex items-center gap-2 cursor-pointer list-none">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span className="font-semibold text-foreground text-sm">AI Analysis</span>
            <span className="ml-auto text-xs text-muted-foreground group-open:rotate-180 transition-transform">▲</span>
          </summary>
          <div className="px-5 pb-5 border-t border-border/30 pt-4">
            {aiAnalysis ? (
              <div className="space-y-3">
                {/* Gemini summary */}
                {(aiAnalysis.gemini_summary || aiAnalysis.suggested_description) && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {(aiAnalysis.gemini_summary || aiAnalysis.suggested_description) as string}
                  </p>
                )}

                {/* Category confidence */}
                {aiAnalysis.category_confidence !== undefined && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">Category confidence</span>
                    <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${Math.round((aiAnalysis.category_confidence as number) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold text-emerald-400">
                      {Math.round((aiAnalysis.category_confidence as number) * 100)}%
                    </span>
                  </div>
                )}

                {/* Features */}
                {Array.isArray(aiAnalysis.features) && (aiAnalysis.features as string[]).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(aiAnalysis.features as string[]).map((f) => (
                      <span key={f} className="text-xs px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                        {f}
                      </span>
                    ))}
                  </div>
                )}

                {/* Tags from AI */}
                {Array.isArray(aiAnalysis.tags) && (aiAnalysis.tags as string[]).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {(aiAnalysis.tags as string[]).map((t) => (
                      <span key={t} className="text-xs px-2 py-0.5 bg-secondary text-muted-foreground rounded-lg border border-border">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* FIX: Show fallback when no AI analysis yet */
              <div className="flex flex-col items-center gap-3 py-3 text-center">
                <p className="text-sm text-muted-foreground">
                  {images.length === 0
                    ? 'No images uploaded — AI analysis requires at least one image.'
                    : 'AI analysis not yet run for this item.'}
                </p>
                {isOwner && images.length > 0 && (
                  <button
                    onClick={handleTriggerAnalysis}
                    disabled={triggeringAnalysis}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded-xl text-sm font-semibold hover:bg-emerald-500/25 transition-all disabled:opacity-60"
                  >
                    <RefreshCw className={cn('w-4 h-4', triggeringAnalysis && 'animate-spin')} />
                    {triggeringAnalysis ? 'Running analysis...' : 'Run AI Analysis'}
                  </button>
                )}
              </div>
            )}
          </div>
        </details>

        {/* ── AI Matches (FIX: from dedicated /matches endpoint) ── */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <GitMerge className="w-4 h-4 text-emerald-400" />
              AI Matches
              {matchesLoading ? (
                <span className="text-xs text-muted-foreground font-normal">(loading...)</span>
              ) : (
                <span className="text-xs text-muted-foreground font-normal">({matches.length})</span>
              )}
            </h3>
            <button
              onClick={() => refetchMatches()}
              disabled={matchesLoading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all"
            >
              <RefreshCw className={cn('w-3 h-3', matchesLoading && 'animate-spin')} />
              Refresh
            </button>
          </div>

          {matchesLoading ? (
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-48 h-40 bg-secondary/30 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : matches.length === 0 ? (
            <div className="glass rounded-2xl p-5 border border-dashed border-border text-center">
              <p className="text-sm text-muted-foreground">
                No matches found yet.{' '}
                {!(itemData.ai_processed as boolean)
                  ? 'AI is still processing this item.'
                  : 'The AI found no strong matches currently.'}
              </p>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
              {matches.map((m, mi) => {
                const matchedItem = (m.item as Record<string, unknown>) ?? null;
                if (!matchedItem) return null;
                const scorePct = (m.score_pct as number) ?? Math.round(((m.score as number) ?? 0) * 100);
                const thumb = imgUrl(
                  Array.isArray(matchedItem.images) ? (matchedItem.images as unknown[])[0] : matchedItem.thumbnail
                ) || (matchedItem.thumbnail as string) || '';
                return (
                  <motion.div
                    key={(m.match_id as string) || (matchedItem.id as string) || mi}
                    whileHover={{ scale: 1.02 }}
                    className="glass rounded-2xl border border-white/5 overflow-hidden flex-shrink-0 w-48 cursor-pointer hover:border-emerald-500/20 transition-all"
                    onClick={() => navigate(`/items/${matchedItem.id as string}`)}
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
                      <span className={cn('text-xs font-bold px-2 py-0.5 rounded-lg border flex items-center gap-1 w-fit', getMatchBg(scorePct), getMatchColor(scorePct))}>
                        <Zap className="w-2.5 h-2.5" />{scorePct}% match
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

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