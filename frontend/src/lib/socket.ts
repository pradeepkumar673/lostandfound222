// src/lib/socket.ts
// FIX: Socket was created once with autoConnect:false and never reconnected
// after the user logged in, causing socket_auth_no_token on every page load.
// Now connectSocket() always attaches the latest token and reconnects if needed.

import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

let socket: Socket | null = null;

export const getSocket = (): Socket => {
  if (!socket) {
    const token = localStorage.getItem('clf_token');
    socket = io(SOCKET_URL, {
      auth:       { token: token ?? '' },
      query:      { token: token ?? '' },  // backend also reads from query string
      transports: ['websocket', 'polling'],
      autoConnect: false,
    });
  }
  return socket;
};

/**
 * Connect (or reconnect) the socket with the latest JWT token.
 * Call this after login and whenever the token changes.
 */
export const connectSocket = (): Socket => {
  const token = localStorage.getItem('clf_token');

  if (socket) {
    // Update auth token on existing socket instance
    socket.auth = { token: token ?? '' };
    (socket.io.opts as Record<string, unknown>).query = { token: token ?? '' };

    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  // First connection
  socket = io(SOCKET_URL, {
    auth:       { token: token ?? '' },
    query:      { token: token ?? '' },
    transports: ['websocket', 'polling'],
    autoConnect: true,
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] connect error:', err.message);
  });

  socket.on('auth_error', (data: { message: string }) => {
    console.warn('[socket] auth error:', data.message);
  });

  return socket;
};

export const disconnectSocket = (): void => {
  if (socket?.connected) {
    socket.disconnect();
  }
  socket = null;
};

export type SocketEvents = {
  // Connection
  'connected':       (data: { user_id: string }) => void;
  'auth_error':      (data: { message: string }) => void;
  // Item events
  'item:new':        (item: unknown) => void;
  'item:updated':    (item: unknown) => void;
  // Match events
  'match:found':     (match: unknown) => void;
  'match_found':     (match: unknown) => void;
  // Chat events — backend uses snake_case
  'new_message':     (message: unknown) => void;
  'user_typing':     (data: { user_id: string; is_typing: boolean }) => void;
  // Chat events — camelCase aliases
  'message:new':     (message: unknown) => void;
  'user:typing':     (data: { room_id: string }) => void;
  'user:stop-typing':(data: { room_id: string }) => void;
  // Notification events
  'notification':    (notification: unknown) => void;
  'notification:new':(notification: unknown) => void;
  // Room events
  'room_joined':     (data: { room: string; item_id: string }) => void;
  'room:joined':     (data: { room_id: string }) => void;
};