// Spotify "now playing": log in with Authorization Code + PKCE (no client secret in the app), then read
// the track you're playing for its title, artist and cover art. Spotify does not hand out audio or audio
// analysis to new apps, so the glass itself is shaped by what the microphone hears.

// The Client ID from https://developer.spotify.com/dashboard. It is public; the Client Secret is never used.
export const SPOTIFY_CLIENT_ID = '';

const SCOPES = 'user-read-currently-playing user-read-playback-state';
const STORE = 'madebysound.spotify.v1';
const PENDING = 'madebysound.spotify.pending';

// Must match a Redirect URI in the Spotify dashboard exactly, e.g. http://127.0.0.1:5173/
export const redirectUri = () => `${location.origin}${location.pathname}`;

export const spotifyAvailable = () => !!SPOTIFY_CLIENT_ID && window.isSecureContext;

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the login just won't survive a reload.
  }
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const isConnected = () => !!read(STORE)?.refresh_token;

export async function connect() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  write(PENDING, { verifier, state });
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.assign(url);
}

export function disconnect() {
  write(STORE, null);
}

async function token(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error(`Spotify sign-in failed (${res.status}).`);
  const data = await res.json();
  const previous = read(STORE) || {};
  const saved = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  write(STORE, saved);
  return saved;
}

// Finishes the login when Spotify sends the browser back with ?code=…; returns true if it did.
export async function completeLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;
  const pending = read(PENDING);
  write(PENDING, null);
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  if (error) throw new Error(error === 'access_denied' ? 'Spotify access was declined.' : `Spotify said: ${error}`);
  if (!pending || params.get('state') !== pending.state) throw new Error('That Spotify sign-in did not start here. Try connecting again.');
  await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
  return true;
}

async function accessToken() {
  const saved = read(STORE);
  if (!saved?.refresh_token) throw new Error('Not connected to Spotify.');
  if (saved.access_token && Date.now() < saved.expires_at) return saved.access_token;
  return (await token({ grant_type: 'refresh_token', refresh_token: saved.refresh_token })).access_token;
}

// The track playing right now, or null when nothing is.
export async function nowPlaying() {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 204) return null;
  if (res.status === 401) {
    disconnect();
    throw new Error('Spotify signed you out. Connect again.');
  }
  if (!res.ok) throw new Error(`Spotify didn't answer (${res.status}).`);
  const data = await res.json();
  const item = data.item;
  if (!item || data.currently_playing_type !== 'track') return null;
  const images = item.album?.images || [];
  const art = images.find((i) => i.width && i.width <= 320) || images[images.length - 1];
  return {
    id: item.id,
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
    album: item.album?.name,
    artUrl: art?.url,
    playing: data.is_playing,
  };
}
