// src/pages/NewItemPage.tsx
// FIXES:
//  1. Image upload bug: /api/ai/full-analysis expects field 'image' (singular)
//  2. Campus mini-map (SVG, no extra deps) with clickable zones
//  3. navigator.geolocation.watchPosition for live tracking, stored in cookies
//  4. Zone selection auto-fills lat/lng for the submitted item

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import { useMutation } from '@tanstack/react-query';
import {
  Upload, Sparkles, X, ChevronRight, ChevronLeft,
  MapPin, Tag, Check, Loader2, Wand2, AlertCircle,
  Navigation, Navigation2,
} from 'lucide-react';
import { toast } from 'sonner';
import { itemsApi } from '@/lib/api';
import type { AIAnalysis, ItemType } from '@/types';
import { CATEGORIES, CAMPUS_ZONES } from '@/types';
import { cn } from '@/lib/utils';
import { queryClient } from '@/lib/queryClient';

// ── Campus zone → backend location_id + lat/lng ───────────────────────────────
const ZONE_COORDS: Record<string, { id: string; lat: number; lng: number }> = {
  'Main Building':   { id: 'admin',      lat: 12.9715, lng: 77.5935 },
  'Library':         { id: 'lib',        lat: 12.9716, lng: 77.5946 },
  'Cafeteria':       { id: 'canteen',    lat: 12.9710, lng: 77.5940 },
  'Sports Complex':  { id: 'sports',     lat: 12.9700, lng: 77.5930 },
  'Hostel Block A':  { id: 'hostel_a',   lat: 12.9730, lng: 77.5960 },
  'Hostel Block B':  { id: 'hostel_b',   lat: 12.9732, lng: 77.5965 },
  'Labs Wing':       { id: 'lab_block',  lat: 12.9722, lng: 77.5948 },
  'Auditorium':      { id: 'auditorium', lat: 12.9718, lng: 77.5942 },
  'Admin Block':     { id: 'admin',      lat: 12.9715, lng: 77.5935 },
  'Parking Lot':     { id: 'parking',    lat: 12.9705, lng: 77.5925 },
  'Ground':          { id: 'sports',     lat: 12.9700, lng: 77.5930 },
  'Workshop':        { id: 'lab_block',  lat: 12.9722, lng: 77.5948 },
};

// All zones for the SVG map
const MAP_ZONES = [
  { id: 'admin',      name: 'Admin Block',   lat: 12.9715, lng: 77.5935, icon: '🏛️' },
  { id: 'lib',        name: 'Library',       lat: 12.9716, lng: 77.5946, icon: '📚' },
  { id: 'canteen',    name: 'Cafeteria',     lat: 12.9710, lng: 77.5940, icon: '🍽️' },
  { id: 'sports',     name: 'Sports',        lat: 12.9700, lng: 77.5930, icon: '⚽' },
  { id: 'hostel_a',   name: 'Hostel A',      lat: 12.9730, lng: 77.5960, icon: '🏠' },
  { id: 'hostel_b',   name: 'Hostel B',      lat: 12.9732, lng: 77.5965, icon: '🏠' },
  { id: 'lab_block',  name: 'Labs Wing',     lat: 12.9722, lng: 77.5948, icon: '🔬' },
  { id: 'auditorium', name: 'Auditorium',    lat: 12.9718, lng: 77.5942, icon: '🎭' },
  { id: 'parking',    name: 'Parking Lot',   lat: 12.9705, lng: 77.5925, icon: '🅿️' },
];

// Map lat/lng → SVG x/y  (300 × 210 viewport)
const BOUNDS = { minLat: 12.9696, maxLat: 12.9738, minLng: 77.5918, maxLng: 77.5972 };
function toXY(lat: number, lng: number) {
  const x = ((lng - BOUNDS.minLng) / (BOUNDS.maxLng - BOUNDS.minLng)) * 280 + 10;
  const y = ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * 190 + 10;
  return { x, y };
}

