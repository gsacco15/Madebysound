// Notes you keep, stored in this browser. Only features are stored; the DNA is rebuilt from them.

const KEY = 'madebysound.collection.v1';
const LIMIT = 60;

export function loadCollection() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.features) : [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    // Out of space: drop thumbnails from the oldest half and try once more.
    try {
      const slim = list.map((e, i) => (i > list.length / 2 ? { ...e, thumb: null } : e));
      localStorage.setItem(KEY, JSON.stringify(slim));
      return true;
    } catch {
      return false;
    }
  }
}

export function isKept(id) {
  return loadCollection().some((e) => e.id === id);
}

export function keepNote(entry) {
  const list = [entry, ...loadCollection().filter((e) => e.id !== entry.id)].slice(0, LIMIT);
  return persist(list) ? list : null;
}

export function setFavorite(id, favorite) {
  const list = loadCollection().map((e) => (e.id === id ? { ...e, favorite } : e));
  return persist(list) ? list : null;
}

export function removeNote(id) {
  const list = loadCollection().filter((e) => e.id !== id);
  return persist(list) ? list : null;
}
