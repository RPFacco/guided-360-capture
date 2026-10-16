export const API_URL = "http://localhost:5000";

const TOKEN_KEY = "guided-360-token";

export class AuthError extends Error {}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {}
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

export function postJson(path, data) {
  return fetch(API_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function api(path, options = {}) {
  const token = getToken();
  if (!token) throw new AuthError();
  const res = await fetch(API_URL + path, {
    ...options,
    headers: { ...options.headers, Authorization: "Bearer " + token },
  });
  if (res.status === 401) {
    clearToken();
    throw new AuthError();
  }
  return res;
}
