import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // host: true binds the dev server to the LAN too, so `npm run dev` prints a
  // Network URL you can open on a phone on the same Wi-Fi (for on-device demos).
  server: { host: true },
});
