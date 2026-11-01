export function resolveMapEmbedUrl(rawUrl: string, fallbackAddress: string = ''): string {
  const cleanInput = (rawUrl || '').trim();
  
  if (cleanInput) {
    // 1. Extract from <iframe src="...">
    const iframeMatch = cleanInput.match(/src=["']([^"']+)["']/i);
    const candidate = iframeMatch ? iframeMatch[1] : cleanInput;

    // 2. If it is already an official Google Maps embed URL
    if (candidate.includes('/maps/embed') || candidate.includes('output=embed')) {
      return candidate;
    }

    // 3. If it contains @lat,lng
    const atCoords = candidate.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atCoords) {
      return `https://maps.google.com/maps?q=${atCoords[1]},${atCoords[2]}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
    }

    // 4. If it has /place/Place+Name
    const placeMatch = candidate.match(/\/place\/([^/@?]+)/);
    if (placeMatch) {
      const decoded = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      return `https://maps.google.com/maps?q=${encodeURIComponent(decoded)}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
    }

    // 5. If it has ?q=query
    const qMatch = candidate.match(/[?&]q=([^&]+)/);
    if (qMatch) {
      const decoded = decodeURIComponent(qMatch[1].replace(/\+/g, ' '));
      return `https://maps.google.com/maps?q=${encodeURIComponent(decoded)}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
    }

    // 6. Generic URLs or queries (e.g. share link maps.app.goo.gl or place name)
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      if (fallbackAddress && fallbackAddress.trim()) {
        return `https://maps.google.com/maps?q=${encodeURIComponent(fallbackAddress.trim())}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
      }
    } else {
      return `https://maps.google.com/maps?q=${encodeURIComponent(candidate)}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
    }
  }

  // Fallback to address
  if (fallbackAddress && fallbackAddress.trim()) {
    return `https://maps.google.com/maps?q=${encodeURIComponent(fallbackAddress.trim())}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
  }

  return 'https://maps.google.com/maps?q=One%20Shot%20Bar%20and%20Billiards%20Cainta&t=&z=16&ie=UTF8&iwloc=&output=embed';
}
