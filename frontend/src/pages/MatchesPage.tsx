// src/pages/MatchesPage.tsx
// FIXED: Now correctly fetches matches from GET /api/items/:id/matches
// instead of relying on item.matches[] which is never embedded in GET /api/items/:id

import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { GitMerge, Zap, Sparkles, MapPin, Clock, ArrowRight, RefreshCw } from 'lucide-react';
import { itemsApi } from '@/lib/api';
import { cn, formatRelativeTime, getMatchBg, getMatchColor } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Skeleton';

// ── helpers ────────────────────────────────────────────────────────────────────
function imgUrl(img: unknown): string {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (typeof img === 'object' && img !== null)
    return (img as Record<string, string>).url || (img as Record<string, string>).thumbnail || '';
  return '';
}

function getVerdict(score: number): { label: string; color: string } {
  if (score >= 85) return { label: '🎯 Very likely yours!',   color: 'text-emerald-400' };
  if (score >= 70) return { label: '✨ Probably yours',       color: 'text-yellow-400'  };
  if (score >= 55) return { label: '🤔 Might be yours',       color: 'text-orange-400'  };
  return            { label: '👀 Possible match',             color: 'text-red-400'     };
}

interface FlatMatch {
  matchId:    string;
  score:      number;
  scorePct:   number;
  myItem:     Record<string, unknown>;
  otherItem:  Record<string, unknown>;
  highlights: Record<string, unknown>;
  createdAt:  string;
}

