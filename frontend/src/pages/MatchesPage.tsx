// src/pages/MatchesPage.tsx
// Matches are embedded inside each item's detail response as item.matches[].
// This page fetches the user's items, collects all matches, and displays them
// with confidence percentages and "this might be yours" messaging.

import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { GitMerge, Zap, Sparkles, MapPin, Clock, ArrowRight } from 'lucide-react';
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
  myItem:     Record<string, unknown>;  // the user's lost item
  otherItem:  Record<string, unknown>;  // the found item that was matched
  highlights: Record<string, unknown>;
  createdAt:  string;
}

export default function MatchesPage() {
  // Fetch all user's items (my_posts=true)
  const { data: myItems = [], isLoading } = useQuery({
    queryKey: ['my-items-for-matches'],
    queryFn: itemsApi.myItems,
  });

  // Fetch full detail for each item to get embedded matches
  const itemIds: string[] = (myItems as Record<string, unknown>[])
    .map((i) => i.id as string)
    .filter(Boolean);

  const { data: itemDetails = [], isLoading: detailsLoading } = useQuery({
    queryKey: ['item-details-for-matches', itemIds],
    queryFn: async () => {
      if (!itemIds.length) return [];
      const results = await Promise.allSettled(
        itemIds.map((id) => itemsApi.get(id))
      );
      return results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as PromiseFulfilledResult<unknown>).value);
    },
    enabled: itemIds.length > 0,
  });

  // Flatten all matches from all items
  const allMatches: FlatMatch[] = [];
  for (const item of itemDetails as Record<string, unknown>[]) {
    const matches = Array.isArray(item.matches) ? item.matches : [];
    for (const m of matches as Record<string, unknown>[]) {
      const matchedItem = m.item as Record<string, unknown>;
      if (!matchedItem) continue;
      const scorePct = (m.score_pct as number) ?? Math.round((m.score as number ?? 0) * 100);
      allMatches.push({
        matchId:    (m.match_id as string) || String(Math.random()),
        score:      m.score as number ?? 0,
        scorePct,
        myItem:     item,
        otherItem:  matchedItem,
        highlights: (m.highlights as Record<string, unknown>) ?? {},
        createdAt:  (m.created_at as string) ?? '',
      });
    }
  }

  // Sort by score desc
  allMatches.sort((a, b) => b.scorePct - a.scorePct);

  const loading = isLoading || detailsLoading;

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-foreground flex items-center gap-2">
          <GitMerge className="w-6 h-6 text-emerald-400" /> AI Matches
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Items our AI thinks could be yours — sorted by confidence
        </p>
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
            Post your lost items and our Gemini AI will automatically find matching found items on campus.
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
              const verdict   = getVerdict(match.scorePct);
              const myThumb   = imgUrl(Array.isArray(match.myItem.images) ? match.myItem.images[0] : null);
              const otherThumb = imgUrl(
                Array.isArray(match.otherItem.images) ? match.otherItem.images[0] : match.otherItem.thumbnail
              );
              const highlights = match.highlights;
              const reasons: string[] = [
                highlights.category_match && 'Same category',
                highlights.color_match    && 'Same color',
                highlights.brand_match    && 'Same brand',
                ...((highlights.tag_matches as string[]) ?? []).map((t) => `#${t}`),
                highlights.gemini_verdict === 'likely_same' && 'Gemini: visually similar',
                highlights.gemini_verdict === 'possibly_same' && 'Gemini: possibly same item',
              ].filter(Boolean) as string[];

              return (
                <motion.div
                  key={match.matchId}
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
                    <Link
                      to={`/items/${match.myItem.id}`}
                      className="flex items-center gap-3 flex-1 min-w-[140px] group"
                    >
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary/50 flex-shrink-0 border border-border">
                        {myThumb
                          ? <img src={myThumb} className="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="" />
                          : <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                        }
                      </div>
                      <div className="min-w-0">
                        <span className="badge-lost text-[10px] mb-1 inline-block">Your lost item</span>
                        <p className="font-semibold text-foreground text-sm truncate">{match.myItem.title as string}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3" />
                          {(match.myItem.location_name || match.myItem.campus_zone) as string ?? '—'}
                        </p>
                      </div>
                    </Link>

                    {/* Arrow */}
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <ArrowRight className="w-5 h-5 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">matches</span>
                    </div>

                    {/* Found item */}
                    <Link
                      to={`/items/${match.otherItem.id}`}
                      className="flex items-center gap-3 flex-1 min-w-[140px] group"
                    >
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary/50 flex-shrink-0 border border-border">
                        {otherThumb
                          ? <img src={otherThumb} className="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="" />
                          : <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                        }
                      </div>
                      <div className="min-w-0">
                        <span className="badge-found text-[10px] mb-1 inline-block">Found item</span>
                        <p className="font-semibold text-foreground text-sm truncate">{match.otherItem.title as string}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3" />
                          {(match.otherItem.location_name || match.otherItem.campus_zone) as string ?? '—'}
                        </p>
                      </div>
                    </Link>

                    {/* View button */}
                    <Link
                      to={`/items/${match.otherItem.id}`}
                      className="flex-shrink-0 btn-emerald text-sm py-2.5 flex items-center gap-2"
                    >
                      View Item <ArrowRight className="w-4 h-4" />
                    </Link>
                  </div>

                  {/* Match reasons */}
                  {reasons.length > 0 && (
                    <div className="px-5 pb-4 border-t border-border/20 pt-3 flex flex-wrap gap-2">
                      <span className="text-xs text-muted-foreground mr-1 self-center">Why:</span>
                      {reasons.map((r, idx) => (
                        <span key={idx} className="text-xs px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                          {r}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Timestamp */}
                  {match.createdAt && (
                    <div className="px-5 pb-3 text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Match found {formatRelativeTime(match.createdAt)}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}