// ── Mini SVG campus map ───────────────────────────────────────────────────────
interface CampusMapProps {
  selectedId: string;        // zone id like 'lib'
  onSelect: (zoneName: string, zoneId: string) => void;
  userPos: { lat: number; lng: number } | null;
}
function CampusMap({ selectedId, onSelect, userPos }: CampusMapProps) {
  return (
    <div className="glass rounded-2xl overflow-hidden border border-white/5">
      <div className="px-4 py-2.5 border-b border-border/30 flex items-center gap-2">
        <MapPin className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-semibold text-foreground">Campus Map</span>
        {userPos && (
          <span className="ml-auto flex items-center gap-1 text-xs text-blue-400">
            <Navigation className="w-3 h-3" /> Live
          </span>
        )}
      </div>
      <div className="bg-slate-900/60 p-1">
        <svg viewBox="0 0 300 210" className="w-full" style={{ maxHeight: 210 }}>
          <defs>
            <pattern id="grid" width="15" height="15" patternUnits="userSpaceOnUse">
              <path d="M15 0L0 0 0 15" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="300" height="210" fill="url(#grid)" />
          <rect x="8" y="8" width="284" height="194" rx="6" fill="none"
            stroke="rgba(16,185,129,0.12)" strokeWidth="1" strokeDasharray="5,4" />
          {/* Roads */}
          <line x1="150" y1="10" x2="150" y2="200" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />
          <line x1="10" y1="105" x2="290" y2="105" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />

          {/* Zone markers */}
          {MAP_ZONES.map((z) => {
            const { x, y } = toXY(z.lat, z.lng);
            const sel = z.id === selectedId;
            return (
              <g key={z.id} onClick={() => onSelect(z.name, z.id)} style={{ cursor: 'pointer' }}>
                {sel && (
                  <circle cx={x} cy={y} r="14" fill="rgba(16,185,129,0.12)"
                    stroke="rgba(16,185,129,0.35)" strokeWidth="1.5" />
                )}
                <circle
                  cx={x} cy={y} r={sel ? 7 : 5}
                  fill={sel ? '#10b981' : 'rgba(255,255,255,0.18)'}
                  stroke={sel ? '#6ee7b7' : 'rgba(255,255,255,0.3)'}
                  strokeWidth={sel ? 1.5 : 1}
                />
                <text x={x} y={y + (sel ? 19 : 17)} textAnchor="middle"
                  fontSize={sel ? 8 : 7}
                  fill={sel ? '#34d399' : 'rgba(255,255,255,0.4)'}
                  fontFamily="sans-serif" fontWeight={sel ? '700' : '400'}>
                  {z.name}
                </text>
              </g>
            );
          })}

          {/* Live user dot */}
          {userPos && (() => {
            const { x, y } = toXY(userPos.lat, userPos.lng);
            return (
              <g>
                <circle cx={x} cy={y} r="9" fill="rgba(59,130,246,0.18)"
                  stroke="rgba(59,130,246,0.4)" strokeWidth="1" />
                <circle cx={x} cy={y} r="4.5" fill="#3b82f6" stroke="white" strokeWidth="1.5" />
                <text x={x} y={y + 15} textAnchor="middle" fontSize="6.5"
                  fill="#93c5fd" fontFamily="sans-serif">You</text>
              </g>
            );
          })()}
        </svg>
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border/20">
        Tap a zone on the map or select from the list below
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
const STEPS = ['Upload', 'AI Analysis', 'Details', 'Review'];

export default function NewItemPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [aiResult, setAiResult] = useState<AIAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const watchRef = useRef<number | null>(null);

  const [form, setForm] = useState({
    type: 'lost' as ItemType,
    title: '',
    description: '',
    category: '',
    campus_zone: '',
    location_id: '',
    color: '',
    brand: '',
    tags: [] as string[],
    lat: null as number | null,
    lng: null as number | null,
  });

  // ── Live geolocation + cookie storage ────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) return;
    watchRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        setUserPos({ lat: coords.latitude, lng: coords.longitude });
        const exp = new Date(Date.now() + 3_600_000).toUTCString();
        document.cookie = `clf_lat=${coords.latitude}; path=/; expires=${exp}; SameSite=Lax`;
        document.cookie = `clf_lng=${coords.longitude}; path=/; expires=${exp}; SameSite=Lax`;
      },
      (e) => console.warn('Geo:', e.message),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 12_000 }
    );
    return () => { if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current); };
  }, []);

  // ── Dropzone ──────────────────────────────────────────────────────────────────
  const onDrop = useCallback((accepted: File[]) => {
    const next = [...images, ...accepted].slice(0, 5);
    setImages(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  }, [images]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'image/*': [] }, maxFiles: 5,
  });

  const removeImage = (i: number) => {
    const nf = images.filter((_, idx) => idx !== i);
    setImages(nf);
    setPreviews(nf.map((f) => URL.createObjectURL(f)));
  };

  // ── Gemini AI analysis ────────────────────────────────────────────────────────
  // FIX: /api/ai/full-analysis expects field name 'image' (singular), NOT 'images'
  const handleAnalyze = async () => {
    if (!images.length) { toast.error('Upload at least one image'); return; }
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('image', images[0]); // ← CRITICAL FIX: singular 'image'
      const res = await itemsApi.analyze(fd);

      // Normalise varied response shapes from the pipeline endpoint
      const combined = res.combined || {};
      const gemini   = res.gemini   || {};
      const catObj   = res.category || {};
      const ocrObj   = res.ocr      || {};

      const ai: AIAnalysis = {
        suggested_title:       combined.title       || gemini.suggested_title       || '',
        suggested_description: combined.description || gemini.suggested_description || '',
        category:              combined.category    || gemini.category     || catObj.category || 'other',
        category_confidence:   catObj.confidence    ?? (gemini.confidence === 'high' ? 0.9 : gemini.confidence === 'medium' ? 0.7 : 0.5),
        brand:    combined.brand    || gemini.brand    || '',
        color:    combined.color    || gemini.color    || '',
        features: Array.isArray(combined.features)  ? combined.features
                : typeof combined.features === 'string' && combined.features ? [combined.features]
                : gemini.distinctive_features        || [],
        tags:     Array.isArray(combined.tags) ? combined.tags : (gemini.tags || []),
        ocr_text: ocrObj.raw_text   || gemini.visible_text || '',
        gemini_summary: gemini.suggested_description || combined.description || '',
      };

      setAiResult(ai);
      setForm((f) => ({
        ...f,
        title:       ai.suggested_title       || f.title,
        description: ai.suggested_description || f.description,
        category:    ai.category              || f.category,
        color:       ai.color                 || f.color,
        brand:       ai.brand                 || f.brand,
        tags:        ai.tags.length           ? ai.tags : f.tags,
      }));
      setStep(1);
      toast.success('Gemini AI analysis complete! ✨');
    } catch (err: unknown) {
      toast.error(`AI analysis failed: ${err instanceof Error ? err.message : 'unknown'}. Fill manually.`);
      setStep(2);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────────
  const { mutate: submitItem, isPending } = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      images.forEach((img) => fd.append('images', img)); // plural for create
      fd.append('type',         form.type);
      fd.append('title',        form.title);
      // Backend requires description >= 10 chars (ITEM_DESC_MIN_LEN = 10)
      const rawDesc = form.description.trim();
      const desc = rawDesc.length >= 10 ? rawDesc : `${rawDesc} — no further details provided`.trim();
      fd.append('description', desc);
      fd.append('category',     form.category || 'other');
      fd.append('campus_zone',  form.campus_zone);
      fd.append('location_id',  form.location_id || 'other');
      fd.append('location_name', form.campus_zone);
      if (form.color) fd.append('color', form.color);
      if (form.brand) fd.append('brand', form.brand);
      if (form.tags.length) fd.append('tags', form.tags.join(','));
      if (aiResult) fd.append('ai_analysis', JSON.stringify(aiResult));
      const coord = ZONE_COORDS[form.campus_zone];
      const lat = form.lat ?? coord?.lat ?? userPos?.lat;
      const lng = form.lng ?? coord?.lng ?? userPos?.lng;
      if (lat) fd.append('lat', String(lat));
      if (lng) fd.append('lng', String(lng));
      return itemsApi.create(fd);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['my-items'] });
      toast.success('Item posted! AI matching started 🎯');
      navigate(`/items/${data.item_id || data.id}`);
    },
    onError: (err: unknown) => toast.error(`Failed: ${err instanceof Error ? err.message : 'unknown'}`),
  });

  // ── Zone selection ────────────────────────────────────────────────────────────
  const handleZoneSelect = (zoneName: string, zoneId?: string) => {
    const coord = ZONE_COORDS[zoneName];
    setForm((f) => ({
      ...f,
      campus_zone: zoneName,
      location_id: zoneId || coord?.id || 'other',
      lat: coord?.lat || null,
      lng: coord?.lng || null,
    }));
  };

  // Snap to nearest zone using live GPS
  const snapToNearest = () => {
    if (!userPos) return;
    let best = MAP_ZONES[0]; let minD = Infinity;
    for (const z of MAP_ZONES) {
      const d = Math.hypot(z.lat - userPos.lat, z.lng - userPos.lng);
      if (d < minD) { minD = d; best = z; }
    }
    handleZoneSelect(best.name, best.id);
    toast.success(`📍 Nearest zone: ${best.name}`);
  };

  const addTag = (t: string) => {
    const c = t.trim().toLowerCase();
    if (c && !form.tags.includes(c)) setForm((f) => ({ ...f, tags: [...f.tags, c] }));
    setTagInput('');
  };
  const removeTag = (t: string) => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }));

  const canProceed = [
    images.length > 0,
    true,
    form.title.trim().length > 2 && !!form.category && !!form.campus_zone,
    true,
  ];

  const selectedZoneId = ZONE_COORDS[form.campus_zone]?.id || '';

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-foreground mb-1">Post New Item</h1>
        <p className="text-muted-foreground text-sm">Gemini Vision AI will auto-fill details from your photo</p>
      </div>

      {/* Step bar */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((label, i) => (
          <div key={i} className="flex items-center gap-2 flex-1">
            <div className="flex flex-col items-center gap-1">
              <div className={cn(
                'w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold transition-all',
                i < step ? 'step-completed' : i === step ? 'step-active' : 'step-inactive'
              )}>
                {i < step ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              <span className={cn('text-xs font-medium hidden sm:block', i === step ? 'text-emerald-400' : 'text-muted-foreground')}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn('flex-1 h-0.5 mb-5 transition-all', i < step ? 'bg-emerald-500' : 'bg-border')} />
            )}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.2 }}>

          {/* ── Step 0: Upload ── */}
          {step === 0 && (
            <div className="space-y-6">
              <div
                {...getRootProps()}
                className={cn(
                  'border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all',
                  isDragActive ? 'border-emerald-500 bg-emerald-500/5' : 'border-border hover:border-emerald-500/50'
                )}
              >
                <input {...getInputProps()} />
                <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-emerald-500/20">
                  <Upload className="w-8 h-8 text-emerald-400" />
                </div>
                <h3 className="font-semibold text-foreground text-lg mb-1">Drop images here</h3>
                <p className="text-muted-foreground text-sm">or click to browse — up to 5 images</p>
              </div>

              {previews.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {previews.map((src, i) => (
                    <div key={i} className="relative group aspect-square rounded-xl overflow-hidden bg-secondary/50">
                      <img src={src} className="w-full h-full object-cover" alt="" />
                      <button onClick={() => removeImage(i)}
                        className="absolute top-1 right-1 w-6 h-6 bg-black/70 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                        <X className="w-3 h-3 text-white" />
                      </button>
                      {i === 0 && (
                        <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] text-white font-medium">Main</div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Type selector */}
              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-3 block">What are you posting?</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['lost', 'found'] as ItemType[]).map((t) => (
                    <button key={t} onClick={() => setForm((f) => ({ ...f, type: t }))}
                      className={cn(
                        'py-4 rounded-2xl font-semibold capitalize text-sm transition-all border',
                        form.type === t
                          ? t === 'lost' ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-secondary/50 text-muted-foreground border-border'
                      )}>
                      <span className="text-2xl block mb-1">{t === 'lost' ? '🔍' : '✅'}</span>
                      I {t} something
                    </button>
                  ))}
                </div>
              </div>

              {images.length > 0 && (
                <>
                  <motion.button initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    onClick={handleAnalyze} disabled={analyzing}
                    className="w-full py-4 rounded-2xl font-bold text-white flex items-center justify-center gap-3 disabled:opacity-60"
                    style={{ background: 'linear-gradient(135deg,#10b981,#059669)', boxShadow: analyzing ? 'none' : '0 0 30px rgba(16,185,129,0.4)' }}>
                    {analyzing ? <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing with Gemini...</>
                               : <><Wand2 className="w-5 h-5" /> ✨ Analyze with Gemini AI</>}
                  </motion.button>
                  <button onClick={() => setStep(2)} className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2 transition-colors">
                    Skip AI — fill manually →
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Step 1: AI Results ── */}
          {step === 1 && aiResult && (
            <div className="space-y-4">
              <div className="glass rounded-2xl p-5 border border-emerald-500/20 bg-emerald-500/5">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="w-5 h-5 text-emerald-400" />
                  <h3 className="font-semibold text-emerald-400">Gemini AI Results</h3>
                  <span className="ml-auto text-xs text-muted-foreground bg-secondary px-2 py-1 rounded-lg">
                    {Math.round((aiResult.category_confidence ?? 0.75) * 100)}% confidence
                  </span>
                </div>
                <div className="space-y-3">
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }}
                      animate={{ width: `${(aiResult.category_confidence ?? 0.75) * 100}%` }}
                      transition={{ duration: 0.8 }} className="h-full bg-emerald-500 rounded-full" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-secondary/50 rounded-xl col-span-2">
                      <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Suggested Title</div>
                      <div className="text-sm text-foreground font-medium">{aiResult.suggested_title}</div>
                    </div>
                    <div className="p-3 bg-secondary/50 rounded-xl">
                      <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Category</div>
                      <div className="text-sm text-foreground capitalize">{aiResult.category?.replace('_', ' ')}</div>
                    </div>
                    {aiResult.color && (
                      <div className="p-3 bg-secondary/50 rounded-xl">
                        <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Color</div>
                        <div className="text-sm text-foreground capitalize">{aiResult.color}</div>
                      </div>
                    )}
                    {aiResult.brand && (
                      <div className="p-3 bg-secondary/50 rounded-xl">
                        <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Brand</div>
                        <div className="text-sm text-foreground">{aiResult.brand}</div>
                      </div>
                    )}
                  </div>
                  {aiResult.ocr_text && (
                    <div className="p-3 bg-secondary/50 rounded-xl border border-yellow-500/20">
                      <div className="flex items-center gap-1.5 mb-1">
                        <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />
                        <span className="text-xs font-semibold text-yellow-400">Text detected in image</span>
                      </div>
                      <p className="text-sm font-mono text-foreground">{aiResult.ocr_text}</p>
                    </div>
                  )}
                  {aiResult.tags && aiResult.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {aiResult.tags.map((t) => (
                        <span key={t} className="text-xs px-2.5 py-1 bg-secondary rounded-lg text-muted-foreground border border-border">#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="glass rounded-2xl p-4 border border-border text-sm text-muted-foreground">
                <span className="text-emerald-400 font-semibold">All fields pre-filled</span> — review and edit in the next step.
              </div>
            </div>
          )}

          {/* ── Step 2: Item Details ── */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-1.5 block">Title *</label>
                <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Black Lenovo ThinkPad Laptop" className="input-base" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-1.5 flex items-center justify-between">
                  <span>Description</span>
                  <span className={cn('text-xs', form.description.trim().length < 10 ? 'text-yellow-400' : 'text-muted-foreground')}>
                    {form.description.trim().length}/10 min
                  </span>
                </label>
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3} placeholder="Describe the item — color, brand, condition, any identifiers... (min 10 chars)"
                  className="input-base resize-none" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-2 block">Category *</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {CATEGORIES.map((cat) => (
                    <button key={cat.id} onClick={() => setForm((f) => ({ ...f, category: cat.id }))}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border transition-all',
                        form.category === cat.id ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-secondary/50 text-muted-foreground border-border hover:bg-secondary'
                      )}>
                      <span>{cat.icon}</span> {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Campus location with mini map ── */}
              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-2 flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-emerald-400" /> Campus Zone *
                  {userPos && (
                    <button onClick={snapToNearest}
                      className="ml-auto flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 transition-colors">
                      <Navigation2 className="w-3 h-3" /> Use my location
                    </button>
                  )}
                </label>
                <div className="mb-3">
                  <CampusMap selectedId={selectedZoneId} onSelect={handleZoneSelect} userPos={userPos} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {CAMPUS_ZONES.map((zone) => (
                    <button key={zone} onClick={() => handleZoneSelect(zone)}
                      className={cn(
                        'px-3 py-2 rounded-xl text-xs font-medium border transition-all text-left',
                        form.campus_zone === zone ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-secondary/50 text-muted-foreground border-border hover:bg-secondary'
                      )}>
                      {zone}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-semibold text-foreground/80 mb-1.5 block">Color</label>
                  <input value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                    placeholder="e.g. black, silver" className="input-base" />
                </div>
                <div>
                  <label className="text-sm font-semibold text-foreground/80 mb-1.5 block">Brand</label>
                  <input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                    placeholder="e.g. Apple, Nike" className="input-base" />
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold text-foreground/80 mb-1.5 flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-emerald-400" /> Tags
                </label>
                <div className="flex gap-2 mb-2">
                  <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); } }}
                    placeholder="Add tags (Enter to add)" className="input-base flex-1" />
                  <button onClick={() => addTag(tagInput)}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 text-sm font-semibold hover:bg-emerald-500/25 transition-all">
                    Add
                  </button>
                </div>
                {form.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {form.tags.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-secondary rounded-lg text-muted-foreground border border-border">
                        #{t}
                        <button onClick={() => removeTag(t)} className="hover:text-red-400 transition-colors"><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="glass rounded-2xl overflow-hidden border border-white/5">
                {previews[0] && (
                  <div className="relative h-52 overflow-hidden">
                    <img src={previews[0]} className="w-full h-full object-cover" alt="main" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                    <div className="absolute bottom-4 left-4 flex gap-2">
                      <span className={cn('text-xs font-bold px-2.5 py-1 rounded-lg', form.type === 'lost' ? 'badge-lost' : 'badge-found')}>
                        {form.type === 'lost' ? '🔍 Lost' : '✅ Found'}
                      </span>
                      {form.category && (
                        <span className="text-xs font-medium px-2.5 py-1 rounded-lg bg-black/50 text-white backdrop-blur-sm">
                          {CATEGORIES.find((c) => c.id === form.category)?.icon} {form.category}
                        </span>
                      )}
                    </div>
                    {previews.length > 1 && (
                      <span className="absolute bottom-4 right-4 text-xs text-white/70 bg-black/50 px-2 py-1 rounded-lg backdrop-blur-sm">
                        +{previews.length - 1} more
                      </span>
                    )}
                  </div>
                )}
                <div className="p-5 space-y-3">
                  <h3 className="font-display font-bold text-lg text-foreground">{form.title || 'Untitled'}</h3>
                  {form.description && <p className="text-sm text-muted-foreground leading-relaxed">{form.description}</p>}
                  <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                    {form.campus_zone && <div className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-emerald-400" />{form.campus_zone}</div>}
                    {form.color  && <div>🎨 {form.color}</div>}
                    {form.brand  && <div>🏷️ {form.brand}</div>}
                    {(form.lat || userPos) && <div className="flex items-center gap-1.5 text-xs"><Navigation className="w-3.5 h-3.5 text-blue-400" />GPS saved</div>}
                  </div>
                  {form.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {form.tags.map((t) => <span key={t} className="text-xs px-2 py-0.5 bg-secondary rounded-md text-muted-foreground">#{t}</span>)}
                    </div>
                  )}
                </div>
              </div>
              {aiResult && (
                <div className="glass rounded-2xl p-4 border border-emerald-500/10 bg-emerald-500/3 flex items-center gap-2 text-sm">
                  <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-emerald-400 font-semibold">Gemini-analysed</span>
                  <span className="text-muted-foreground">— visual matching starts automatically after post</span>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex items-center gap-3 mt-8">
        {step > 0 && (
          <button onClick={() => setStep((s) => s - 1)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
        )}
        <div className="flex-1" />
        {step < STEPS.length - 1 ? (
          <button onClick={() => setStep((s) => s + 1)} disabled={!canProceed[step]}
            className="flex items-center gap-2 btn-emerald text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            Next <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={() => submitItem()} disabled={isPending || !form.title.trim() || !form.campus_zone}
            className="flex items-center gap-2 btn-emerald text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Posting...</> : <><Check className="w-4 h-4" /> Post Item</>}
          </button>
        )}
      </div>
    </div>
  );
}