export default function MatchesPage() {
  // Step 1: Fetch user's own items
  const { data: myItems = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['my-items-for-matches'],
    queryFn: itemsApi.myItems,
  });

  const itemIds: string[] = (myItems as Record<string, unknown>[])
    .map((i) => i.id as string)
    .filter(Boolean);

  // Step 2: For each item, call GET /items/:id/matches — this is where matches actually live
  // FIX: was calling itemsApi.get(id) and reading item.matches[] which is never populated.
  // Now calling itemsApi.getMatches(id) which hits GET /api/items/:id/matches correctly.
  const { data: matchesPerItem = [], isLoading: matchesLoading, refetch } = useQuery({
    queryKey: ['matches-for-my-items', itemIds],
    queryFn: async () => {
      if (!itemIds.length) return [];
      const results = await Promise.allSettled(
        itemIds.map(async (id) => {
          const matches = await itemsApi.getMatches(id);
          // Find the corresponding item to attach as myItem
          const myItem = (myItems as Record<string, unknown>[]).find((i) => i.id === id) ?? { id };
          return { myItem, matches: Array.isArray(matches) ? matches : [] };
        })
      );
      return results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as PromiseFulfilledResult<{ myItem: Record<string, unknown>; matches: Record<string, unknown>[] }>).value);
    },
    enabled: itemIds.length > 0,
    staleTime: 1000 * 60, // 1 minute
  });

  // Flatten all matches from all items
  const allMatches: FlatMatch[] = [];
  for (const { myItem, matches } of matchesPerItem as { myItem: Record<string, unknown>; matches: Record<string, unknown>[] }[]) {
    for (const m of matches) {
      const matchedItem = (m.item as Record<string, unknown>) ?? null;
      if (!matchedItem) continue;
      const scorePct = (m.score_pct as number) ?? Math.round(((m.score as number) ?? 0) * 100);
      allMatches.push({
        matchId:    (m.match_id as string) || (m.item_id as string) || String(Math.random()),
        score:      (m.score as number) ?? 0,
        scorePct,
        myItem,
        otherItem:  matchedItem,
        highlights: (m.highlights as Record<string, unknown>) ?? {},
        createdAt:  (m.created_at as string) ?? '',
      });
    }
  }

  // Sort by score desc
  allMatches.sort((a, b) => b.scorePct - a.scorePct);

  const loading = itemsLoading || matchesLoading;

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl text-foreground flex items-center gap-2">
            <GitMerge className="w-6 h-6 text-emerald-400" /> AI Matches
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Items our AI thinks could be yours — sorted by confidence
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 glass rounded-xl border border-border text-sm text-muted-foreground hover:text-foreground transition-all disabled:opacity-50"
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
        </div>
      ) : allMatches.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center glass rounded-3xl p-12 border border-dashed border-border">
          <div className="text-5xl mb-4">🔍</div>
          <h3 className="font-semibold text-foreground text-xl mb-2">No matches yet</h3>
          <p className="text-muted-foreground text-sm max-w-xs">
            {itemIds.length === 0
              ? 'Post a lost item and our Gemini AI will automatically find matching found items on campus.'
              : 'No matches found for your items yet. The AI is scanning — check back soon or try adding more details to your items.'}
          </p>
          <Link to="/items/new" className="btn-emerald mt-6 text-sm inline-flex items-center gap-2">
            Post an item
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground mb-2">
            <span className="font-semibold text-foreground">{allMatches.length}</span> potential match{allMatches.length !== 1 ? 'es' : ''} found
          </p>

          <AnimatePresence>
            {allMatches.map((match, i) => {
              const verdict    = getVerdict(match.scorePct);
              const myThumb    = imgUrl(Array.isArray(match.myItem.images) ? (match.myItem.images as unknown[])[0] : null);
              const otherThumb = imgUrl(
                Array.isArray(match.otherItem.images)
                  ? (match.otherItem.images as unknown[])[0]
                  : match.otherItem.thumbnail
              );
              const highlights = match.highlights;
              const reasons: string[] = [
                highlights.category_match && 'Same category',
                highlights.color_match    && 'Same color',
                highlights.brand_match    && 'Same brand',
                ...((highlights.tag_matches as string[]) ?? []).map((t) => `#${t}`),
                highlights.gemini_verdict === 'likely_same'   && 'Gemini: visually similar',
                highlights.gemini_verdict === 'possibly_same' && 'Gemini: possibly same item',
              ].filter(Boolean) as string[];

              return (
                <motion.div
                  key={match.matchId + i}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -100 }}
                  transition={{ delay: i * 0.05 }}
                  className="glass rounded-2xl border border-white/5 overflow-hidden hover:border-emerald-500/20 transition-all"
                >
                  {/* Confidence banner */}
                  <div className={cn(
                    'px-5 py-2.5 border-b border-border/20 flex items-center justify-between',
                    match.scorePct >= 85 ? 'bg-emerald-500/8' :
                    match.scorePct >= 70 ? 'bg-yellow-500/8' :
                    'bg-secondary/30'
                  )}>
                    <div className="flex items-center gap-2">
                      <Sparkles className={cn('w-4 h-4', verdict.color)} />
                      <span className={cn('text-sm font-semibold', verdict.color)}>
                        {verdict.label}
                      </span>
                    </div>
                    <div className={cn('flex items-center gap-1.5 px-3 py-1 rounded-xl border text-sm font-bold', getMatchBg(match.scorePct), getMatchColor(match.scorePct))}>
                      <Zap className="w-3.5 h-3.5" />
                      {match.scorePct}% match
                    </div>
                  </div>

                  <div className="p-5 flex items-center gap-4 flex-wrap">
                    {/* My lost item */}
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary/50 flex-shrink-0">
                        {myThumb
                          ? <img src={myThumb} className="w-full h-full object-cover" alt="" />
                          : <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                        }
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] text-muted-foreground mb-0.5">Your item</p>
                        <p className="text-sm font-semibold text-foreground truncate">{match.myItem.title as string}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">🔍 Lost</span>
                      </div>
                    </div>

                    {/* Arrow */}
                    <div className="flex flex-col items-center gap-1 flex-shrink-0 px-2">
                      <ArrowRight className="w-5 h-5 text-emerald-400" />
                      <span className="text-[10px] text-muted-foreground">matched</span>
                    </div>

                    {/* Matched found item */}
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary/50 flex-shrink-0">
                        {otherThumb
                          ? <img src={otherThumb} className="w-full h-full object-cover" alt="" />
                          : <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                        }
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] text-muted-foreground mb-0.5">Potential match</p>
                        <p className="text-sm font-semibold text-foreground truncate">{match.otherItem.title as string}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">✅ Found</span>
                      </div>
                    </div>
                  </div>

                  {/* Match reasons */}
                  {reasons.length > 0 && (
                    <div className="px-5 pb-3 flex flex-wrap gap-1.5">
                      {reasons.map((r, ri) => (
                        <span key={ri} className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                          {r}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Footer */}
                  <div className="px-5 py-3 border-t border-border/20 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {match.otherItem.location_name && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {match.otherItem.location_name as string}
                        </span>
                      )}
                      {match.createdAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(match.createdAt)}
                        </span>
                      )}
                    </div>
                    <Link
                      to={`/items/${match.otherItem.id as string}`}
                      className="btn-emerald text-xs py-2 px-4 flex items-center gap-1.5"
                    >
                      View Item <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}