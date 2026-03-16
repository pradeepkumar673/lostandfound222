// src/lib/api.ts
import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const api = axios.create({ baseURL: BASE_URL });

// ── Attach JWT ────────────────────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('clf_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

// ── Surface error messages cleanly ────────────────────────────────────────────
api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Request failed';
    return Promise.reject(new Error(msg));
  }
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  register:      (data: object) => api.post('/auth/register', data).then((r) => r.data),
  login:         (data: object) => api.post('/auth/login', data).then((r) => r.data),
  me:            () => api.get('/auth/me').then((r) => r.data),
  logout:        () => api.post('/auth/logout').then((r) => r.data),
  updateProfile: (fd: FormData) => api.patch('/auth/profile', fd).then((r) => r.data),
};

// ─── Items ────────────────────────────────────────────────────────────────────
export const itemsApi = {
  list:   (params?: object) => api.get('/items/', { params }).then((r) => r.data),
  get:    (id: string)      => api.get(`/items/${id}`).then((r) => r.data),
  create: (fd: FormData)    => api.post('/items/', fd).then((r) => r.data),
  update: (id: string, data: object) => api.put(`/items/${id}`, data).then((r) => r.data),
  delete: (id: string)      => api.delete(`/items/${id}`).then((r) => r.data),

  // CORRECT: backend uses PUT /items/:id/status with body {status: "resolved"}
  // NOT PATCH /items/:id/resolve — that route does not exist → was causing CORS/404
  markResolved: (id: string) =>
    api.put(`/items/${id}/status`, { status: 'resolved' }).then((r) => r.data),
  resolve: (id: string) =>
    api.put(`/items/${id}/status`, { status: 'resolved' }).then((r) => r.data),

  uploadImages: (id: string, fd: FormData) =>
    api.post(`/items/${id}/images`, fd).then((r) => r.data),

  // Matches are embedded in item detail response as item.matches[]
  getMatches: (id: string) => api.get(`/items/${id}/matches`).then((r) => r.data?.matches ?? r.data ?? []),
  matches:    (id: string) => api.get(`/items/${id}/matches`).then((r) => r.data?.matches ?? r.data ?? []),

  claim: (id: string, data: object) =>
    api.post(`/items/${id}/claim`, data).then((r) => r.data),

  // Returns plain array — unwrap paginated { items: [], pagination: {} }
  myItems: () =>
    api.get('/items/', { params: { my_posts: true } }).then((r) => r.data?.items ?? r.data ?? []),

  // AI endpoints
  analyze:      (fd: FormData) => api.post('/ai/full-analysis', fd).then((r) => r.data),
  searchByImage:(fd: FormData) => api.post('/ai/search-by-image', fd).then((r) => r.data),
  compareImages:(fd: FormData) => api.post('/ai/compare-images', fd).then((r) => r.data),
};

// ─── Stats / Dashboard ────────────────────────────────────────────────────────
export const statsApi = {
  global:         () => api.get('/dashboard/stats').then((r) => r.data),
  get:            () => api.get('/dashboard/stats').then((r) => r.data),
  heatmap:        () => api.get('/dashboard/heatmap').then((r) => r.data),
  recentActivity: () => api.get('/dashboard/activity').then((r) => r.data),
};

// ─── Chat ─────────────────────────────────────────────────────────────────────
// Backend routes:
//   GET  /api/chat/rooms                    → { rooms: [...] }
//   GET  /api/chat/<item_id>/messages       → { messages: [...] }  (403 if not poster/claimant)
//   POST /api/chat/<item_id>/messages       → send message
// There is NO POST /api/chat/rooms
export const chatApi = {
  // Unwrap { rooms: [...] } → plain array
  rooms: () => api.get('/chat/rooms').then((r) => {
    const d = r.data;
    return Array.isArray(d) ? d : (d?.rooms ?? []);
  }),

  // Returns a room-like object keyed by item_id
  room: (itemId: string) => api.get(`/chat/${itemId}/messages`).then((r) => ({
    id:          itemId,
    item_title:  r.data?.item_title ?? '',
    participants: [],
    messages:    r.data?.messages ?? [],
  })),

  // Returns { items: [...] } shape that ChatPanel expects
  messages: (itemId: string) => api.get(`/chat/${itemId}/messages`).then((r) => ({
    items: r.data?.messages ?? [],
    count: r.data?.count ?? 0,
  })),

  // Send message to item chat
  // Backend expects: { content: string, type?: string }
  // Backend expects { text: '...' } NOT { content: '...' }
  sendMessage: (itemId: string, data: object) =>
    api.post(`/chat/${itemId}/messages`, data).then((r) => r.data),

  // No POST /chat/rooms in backend — use item_id as the room id directly
  createRoom: (data: object) => {
    const d = data as Record<string, string>;
    const itemId = d.item_id ?? d.itemId ?? '';
    return Promise.resolve({ id: itemId, room_id: itemId });
  },
};

// ─── Notifications ────────────────────────────────────────────────────────────
export const notificationsApi = {
  list:        () => api.get('/notifications/').then((r) => r.data),
  markRead:    (id: string) => api.put(`/notifications/${id}`).then((r) => r.data),
  markAllRead: () => api.put('/notifications/read-all').then((r) => r.data),
  delete:      (id: string) => api.delete(`/notifications/${id}`).then((r) => r.data),
};

// ─── Matches ──────────────────────────────────────────────────────────────────
// Backend has NO standalone /api/matches/ route.
// Matches live inside GET /api/items/:id as item.matches[].
// These stubs prevent crashes in MatchesPage/DashboardPage.
export const matchesApi = {
  list:    () => Promise.resolve([]),
  confirm: (_id: string) => Promise.resolve({}),
  reject:  (_id: string) => Promise.resolve({}),
};

export default api;