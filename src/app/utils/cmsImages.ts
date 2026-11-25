import { isWebsiteImageValue } from './supabase';

export const CMS_IMAGE_KEYS = ['heroImages', 'aboutImage'] as const;
export type CmsImageKey = (typeof CMS_IMAGE_KEYS)[number];

export const isCmsImageKey = (key: string): key is CmsImageKey =>
  (CMS_IMAGE_KEYS as readonly string[]).includes(key);

/** Accepts the array form used by the app and the JSON string stored in Supabase. */
export function parseCmsImageList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  return [trimmed];
}

/** True only when every value is a real, website-reachable image URL. */
export function isValidCmsImageValue(key: CmsImageKey, value: unknown): boolean {
  if (key === 'heroImages') {
    const list = parseCmsImageList(value);
    return list.length > 0 && list.every((url) => isWebsiteImageValue(url));
  }
  return typeof value === 'string' && isWebsiteImageValue(value.trim());
}

/**
 * `[]` / `"[]"` (gallery) and `""` (feature photo) are explicit admin clears.
 * Anything else that fails URL validation is a blank or stale value and must
 * never replace a valid older image.
 */
export function isExplicitCmsImageClear(key: CmsImageKey, value: unknown): boolean {
  if (key === 'heroImages') {
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' || trimmed === '[]';
    }
    return false;
  }
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export type CmsRowLike = {
  keyname?: string;
  keyName?: string;
  settingvalue?: unknown;
  settingValue?: unknown;
  dateAdded?: string | null;
  dateadded?: string | null;
  date_added?: string | null;
  updatedat?: string | null;
};

export const cmsRowKey = (row: CmsRowLike | null | undefined): string =>
  String(row?.keyname ?? row?.keyName ?? '').trim();

export const cmsRowValue = (row: CmsRowLike | null | undefined): unknown =>
  row?.settingvalue ?? row?.settingValue ?? null;

export const cmsRowDateAdded = (row: CmsRowLike | null | undefined): string | null =>
  row?.dateAdded ?? row?.dateadded ?? row?.date_added ?? row?.updatedat ?? null;

export type CmsImageDecision =
  | { key: CmsImageKey; action: 'write'; value: string; dateAdded: string }
  | { key: CmsImageKey; action: 'keep'; value: unknown; reason: 'blank-or-invalid' };

/**
 * Decide whether an image update may replace the row that is already stored.
 *
 * - Valid incoming image: write it, keeping the original `dateAdded`.
 * - Explicit clear (`[]`/`""`): write it only when the caller asked to clear.
 * - Blank / retired-host / machine-local value: keep the older row untouched.
 */
export function decideCmsImageWrite(
  key: CmsImageKey,
  incoming: unknown,
  existing: CmsRowLike | null | undefined,
  options: { allowClear?: boolean; now?: Date } = {},
): CmsImageDecision {
  const existingValue = cmsRowValue(existing);
  const existingDate = cmsRowDateAdded(existing);
  const nowIso = (options.now ?? new Date()).toISOString();

  if (isValidCmsImageValue(key, incoming)) {
    return {
      key,
      action: 'write',
      value: key === 'heroImages' ? JSON.stringify(parseCmsImageList(incoming)) : String(incoming).trim(),
      dateAdded: existingDate || nowIso,
    };
  }

  if (options.allowClear && isExplicitCmsImageClear(key, incoming)) {
    return {
      key,
      action: 'write',
      value: key === 'heroImages' ? '[]' : '',
      dateAdded: existingDate || nowIso,
    };
  }

  return { key, action: 'keep', value: existingValue, reason: 'blank-or-invalid' };
}
