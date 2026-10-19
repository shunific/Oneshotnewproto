/// <reference types="vite/client" />
import { createDisabledCloudClient } from './cloudDisabled.js';

// The installed desktop app is not a trusted place for cloud administration keys.
// Reconnect through an authenticated, deployed gateway before enabling cloud data.
export const supabase = createDisabledCloudClient();
