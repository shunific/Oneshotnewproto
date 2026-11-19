function googleMapInput(raw: string): URL | undefined {
  const value = (raw.match(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)/i)?.[1] || raw).replace(/&amp;/gi, '&').trim();
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && /^(?:(?:(?:www|maps)\.)?google\.(?:com|com\.ph)|maps\.app\.goo\.gl|goo\.gl)$/.test(url.hostname)) return url;
  } catch { /* A saved address can be plain text. */ }
}

const defaultPlace = 'One Shot Bar and Billiards, Cainta, Rizal';

function mapQuery(url: URL | undefined, address: string, raw: string): string {
  const pin = url?.searchParams.get('pb')?.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
  return url?.searchParams.get('q') || url?.searchParams.get('query') || url?.searchParams.get('center')
    || (pin && pin[1] + ',' + pin[2]) || address.trim()
    || (!/[<>]|^https?:/i.test(raw) && raw.trim()) || defaultPlace;
}

export function resolveMapOpenUrl(raw = '', address = ''): string {
  const url = googleMapInput(raw);
  if (url && !url.pathname.startsWith('/maps/embed') && url.searchParams.get('output') !== 'embed') return url.href;
  const query = mapQuery(url, address, raw);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}

export function resolveMapEmbedUrl(raw = '', address = ''): string {
  const url = googleMapInput(raw);
  if (url && (url.pathname.startsWith('/maps/embed') || url.searchParams.get('output') === 'embed')) return url.href;
  const coords = url?.pathname.match(/@(-?[\d.]+),(-?[\d.]+)/);
  const place = url?.pathname.match(/\/place\/([^/@]+)/)?.[1];
  let label = '';
  if (place) {
    try { label = decodeURIComponent(place.replace(/\+/g, ' ')); } catch { label = ''; }
  }
  const query = label || (coords && coords[1] + ',' + coords[2]) || mapQuery(url, address, raw);
  return 'https://maps.google.com/maps?output=embed&q=' + encodeURIComponent(query);
}
